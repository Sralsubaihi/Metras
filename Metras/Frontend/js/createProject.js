// createProject.js - Create Project page (createProject.html), leader only.
// Loads active team members for the picker, lets the leader add/remove members and
// saves the project to Firestore with status "Draft". The new project is cached in
// localStorage and the leader continues to the Risk Assessment page.

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import {
  getFirestore, collection, query, where, getDocs,
  addDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
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

// Members picked so far ({ name, email }) and the signed-in leader's email.
let selectedMembers = [];
let currentUserEmail = null;
let currentUserCompany = "";

// Company names are compared ignoring case and extra spaces ("KSU" = "ksu").
const normalizeCompany = value => String(value || "").trim().toLowerCase();

// ----------------------------------------------------------------------------
// Auth guard: signed-in users only, then load the member list
// ----------------------------------------------------------------------------
requireRole(auth, db, ["leader"]).then(async ({ user, profile }) => {
  currentUserEmail = user.email.toLowerCase();
  currentUserCompany = normalizeCompany(profile.company);
  await loadTeamMembers();
});

// Fill the member dropdown with active users whose role is team_member.
async function loadTeamMembers() {
  const memberSelect = document.getElementById("memberSelect");
  if (!memberSelect) return;

  try {
    const q    = query(collection(db, "users"), where("role", "==", "team_member"), where("isActive", "==", true));
    const snap = await getDocs(q);

    // A leader can only add members from their own company.
    const sameCompany = snap.docs.filter(d => normalizeCompany(d.data().company) === currentUserCompany);

    if (!sameCompany.length) {
      memberSelect.innerHTML = '<option value="">No team members from your company yet</option>';
      return;
    }

    memberSelect.innerHTML = '<option value="">-- Select a team member --</option>';
    sameCompany.forEach(doc => {
      const u = doc.data();
      const option = document.createElement("option");
      option.value = JSON.stringify({ name: u.name, email: u.email });
      option.textContent = `${u.name} (${u.email})`;
      memberSelect.appendChild(option);
    });

  } catch (err) {
    console.error("loadTeamMembers error:", err);
    memberSelect.innerHTML = '<option value="">Error loading members</option>';
  }
}

// ----------------------------------------------------------------------------
// Page setup and form handlers
// ----------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  initDrawer();

  const projectName    = document.getElementById("projectName");
  const projectDesc    = document.getElementById("projectDesc");
  const memberSelect   = document.getElementById("memberSelect");
  const btnAddMember   = document.getElementById("btnAddMember");
  const membersList    = document.getElementById("membersList");
  const btnCreateProject = document.getElementById("btnCreateProject");
  const projectError   = document.getElementById("projectError");

  // Add the selected member.
  btnAddMember?.addEventListener("click", () => {
    const val = memberSelect?.value;
    if (!val) return;

    try {
      const member = JSON.parse(val);

      // Skip a member who is already in the list.
      if (selectedMembers.find(m => m.email === member.email)) {
        memberSelect.value = "";
        return;
      }

      selectedMembers.push(member);
      memberSelect.value = "";
      renderMembers(membersList);
    } catch (_) {}
  });

  // Validate and save the project to Firestore.
  btnCreateProject?.addEventListener("click", async () => {
    const name        = projectName?.value.trim();
    const description = projectDesc?.value.trim();

    if (!name) {
      showError(projectError, "Please enter a project name.");
      return;
    }

    projectError.hidden = true;
    btnCreateProject.disabled = true;
    btnCreateProject.textContent = "Creating...";

    try {
      // Firestore generates the document id (docRef.id). No separate "id" field is stored,
      // because it would override the real id when the document is read back.
      const projectData = {
        name,
        description:  description || "No description provided.",
        members: selectedMembers,

        // Flat email list so Firestore "array-contains" queries work.
        memberEmails: selectedMembers.map(m => m.email),
        leaderEmail:  currentUserEmail,
        status:       "Draft",
        createdAt:    serverTimestamp()
      };

      const docRef = await addDoc(collection(db, "projects"), projectData);

      // Cache the new project (with its real id) so the next pages know which project is active.
      const cachedProject = {
        id: docRef.id,
        ...projectData,
        createdAt: new Date().toLocaleDateString()
      };

      localStorage.setItem("metras_current_project", JSON.stringify(cachedProject));

      window.location.href = "teamleader.html";

    } catch (err) {
      console.error("Create project error:", err);
      showError(projectError, "Failed to create project: " + err.message);
      btnCreateProject.disabled = false;
      btnCreateProject.textContent = "Create Project";
    }
  });

  projectName?.addEventListener("input", () => { projectError.hidden = true; });
});

// ----------------------------------------------------------------------------
// Selected member chips (× removes a member)
// ----------------------------------------------------------------------------
function renderMembers(list) {
  if (!list) return;
  list.innerHTML = "";

  selectedMembers.forEach((member, index) => {
    const chip = document.createElement("span");
    chip.className = "member-chip removable";
    chip.innerHTML = `
      ${escapeHtml(member.name)}
      <button type="button" class="remove-member" data-index="${index}">×</button>
    `;
    list.appendChild(chip);
  });

  document.querySelectorAll(".remove-member").forEach(btn => {
    btn.addEventListener("click", () => {
      selectedMembers.splice(Number(btn.dataset.index), 1);
      renderMembers(list);
    });
  });
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function showError(element, message) {
  if (!element) return;
  element.textContent = message;
  element.hidden = false;
}

// Escape text before inserting it into HTML (prevents XSS).
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
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
