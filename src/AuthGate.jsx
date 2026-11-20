import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { createUserWithEmailAndPassword, getIdTokenResult, onAuthStateChanged, sendPasswordResetEmail, signInWithEmailAndPassword, signOut, updateProfile } from 'firebase/auth';
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth, db, isFirebaseConfigured } from './firebase.js';
import './auth.css';
import './auth-registration.css';

const AuthContext = createContext(null);

export function useSession() {
  return useContext(AuthContext);
}

function FirebaseSetup() {
  return <main className="auth-page"><section className="auth-card setup-card"><Brand /><div className="auth-kicker">FIREBASE SETUP</div><h1>Connect your Firebase project</h1><p>Add your Firebase web app settings to <code>.env.local</code>, then restart the development server. The required variable names are listed in <code>.env.example</code>.</p><ol><li>In Firebase Console, open <strong>Project settings → General</strong> and register a web app.</li><li>Copy the web app configuration values into <code>.env.local</code>.</li><li>Enable <strong>Authentication → Email/Password</strong>, create a Firestore database and enable Storage.</li><li>Grant the first administrator with <code>node scripts/set-member-claim.mjs UID grant-admin</code>.</li><li>Deploy the Firestore/Storage rules and Cloud Function to enable admin approvals.</li></ol><p className="auth-note">Do not put a Firebase service-account key in this app. Only the Firebase web configuration belongs in the local environment file.</p></section></main>;
}

function Brand() {
  return <div className="auth-brand"><span className="brand-mark"><span /></span><span className="brand-name">workflow<span className="brand-dot">.</span><small>PROJECT WORKSPACE</small></span></div>;
}

function SignIn({ onSignIn, onRegister, accessError }) {
  const [mode, setMode] = useState('signin');
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submitSignIn(event) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await onSignIn(email.trim(), password);
    } catch (signInError) {
      setError(signInError.code === 'auth/invalid-credential'
        ? 'Email or password is incorrect.'
        : signInError.code === 'auth/too-many-requests'
          ? 'Too many attempts. Please wait a moment and try again.'
          : signInError.message);
    } finally {
      setBusy(false);
    }
  }

  async function submitRegistration(event) {
    event.preventDefault();
    setError('');
    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters.');
      return;
    }
    setBusy(true);
    try {
      await onRegister(displayName.trim(), email.trim(), password);
    } catch (registrationError) {
      setError(registrationError.code === 'auth/email-already-in-use'
        ? 'An account with this email already exists. Try signing in instead.'
        : registrationError.code === 'auth/weak-password'
          ? 'Choose a stronger password with at least 6 characters.'
          : registrationError.message);
    } finally {
      setBusy(false);
    }
  }

  const registering = mode === 'register';
  return <main className="auth-page"><section className="auth-card"><Brand /><div className="auth-kicker">TEAM WORKSPACE</div><h1>{registering ? 'Create your account' : 'Welcome back'}</h1><p>{registering ? 'Register to request access to the project workspace.' : 'Sign in to continue to your project workspace.'}</p><form onSubmit={registering ? submitRegistration : submitSignIn}>{registering && <label>Full name<input autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required /></label>}<label>Email address<input type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label>Password<input type="password" autoComplete={registering ? 'new-password' : 'current-password'} value={password} onChange={(event) => setPassword(event.target.value)} minLength={registering ? 6 : undefined} required /></label>{registering && <label>Confirm password<input type="password" autoComplete="new-password" value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} minLength={6} required /></label>}{(error || accessError) && <div className="auth-error" role="alert">{error || accessError}</div>}<button className="button button-primary auth-submit" disabled={busy}>{busy ? (registering ? 'Creating account…' : 'Signing in…') : (registering ? 'Create account' : 'Sign in')}</button></form><button className="auth-mode-toggle" onClick={() => { setMode(registering ? 'signin' : 'register'); setError(''); }}>{registering ? 'Already have an account? Sign in' : 'New to Workflow? Create an account'}</button>{registering && <p className="auth-footnote">New accounts must be approved by a workspace administrator before they can view projects or files.</p>}</section></main>;
}

export default function FirebaseGate({ children }) {
  const [user, setUser] = useState(null);
  const [registeredName, setRegisteredName] = useState('');
  const [registeredNameError, setRegisteredNameError] = useState('');
  const [pendingUser, setPendingUser] = useState(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [accessError, setAccessError] = useState('');
  const registeringRef = useRef(false);

  async function loadRegisteredName(authUser) {
    setRegisteredNameError('');
    try {
      const request = await getDoc(doc(db, 'accessRequests', authUser.uid));
      const name = request.exists() && typeof request.data().displayName === 'string'
        ? request.data().displayName.trim()
        : '';
      if (auth.currentUser?.uid === authUser.uid) {
        setRegisteredName(name || authUser.displayName?.trim() || '');
      }
    } catch (error) {
      if (auth.currentUser?.uid === authUser.uid) {
        setRegisteredName(authUser.displayName?.trim() || '');
        setRegisteredNameError(`Could not load your registered name: ${error.message}`);
      }
    }
  }

  useEffect(() => {
    if (!auth) {
      setLoading(false);
      return undefined;
    }
    return onAuthStateChanged(auth, async (nextUser) => {
      setLoading(true);
      if (!nextUser) {
        setUser(null);
        setRegisteredName('');
        setRegisteredNameError('');
        setPendingUser(null);
        setIsAdmin(false);
        setLoading(false);
        return;
      }
      if (registeringRef.current) {
        setLoading(false);
        return;
      }
      setAccessError('');
      try {
        const token = await getIdTokenResult(nextUser);
        if (token.claims.workspaceMember !== true) {
          setUser(null);
          setRegisteredName('');
          setRegisteredNameError('');
          setPendingUser(nextUser);
          setIsAdmin(false);
          return;
        }
        setPendingUser(null);
        setUser(nextUser);
        setIsAdmin(token.claims.workspaceAdmin === true);
        await loadRegisteredName(nextUser);
      } catch (error) {
        let signOutError;
        try {
          await signOut(auth);
        } catch (failure) {
          signOutError = failure;
        }
        setUser(null);
        setRegisteredName('');
        setIsAdmin(false);
        setAccessError(signOutError
          ? `Could not verify workspace access: ${error.message} Could not sign out: ${signOutError.message}`
          : `Could not verify workspace access: ${error.message}`);
      } finally {
        setLoading(false);
      }
    });
  }, []);

  if (!isFirebaseConfigured) return <FirebaseSetup />;
  if (loading) return <main className="auth-page"><div className="auth-loading">Loading your workspace…</div></main>;

  const session = {
    user,
    registeredName,
    registeredNameError,
    isAdmin,
    signIn: (email, password) => signInWithEmailAndPassword(auth, email, password),
    signOut: () => signOut(auth),
    resetPassword: (email) => sendPasswordResetEmail(auth, email),
    register: async (displayName, email, password) => {
      registeringRef.current = true;
      let createdUser;
      try {
        const credential = await createUserWithEmailAndPassword(auth, email, password);
        createdUser = credential.user;
        await updateProfile(createdUser, { displayName });
        await setDoc(doc(db, 'accessRequests', createdUser.uid), {
          uid: createdUser.uid,
          email: createdUser.email || email,
          displayName,
          status: 'pending',
          createdAt: serverTimestamp(),
        });
        setPendingUser(createdUser);
        return createdUser;
      } catch (error) {
        if (createdUser) {
          try {
            await signOut(auth);
          } catch (signOutError) {
            throw new Error(`${error.message} Account sign-out also failed: ${signOutError.message}`);
          }
        }
        throw error;
      } finally {
        registeringRef.current = false;
      }
    },
    refreshAccess: async () => {
      if (!pendingUser) return false;
      const token = await getIdTokenResult(pendingUser, true);
      if (token.claims.workspaceMember !== true) return false;
      await loadRegisteredName(pendingUser);
      setPendingUser(null);
      setUser(pendingUser);
      setIsAdmin(token.claims.workspaceAdmin === true);
      return true;
    },
  };

  return <AuthContext.Provider value={session}>{user ? children : pendingUser ? <PendingApproval user={pendingUser} onRefresh={session.refreshAccess} onSignOut={session.signOut} /> : <SignIn accessError={accessError} onSignIn={session.signIn} onRegister={session.register} />}</AuthContext.Provider>;
}

function PendingApproval({ user, onRefresh, onSignOut }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  async function refresh() {
    setBusy(true);
    setMessage('');
    try {
      const approved = await onRefresh();
      setMessage(approved ? '' : 'The workspaceMember claim is still missing. After an administrator grants it, check again.');
    } catch (error) {
      setMessage(`Could not check approval status: ${error.message}`);
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-page"><section className="auth-card pending-card"><Brand /><div className="pending-icon">◷</div><div className="auth-kicker">ACCESS REQUEST</div><h1>Waiting for approval</h1><p>Your account{user.displayName ? `, ${user.displayName},` : ''} is registered, but Firebase has not granted workspace access yet.</p><div className="pending-email">{user.email}</div><div className="pending-instructions">An administrator must grant the <code>workspaceMember</code> custom claim. Adding the account in Firebase Authentication or changing the request status alone does not grant access.<span>Run this from the project folder after authenticating the Firebase admin CLI:</span><code>node scripts/set-member-claim.mjs {user.uid} grant</code></div>{message && <div className="auth-error" role="status">{message}</div>}<button className="button button-primary auth-submit" disabled={busy} onClick={refresh}>{busy ? 'Checking…' : 'Check approval status'}</button><button className="auth-mode-toggle" onClick={onSignOut}>Sign out</button></section></main>;
}
