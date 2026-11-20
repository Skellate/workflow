import { getFunctions, httpsCallable } from 'firebase/functions';
import { app } from './firebase.js';

export async function reviewAccessRequest(uid, decision) {
  const review = httpsCallable(getFunctions(app), 'reviewAccessRequest');
  const result = await review({ uid, decision });
  return result.data;
}
