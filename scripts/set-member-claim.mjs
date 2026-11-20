import { applicationDefault, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const [uid, action] = process.argv.slice(2);
const projectId = process.env.GCLOUD_PROJECT
  || process.env.GOOGLE_CLOUD_PROJECT
  || process.env.VITE_FIREBASE_PROJECT_ID;

if (!uid || !['grant', 'grant-admin', 'revoke'].includes(action) || !projectId) {
  console.error('Usage: node scripts/set-member-claim.mjs <firebase-auth-uid> <grant|grant-admin|revoke>');
  console.error('Set GCLOUD_PROJECT (or GOOGLE_CLOUD_PROJECT / VITE_FIREBASE_PROJECT_ID) first.');
  process.exitCode = 1;
} else {
  try {
    initializeApp({ credential: applicationDefault(), projectId });
    const auth = getAuth();
    const account = await auth.getUser(uid);
    const claims = { ...account.customClaims };
    if (action === 'grant') {
      claims.workspaceMember = true;
    } else if (action === 'grant-admin') {
      claims.workspaceMember = true;
      claims.workspaceAdmin = true;
    } else {
      delete claims.workspaceMember;
      delete claims.workspaceAdmin;
    }
    await auth.setCustomUserClaims(uid, claims);
    const message = action === 'grant-admin'
      ? 'Workspace admin access granted to'
      : action === 'grant'
        ? 'Workspace access granted to'
        : 'Workspace access revoked for';
    console.log(`${message} ${account.email || uid}. Ask them to sign in again.`);
  } catch (error) {
    console.error(`Could not update workspace access: ${error.message}`);
    if (error.message.includes('Could not load the default credentials')) {
      console.error('The admin script needs Google Application Default Credentials; Firebase CLI login alone is not enough.');
      console.error('Run `gcloud auth application-default login` with an account that has the Firebase Authentication Admin role.');
      console.error('Alternatively, set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON file stored outside this repository.');
    }
    process.exitCode = 1;
  }
}
