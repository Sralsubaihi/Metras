// settings.js - Settings page (settings.html).
// Loads the signed-in user's profile from Firestore, shows name / email / role,
// points the Tasks link to the right page for the role, and saves name changes.

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import { getFirestore, collection, query, where, getDocs, doc, updateDoc } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
import { requireRole, setupLogout } from "./session.js";

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

// Initialise Firebase and get the Auth and Firestore services.
const app  = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db   = getFirestore(app);

// Every logout link signs out and clears cached session data.
setupLogout();

// Firestore id of the signed-in user's document.
let currentDocId = null;

// ----------------------------------------------------------------------------
// Page setup: drawer, logout and save button
// ----------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  initDrawer();

  document.getElementById("btnSaveSettings")?.addEventListener("click", saveSettings);
});

// ----------------------------------------------------------------------------
// Auth guard: load the signed-in user's profile
// ----------------------------------------------------------------------------
requireRole(auth, db, ["admin", "leader", "team_member"]).then(async ({ user }) => {

  await loadUserInfo(user.email.toLowerCase());
});

// Find the user's document by email and fill the form.
async function loadUserInfo(email) {
  try {
    const q    = query(collection(db, "users"), where("email", "==", email));
    const snap = await getDocs(q);

    if (snap.empty) return;

    const userDoc  = snap.docs[0];
    const userData = userDoc.data();
    currentDocId   = userDoc.id;
    setupRoleNavigation(userData.role);

    // Fill in the form fields.
    const fullNameInput = document.getElementById("fullName");
    const emailInput    = document.getElementById("email");
    const roleInput     = document.getElementById("role");

    if (fullNameInput) fullNameInput.value = userData.name    || "";
    if (emailInput)    emailInput.value    = userData.email   || "";
    if (roleInput)     roleInput.value     = formatRole(userData.role);

  } catch (err) {
    console.error("loadUserInfo error:", err);
  }
}

// Leaders link to the Task Board, members to My Tasks.
function setupRoleNavigation(role) {
  const isLeader = role === "leader";
  const href = isLeader ? "leader-tasks.html" : "task-board.html";
  const topLabel = isLeader ? "TASK BOARD" : "MY TASKS";
  const drawerLabel = isLeader ? "Task Board" : "My Tasks";
  const topLink = document.getElementById("settingsTasksLink");
  const drawerLink = document.getElementById("settingsDrawerTasks");
  if (topLink) { topLink.href = href; topLink.textContent = topLabel; }
  if (drawerLink) { drawerLink.href = href; drawerLink.textContent = drawerLabel; }
}

// ----------------------------------------------------------------------------
// Save the display name
// ----------------------------------------------------------------------------
async function saveSettings() {
  if (!currentDocId) {
    showMessage("Could not find your account. Please try again.", "error");
    return;
  }

  const fullName = document.getElementById("fullName")?.value.trim();

  if (!fullName) {
    showMessage("Name cannot be empty.", "error");
    return;
  }

  const btnSave = document.getElementById("btnSaveSettings");
  btnSave.disabled    = true;
  btnSave.textContent = "Saving...";

  try {
    await updateDoc(doc(db, "users", currentDocId), {
      name: fullName
    });

    showMessage("Settings saved successfully!", "success");

  } catch (err) {
    console.error("saveSettings error:", err);
    showMessage("Failed to save settings. Please try again.", "error");
  } finally {
    btnSave.disabled    = false;
    btnSave.textContent = "Save Changes";
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function formatRole(role) {
  switch (role) {
    case "admin":       return "Admin";
    case "leader":      return "Team Leader";
    case "team_member": return "Team Member";
    default: return role || "Unknown";
  }
}

// Show a success/error message under the buttons for 3 seconds.
function showMessage(msg, type) {
  document.getElementById("settingsMsg")?.remove();

  const el = document.createElement("div");
  el.id = "settingsMsg";
  el.className = type === "success" ? "success-message" : "error-message";
  el.textContent = msg;
  el.style.marginTop = "12px";

  document.querySelector(".actions")?.appendChild(el);

  setTimeout(() => el.remove(), 3000);
}

// Open/close the mobile navigation drawer.
function initDrawer() {
  const btnMenu        = document.getElementById("btnMenu");
  const btnCloseDrawer = document.getElementById("btnCloseDrawer");
  const drawer         = document.getElementById("drawer");
  const backdrop       = document.getElementById("backdrop");

  btnMenu?.addEventListener("click",        () => { drawer.classList.add("open");    backdrop.hidden = false; });
  btnCloseDrawer?.addEventListener("click", () => { drawer.classList.remove("open"); backdrop.hidden = true;  });
  backdrop?.addEventListener("click",       () => { drawer.classList.remove("open"); backdrop.hidden = true;  });
}
