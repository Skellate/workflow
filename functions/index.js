const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { FieldValue, getFirestore } = require('firebase-admin/firestore');
const { HttpsError, onCall } = require('firebase-functions/v2/https');
const { logger } = require('firebase-functions');

initializeApp();

const auth = getAuth();
const db = getFirestore();

exports.reviewAccessRequest = onCall(async (request) => {
  if (!request.auth || request.auth.token.workspaceAdmin !== true) {
    throw new HttpsError('permission-denied', 'Workspace administrator access is required.');
  }

  const { uid, decision } = request.data || {};
  if (typeof uid !== 'string' || uid.length < 1 || uid.length > 128
    || !['approve', 'reject'].includes(decision)) {
    throw new HttpsError('invalid-argument', 'A valid user ID and approve/reject decision are required.');
  }

  const requestRef = db.collection('accessRequests').doc(uid);
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(requestRef);
    if (!snapshot.exists) {
      throw new HttpsError('not-found', 'The access request was not found.');
    }
    if (snapshot.data().status !== 'pending') {
      throw new HttpsError('failed-precondition', 'This access request has already been reviewed.');
    }
    transaction.update(requestRef, {
      status: 'processing',
      reviewedBy: request.auth.uid,
      reviewStartedAt: FieldValue.serverTimestamp(),
    });
  });

  let originalClaims;
  try {
    const account = await auth.getUser(uid);
    originalClaims = account.customClaims || {};
    const updatedClaims = { ...originalClaims };
    if (decision === 'approve') {
      updatedClaims.workspaceMember = true;
    } else {
      delete updatedClaims.workspaceMember;
      delete updatedClaims.workspaceAdmin;
    }
    await auth.setCustomUserClaims(uid, updatedClaims);
    await requestRef.update({
      status: decision === 'approve' ? 'approved' : 'rejected',
      reviewedAt: FieldValue.serverTimestamp(),
    });
    logger.info('Access request reviewed', { uid, decision, reviewer: request.auth.uid });
    return { uid, status: decision === 'approve' ? 'approved' : 'rejected' };
  } catch (error) {
    let rollbackError;
    if (originalClaims) {
      try {
        await auth.setCustomUserClaims(uid, originalClaims);
      } catch (failure) {
        rollbackError = failure;
      }
    }
    try {
      await requestRef.update({
        status: 'pending',
        reviewedBy: FieldValue.delete(),
        reviewStartedAt: FieldValue.delete(),
      });
    } catch (failure) {
      rollbackError = rollbackError
        ? new Error(`${rollbackError.message}; request reset failed: ${failure.message}`)
        : failure;
    }
    if (rollbackError) {
      logger.error('Access request rollback failed', { uid, error: rollbackError.message });
      throw new HttpsError('internal', `Review failed and rollback also failed: ${rollbackError.message}`);
    }
    if (error instanceof HttpsError) throw error;
    logger.error('Access request review failed', { uid, error: error.message });
    throw new HttpsError('internal', `Could not complete the access review: ${error.message}`);
  }
});
