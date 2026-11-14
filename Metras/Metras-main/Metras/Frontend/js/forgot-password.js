import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getAuth, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";

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

const auth = getAuth(initializeApp(firebaseConfig));
const form = document.getElementById('resetForm');
const button = document.getElementById('resetBtn');
const errorBox = document.getElementById('resetError');
const successBox = document.getElementById('resetSuccess');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  successBox.hidden = true;
  button.disabled = true;
  button.textContent = 'Sending...';

  const email = document.getElementById('resetEmail').value.trim().toLowerCase();
  try {
    await sendPasswordResetEmail(auth, email);
    // Do not disclose whether a particular address has an account.
    successBox.textContent = 'If an account exists for this email, a password reset link will be sent. Check your inbox and spam folder.';
    successBox.hidden = false;
  } catch (error) {
    if (error.code === 'auth/user-not-found') {
      successBox.textContent = 'If an account exists for this email, a password reset link will be sent. Check your inbox and spam folder.';
      successBox.hidden = false;
    } else if (error.code === 'auth/invalid-email') {
      errorBox.textContent = 'Please enter a valid email address.';
      errorBox.hidden = false;
    } else if (error.code === 'auth/too-many-requests') {
      errorBox.textContent = 'Too many requests. Please try again later.';
      errorBox.hidden = false;
    } else {
      console.error('Password reset failed:', error);
      errorBox.textContent = 'Could not send the reset email. Please try again later.';
      errorBox.hidden = false;
    }
  } finally {
    button.disabled = false;
    button.textContent = 'Send Reset Link';
  }
});
