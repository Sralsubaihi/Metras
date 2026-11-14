// signup.js - Account activation page (signup.html).
// Creates a Firebase Auth account and sends an email-verification link.
// After verification, login.js checks the admin-created Firestore record and
// only allows registered, active users into METRAS.

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendEmailVerification,
  signOut
} from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";

// Firebase web configuration (public client settings of the metrasdatabase project).
const firebaseConfig = {
  apiKey: "AIzaSyAQ5GxT46n3RmKFVxj_iYQuO2emOpkLQbQ",
  authDomain: "metrasdatabase.firebaseapp.com",
  databaseURL: "https://metrasdatabase-default-rtdb.firebaseio.com",
  projectId: "metrasdatabase",
  storageBucket: "metrasdatabase.firebasestorage.app",
  messagingSenderId: "800641554410",
  appId: "1:800641554410:web:e511850495b4e2b0210493",
  measurementId: "G-04PLV9QBWK"
};

const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);

const signupForm    = document.getElementById('signupForm');
const signupBtn     = document.getElementById('signupBtn');
const signupError   = document.getElementById('signupError');
const signupSuccess = document.getElementById('signupSuccess');
const signupLoading = document.getElementById('signupLoading');

function showError(msg) {
  signupError.textContent = msg;
  signupError.hidden = false;
  signupSuccess.hidden = true;
}

function showSuccess(msg) {
  signupSuccess.textContent = msg;
  signupSuccess.hidden = false;
  signupError.hidden = true;
}

function setLoading(on) {
  signupLoading.style.display = on ? 'flex' : 'none';
  signupBtn.disabled = on;
}

signupForm.addEventListener('submit', async (e) => {
  e.preventDefault();

  signupError.hidden = true;
  signupSuccess.hidden = true;

  const email    = document.getElementById('email').value.trim().toLowerCase();
  const password = document.getElementById('password').value;
  const confirm  = document.getElementById('confirmPassword').value;

  if (!email || !password || !confirm) {
    showError('Please fill in all fields.');
    return;
  }

  if (password.length < 6) {
    showError('Password must be at least 6 characters.');
    return;
  }

  if (password !== confirm) {
    showError('Passwords do not match.');
    return;
  }

  setLoading(true);

  try {
    // Firestore security rules require a verified email. Create the Auth
    // account, send the verification link, then let login.js verify the
    // admin-created Firestore record after the user verifies and signs in.
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    await sendEmailVerification(credential.user);
    await signOut(auth);

    showSuccess('Account created. Check your email, verify your address, then return to the login page.');
    signupForm.reset();

  } catch (error) {
    console.error('Signup error:', error);

    if (error.code === 'auth/email-already-in-use') {
      // If the first verification email was missed, sign in with the submitted
      // password and resend it. A verified account should use the login page.
      try {
        const existingCredential = await signInWithEmailAndPassword(auth, email, password);

        if (!existingCredential.user.emailVerified) {
          await sendEmailVerification(existingCredential.user);
          await signOut(auth);
          showSuccess('A new verification email was sent. Verify your address, then log in.');
        } else {
          await signOut(auth);
          showError('An account with this email already exists. Please log in instead.');
        }
      } catch (existingAccountError) {
        console.error('Existing account check failed:', existingAccountError);
        showError('An account with this email already exists. Please log in or use the correct password to resend verification.');
      }
    } else if (error.code === 'auth/invalid-email') {
      showError('Please enter a valid email address.');
    } else if (error.code === 'auth/weak-password') {
      showError('Password must be at least 6 characters.');
    } else {
      showError(error.message || 'Failed to create account. Please try again.');
    }
  } finally {
    setLoading(false);
  }
});
