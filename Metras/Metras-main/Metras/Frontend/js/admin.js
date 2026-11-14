// admin.js - Admin dashboard (admin-dashboard.html).
// Only admins may stay on this page. The admin registers users (name, email, role,
// company) in the Firestore 'users' collection, sees the list, enables/disables and
// deletes them. Registered users then activate their account on the signup page.

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  serverTimestamp,
  getDocs,
  query,
  where,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc
} from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
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
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Every logout link signs out and clears cached session data.
setupLogout();

// ----------------------------------------------------------------------------
// Page guard: only active admins may stay on this page; then load the users
// ----------------------------------------------------------------------------
requireRole(auth, db, ["admin"]).then(() => loadUsers());

// ----------------------------------------------------------------------------
// Mobile navigation drawer
// ----------------------------------------------------------------------------
const btnMenu = document.getElementById("btnMenu");
const btnCloseDrawer = document.getElementById("btnCloseDrawer");
const drawer = document.getElementById("drawer");
const backdrop = document.getElementById("backdrop");

if (btnMenu) {
  btnMenu.addEventListener("click", () => {
    drawer.classList.add("open");
    backdrop.hidden = false;
  });
}

if (btnCloseDrawer) {
  btnCloseDrawer.addEventListener("click", () => {
    drawer.classList.remove("open");
    backdrop.hidden = true;
  });
}

if (backdrop) {
  backdrop.addEventListener("click", () => {
    drawer.classList.remove("open");
    backdrop.hidden = true;
  });
}


// ----------------------------------------------------------------------------
// Add a user
// ----------------------------------------------------------------------------
const userName = document.getElementById('userName');
const userEmail = document.getElementById('userEmail');
const userRole = document.getElementById('userRole');
const userCompany = document.getElementById('userCompany');
const btnAddUser = document.getElementById('btnAddUser');
const addUserMessage = document.getElementById('addUserMessage');
const addUserError = document.getElementById('addUserError');

// Validate the form and create the user record in Firestore.
async function addUser() {
  // Clear previous messages.
  addUserMessage.hidden = true;
  addUserError.hidden = true;

  const name = userName?.value.trim();

  // Store emails in lowercase so they match what login.js and signup.js look up.
  const email = userEmail?.value.trim().toLowerCase();
  const role = userRole?.value;
  const company = userCompany?.value.trim();

  if (!name || !email || !role) {
    addUserError.textContent = "Please fill all required fields";
    addUserError.hidden = false;
    return;
  }

  // Basic email format check: something@domain.tld
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    addUserError.textContent = "Please enter a valid email address.";
    addUserError.hidden = false;
    return;
  }

  if (!btnAddUser) return;

  btnAddUser.disabled = true;
  btnAddUser.textContent = "Adding...";

  try {
    // Duplicate check: each email may be registered only once.
    const usersCol = collection(db, 'users');
    const existing = await getDocs(query(usersCol, where("email", "==", email)));
    if (!existing.empty) {
      addUserError.textContent = `A user with the email ${email} is already registered.`;
      addUserError.hidden = false;
      return;
    }

    // Create the Firestore record; the user creates their own password later on the signup page.
    const docRef = await addDoc(usersCol, {
      name: name,
      email: email,
      role: role,
      company: company || "Not specified",
      isActive: true,
      createdAt: serverTimestamp(),
      lastLogin: null
    });

    await writeAccessRecord(docRef.id, email, role, true);

    addUserMessage.textContent = `User ${name} added successfully! They can now activate their account on the Sign Up page.`;
    addUserMessage.hidden = false;

    // Clear the form and refresh the list.
    if (userName) userName.value = "";
    if (userEmail) userEmail.value = "";
    if (userCompany) userCompany.value = "";
    
    loadUsers();

  } catch (err) {
    console.error('Add user error', err);
    addUserError.textContent = err.message || 'Failed to add user';
    addUserError.hidden = false;
  } finally {
    btnAddUser.disabled = false;
    btnAddUser.textContent = "Add User";
  }
}

if (btnAddUser) {
  btnAddUser.addEventListener('click', addUser);
}

// ----------------------------------------------------------------------------
// User list
// ----------------------------------------------------------------------------
const usersTableBody = document.getElementById('usersTableBody');
const userCountSpan = document.getElementById('userCount');

// ----------------------------------------------------------------------------
// Access records: the Firestore security rules decide who is an active leader or
// team member from accessByEmail/<email> (role, isActive, userDocId), so this record
// must always mirror the user's document in 'users'. Only roles leader and
// team_member need one.
// ----------------------------------------------------------------------------
async function writeAccessRecord(userDocId, email, role, isActive) {
  const address = String(email || "").trim().toLowerCase();
  if (!address || !["leader", "team_member"].includes(role)) return;
  await setDoc(doc(db, "accessByEmail", address), { role, isActive: isActive === true, userDocId });
}

// Create or repair missing access records for existing users (runs when the admin opens the dashboard).
async function backfillAccessRecords(users) {
  try {
    const existing = {};
    (await getDocs(collection(db, "accessByEmail"))).forEach(d => { existing[d.id] = d.data(); });
    for (const u of users) {
      const address = String(u.email || "").trim().toLowerCase();
      if (!address || !["leader", "team_member"].includes(u.role)) continue;
      const have = existing[address];
      const wantActive = u.isActive !== false;
      if (!have || have.role !== u.role || have.isActive !== wantActive || have.userDocId !== u.id) {
        await writeAccessRecord(u.id, address, u.role, wantActive);
      }
    }
  } catch (error) {
    console.error("Could not sync access records:", error);
  }
}

// Load all users and render them with Enable/Disable and Delete actions.
async function loadUsers() {
  if (!usersTableBody) return;

  try {
    const querySnapshot = await getDocs(collection(db, 'users'));
    const users = [];
    querySnapshot.forEach(doc => {
      users.push({ id: doc.id, ...doc.data() });
    });

    userCountSpan.textContent = `${users.length} users`;
    backfillAccessRecords(users);
    
    if (users.length === 0) {
      usersTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center;">No users found</td></tr>';
      return;
    }

    usersTableBody.innerHTML = users.map(user => `
      <tr>
        <td>${escapeHtml(user.name || 'N/A')}</td>
        <td>${escapeHtml(user.email)}</td>
        <td><span class="chip chip-${getRoleColor(user.role)}">${formatRole(user.role)}</span></td>
        <td>${escapeHtml(user.company || 'N/A')}</td>
        <td>${user.isActive !== false ? '✅ Active' : '❌ Inactive'}</td>
        <td>
          <button class="link-btn" onclick="toggleUserStatus('${user.id}', ${!user.isActive})">
            ${user.isActive !== false ? "Disable" : "Enable"}
          </button>
          <button class="link-btn" style="color:#ff8a96;" onclick="deleteUser('${user.id}')">Delete</button>
        </td>
      </tr>
    `).join('');
    
  } catch (error) {
    console.error("Load users error:", error);
    usersTableBody.innerHTML = '<tr><td colspan="6" style="text-align:center;">Error loading users</td></tr>';
  }
}

// Escape text before inserting it into HTML (prevents XSS).
function escapeHtml(text) {
  if (!text) return "";
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Chip colour for each role.
function getRoleColor(role) {
  switch(role) {
    case 'admin': return 'primary';
    case 'leader': return 'medium';
    case 'team_member': return 'low';
    default: return 'medium';
  }
}

// Readable role name.
function formatRole(role) {
  switch(role) {
    case 'team_member': return 'Team Member';
    case 'leader': return 'Team Leader';
    default: return role ? role.charAt(0).toUpperCase() + role.slice(1) : 'Unknown';
  }
}

// ----------------------------------------------------------------------------
// Table actions (on window so the inline onclick buttons can call them)
// ----------------------------------------------------------------------------
// Enable or disable a user account.
window.toggleUserStatus = async function(userId, newStatus) {
  try {
    const userRef = doc(db, 'users', userId);
    const userData = (await getDoc(userRef)).data() || {};
    await updateDoc(userRef, { isActive: newStatus });
    await writeAccessRecord(userId, userData.email, userData.role, newStatus);
    loadUsers();
  } catch (error) {
    console.error("Error updating user status:", error);
    alert("Error updating user status");
  }
};

// Permanently delete a user record after confirmation.
window.deleteUser = async function(userId) {
  if (confirm("Are you sure you want to delete this user? This action cannot be undone.")) {
    try {
      const userRef = doc(db, 'users', userId);
      const userData = (await getDoc(userRef)).data() || {};
      await deleteDoc(userRef);
      if (userData.email) await deleteDoc(doc(db, 'accessByEmail', String(userData.email).trim().toLowerCase()));
      loadUsers();
    } catch (error) {
      console.error("Error deleting user:", error);
      alert("Error deleting user: " + error.message);
    }
  }
};

