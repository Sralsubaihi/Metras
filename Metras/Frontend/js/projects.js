// projects.js - Projects page (projects.html).
// Shows, in real time, the projects the user leads (leader) or belongs to (team
// member). A project card opens a popup to see details, go to the results, and -
// for the project's leader - edit name/description/members or delete the project.
// Admins are redirected to the admin dashboard.

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import {
  getFirestore, collection, query, where, getDocs, onSnapshot,
  doc, updateDoc, deleteDoc
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

// Signed-in user, role and live listener.
let currentUserEmail = null;
let currentUserRole  = null;
let currentUserCompany = "";

// Company names are compared ignoring case and extra spaces ("KSU" = "ksu").
const normalizeCompany = value => String(value || "").trim().toLowerCase();
let unsubscribeProjects = null;

// Working copy of the member list while the edit popup is open.
let editMembers = [];

// ----------------------------------------------------------------------------
// Page setup: drawer, New Project button and logout
// ----------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  initDrawer();

  document.getElementById("btnCreateProject")?.addEventListener("click", () => {
    window.location.href = "createProject.html";
  });

});

// ----------------------------------------------------------------------------
// Auth guard: leaders and team members only, then load projects
// ----------------------------------------------------------------------------
// (requireRole sends admins to their own dashboard.)
requireRole(auth, db, ["leader", "team_member"]).then(({ user, profile }) => {
  currentUserEmail = user.email.toLowerCase();
  currentUserRole = profile.role;
  currentUserCompany = normalizeCompany(profile.company);

  // Only leaders can create projects.
  if (currentUserRole === "leader") {
    const btn = document.getElementById("btnCreateProject");
    if (btn) btn.style.display = "inline-flex";
  }

  setupTasksLink();
  listenToProjects();
});

// Point the Tasks link to the Task Board (leader) or My Tasks (member).
function setupTasksLink() {
  const taskDestination = currentUserRole === "leader" ? "leader-tasks.html" : "task-board.html";
  const taskLabel        = currentUserRole === "leader" ? "TASK BOARD" : "MY TASKS";

  const navTasks    = document.getElementById("navTasks");
  const drawerTasks = document.getElementById("drawerTasks");

  if (navTasks) {
    navTasks.href = taskDestination;
    navTasks.textContent = taskLabel;
    navTasks.style.display = "inline-block";
  }

  if (drawerTasks) {
    drawerTasks.href = taskDestination;
    drawerTasks.textContent = currentUserRole === "leader" ? "Task Board" : "My Tasks";
    drawerTasks.style.display = "block";
  }
}

// ----------------------------------------------------------------------------
// Project list
// ----------------------------------------------------------------------------
// Listen to projects the user leads, or projects that list their email.
function listenToProjects() {
  const projectsGrid = document.getElementById("projectsGrid");
  if (!projectsGrid) return;

  if (unsubscribeProjects) unsubscribeProjects();

  projectsGrid.innerHTML = '<div class="empty-state">Loading projects...</div>';

  let projectsQuery;

  if (currentUserRole === "leader") {
    projectsQuery = query(collection(db, "projects"), where("leaderEmail", "==", currentUserEmail));
  } else if (currentUserRole === "team_member") {
    projectsQuery = query(collection(db, "projects"), where("memberEmails", "array-contains", currentUserEmail));
  } else {
    projectsGrid.innerHTML = '<div class="empty-state">No projects to show.</div>';
    return;
  }

  unsubscribeProjects = onSnapshot(projectsQuery, (snapshot) => {
    const projects = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    renderProjects(projects, projectsGrid);
  }, (error) => {
    console.error("listenToProjects error:", error);
    projectsGrid.innerHTML = '<div class="empty-state">Error loading projects. Please refresh.</div>';
  });
}

// Render the project cards (or an empty-state message).
function renderProjects(projects, projectsGrid) {
  projectsGrid.innerHTML = "";

  if (projects.length === 0) {
    projectsGrid.innerHTML = `
      <div class="empty-state">
        ${currentUserRole === "leader"
          ? 'No projects yet. Click "+ New Project" to get started.'
          : "You have not been added to any projects yet."}
      </div>`;
    return;
  }

  projects.forEach(project => {
    const card = document.createElement("div");
    card.className = "project-card";

    card.innerHTML = `
      <div class="project-top">
        <div class="project-name">${escapeHtml(project.name)}</div>
        <span class="status ${statusClass(project.status)}">${escapeHtml(project.status || "Draft")}</span>
      </div>
      <div class="project-desc">
        ${escapeHtml(project.description || "No description provided.")}
      </div>
      <div class="project-members">
        <strong>Team Members:</strong>
        ${project.members && project.members.length > 0
          ? project.members.map(m => `<span class="member-chip">${escapeHtml(m.name)}</span>`).join("")
          : '<span class="project-muted">No members added</span>'}
      </div>
      <div class="project-meta">Created: ${escapeHtml(formatDate(project.createdAt))}</div>
    `;

    card.addEventListener("click", () => openProjectPopup(project));
    projectsGrid.appendChild(card);
  });
}

// CSS class for a status, e.g. "In Progress" -> "in-progress".
function statusClass(status) {
  return String(status || "Draft").toLowerCase().replace(/\s+/g, "-");
}

// ----------------------------------------------------------------------------
// Project popup
// ----------------------------------------------------------------------------
// Open the popup for a project.
function openProjectPopup(project) {
  // Remember the selected project so the Risk Assessment, Results and task pages
  // know which project is active.
  localStorage.setItem("metras_current_project", JSON.stringify(project));

  document.getElementById("projectPopup")?.remove();

  const popup = document.createElement("div");
  popup.id = "projectPopup";
  popup.className = "project-popup-backdrop";

  // Add the popup to the page before rendering it: renderPopupView() looks up its
  // buttons by id to attach the click handlers.
  document.body.appendChild(popup);
  renderPopupView(popup, project);

  popup.addEventListener("click", e => { if (e.target === popup) closeProjectPopup(); });
}

// View mode: details plus Close, View Results (leader) and Edit/Delete (owner).
function renderPopupView(popup, project) {
  const showResultsButton = currentUserRole === "leader";
  const showEditDelete    = currentUserRole === "leader" && project.leaderEmail === currentUserEmail;

  popup.innerHTML = `
    <div class="project-popup-card">
      <div class="project-popup-head">
        <h2>${escapeHtml(project.name)}</h2>
        <button class="project-popup-close" id="closeProjectPopup">✕</button>
      </div>
      <div class="project-popup-body">
        <div class="popup-row">
          <span class="popup-label">Description</span>
          <span class="popup-value">${escapeHtml(project.description || "No description provided.")}</span>
        </div>
        <div class="popup-row">
          <span class="popup-label">Team Members</span>
          <span class="popup-value">
            ${project.members && project.members.length > 0
              ? project.members.map(m => escapeHtml(m.name)).join(", ")
              : "No members added"}
          </span>
        </div>
        <div class="popup-row">
          <span class="popup-label">Status</span>
          <span class="popup-value">${escapeHtml(project.status || "Draft")}</span>
        </div>
        <div class="popup-row">
          <span class="popup-label">Created</span>
          <span class="popup-value">${escapeHtml(formatDate(project.createdAt))}</span>
        </div>
      </div>
      <div class="project-popup-actions" style="flex-wrap:wrap;">
        <button class="btn btn-secondary" id="popupCancel" type="button">Close</button>
        ${showEditDelete ? `<button class="btn btn-secondary" id="btnEditProject" type="button">Edit</button>` : ""}
        ${showEditDelete ? `<button class="btn btn-danger" id="btnDeleteProject" type="button" style="background:#c0392b;">Delete</button>` : ""}
        ${showResultsButton ? `<button class="btn btn-primary" id="goToResults" type="button">View Results</button>` : ""}
      </div>
    </div>
  `;

  document.getElementById("closeProjectPopup")?.addEventListener("click", closeProjectPopup);
  document.getElementById("popupCancel")?.addEventListener("click", closeProjectPopup);

  if (showResultsButton) {
    document.getElementById("goToResults")?.addEventListener("click", () => {
      window.location.href = "results.html";
    });
  }

  if (showEditDelete) {
    document.getElementById("btnEditProject")?.addEventListener("click", () => {
      openPopupEdit(popup, project);
    });

    document.getElementById("btnDeleteProject")?.addEventListener("click", () => {
      handleDeleteProject(project);
    });
  }
}

// Edit mode: name, description and member list.
async function openPopupEdit(popup, project) {
  // Start from a copy of the current members.
  editMembers = [...(project.members || [])];

  popup.innerHTML = `
    <div class="project-popup-card">
      <div class="project-popup-head">
        <h2>Edit Project</h2>
        <button class="project-popup-close" id="closeProjectPopup">✕</button>
      </div>
      <div class="project-popup-body">
        <div class="field" style="margin-bottom:14px;">
          <label class="label" for="editProjectName">Project Name</label>
          <input type="text" id="editProjectName" class="input" value="${escapeHtml(project.name)}">
        </div>

        <div class="field" style="margin-bottom:14px;">
          <label class="label" for="editProjectDesc">Description</label>
          <textarea id="editProjectDesc" class="textarea" rows="4">${escapeHtml(project.description || "")}</textarea>
        </div>

        <div class="field">
          <label class="label" for="editMemberSelect">Team Members</label>
          <div class="member-input-row">
            <select class="input" id="editMemberSelect">
              <option value="">Loading members...</option>
            </select>
            <button class="btn btn-secondary" id="btnEditAddMember" type="button">Add</button>
          </div>
          <div class="members-list" id="editMembersList"></div>
          <span class="hint">Click × to remove a member from the project.</span>
        </div>

        <div class="error-message" id="editProjectError" hidden></div>
      </div>
      <div class="project-popup-actions">
        <button class="btn btn-secondary" id="btnCancelEdit" type="button">Cancel</button>
        <button class="btn btn-primary" id="btnSaveEdit" type="button">Save Changes</button>
      </div>
    </div>
  `;

  renderEditMembers();

  document.getElementById("closeProjectPopup")?.addEventListener("click", closeProjectPopup);
  document.getElementById("btnCancelEdit")?.addEventListener("click", () => {
    renderPopupView(popup, project);
  });

  await loadTeamMembersForEdit();

  // Add a member from the dropdown (ignoring duplicates).
  document.getElementById("btnEditAddMember")?.addEventListener("click", () => {
    const select = document.getElementById("editMemberSelect");
    const val = select?.value;
    if (!val) return;

    try {
      const member = JSON.parse(val);
      if (editMembers.find(m => m.email === member.email)) {
        select.value = "";
        return;
      }
      editMembers.push(member);
      select.value = "";
      renderEditMembers();
    } catch (_) {}
  });

  // Save the changes to Firestore.
  document.getElementById("btnSaveEdit")?.addEventListener("click", async () => {
    const nameInput = document.getElementById("editProjectName");
    const descInput = document.getElementById("editProjectDesc");
    const errorEl   = document.getElementById("editProjectError");
    const saveBtn   = document.getElementById("btnSaveEdit");

    const newName = nameInput.value.trim();
    const newDesc = descInput.value.trim();

    if (!newName) {
      errorEl.textContent = "Project name cannot be empty.";
      errorEl.hidden = false;
      return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = "Saving...";

    try {
      await updateDoc(doc(db, "projects", project.id), {
        name: newName,
        description: newDesc || "No description provided.",
        members: editMembers,
        memberEmails: editMembers.map(m => m.email)
      });

      // Update the cached project too, in case the leader goes straight to analysis.
      const updatedProject = {
        ...project,
        name: newName,
        description: newDesc || "No description provided.",
        members: editMembers,
        memberEmails: editMembers.map(m => m.email)
      };
      localStorage.setItem("metras_current_project", JSON.stringify(updatedProject));

      // The live listener refreshes the grid automatically.
      closeProjectPopup();

    } catch (err) {
      console.error("Edit project error:", err);
      errorEl.textContent = "Failed to save changes: " + err.message;
      errorEl.hidden = false;
      saveBtn.disabled = false;
      saveBtn.textContent = "Save Changes";
    }
  });
}

// Fill the edit dropdown with active team members.
async function loadTeamMembersForEdit() {
  const select = document.getElementById("editMemberSelect");
  if (!select) return;

  try {
    const q    = query(collection(db, "users"), where("role", "==", "team_member"), where("isActive", "==", true));
    const snap = await getDocs(q);

    // A leader can only add members from their own company.
    const sameCompany = snap.docs.filter(d => normalizeCompany(d.data().company) === currentUserCompany);

    if (!sameCompany.length) {
      select.innerHTML = '<option value="">No team members from your company yet</option>';
      return;
    }

    select.innerHTML = '<option value="">-- Select a team member --</option>';
    sameCompany.forEach(d => {
      const u = d.data();
      const option = document.createElement("option");
      option.value = JSON.stringify({ name: u.name, email: u.email });
      option.textContent = `${u.name} (${u.email})`;
      select.appendChild(option);
    });

  } catch (err) {
    console.error("loadTeamMembersForEdit error:", err);
    select.innerHTML = '<option value="">Error loading members</option>';
  }
}

// Render the working member list as removable chips.
function renderEditMembers() {
  const list = document.getElementById("editMembersList");
  if (!list) return;

  list.innerHTML = "";

  if (editMembers.length === 0) {
    list.innerHTML = '<span class="project-muted">No members added</span>';
    return;
  }

  editMembers.forEach((member, index) => {
    const chip = document.createElement("span");
    chip.className = "member-chip removable";
    chip.innerHTML = `
      ${escapeHtml(member.name)}
      <button type="button" class="remove-edit-member" data-index="${index}">×</button>
    `;
    list.appendChild(chip);
  });

  list.querySelectorAll(".remove-edit-member").forEach(btn => {
    btn.addEventListener("click", () => {
      editMembers.splice(Number(btn.dataset.index), 1);
      renderEditMembers();
    });
  });
}

// Delete a project after confirmation.
async function handleDeleteProject(project) {
  const confirmed = confirm(
    `Delete "${project.name}"?\n\nThis will permanently remove the project. ` +
    `Tasks already created for it will remain but will no longer be linked to a visible project. ` +
    `This cannot be undone.`
  );

  if (!confirmed) return;

  try {
    await deleteDoc(doc(db, "projects", project.id));

    // Forget the cached project if it was the one deleted.
    const cached = JSON.parse(localStorage.getItem("metras_current_project") || "null");
    if (cached && cached.id === project.id) {
      localStorage.removeItem("metras_current_project");
    }

    closeProjectPopup();

  } catch (err) {
    console.error("Delete project error:", err);
    alert("Failed to delete project: " + err.message);
  }
}

function closeProjectPopup() {
  document.getElementById("projectPopup")?.remove();
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
// Format a Firestore timestamp (or an already formatted string) for display.
function formatDate(ts) {
  if (!ts) return "Unknown";
  if (typeof ts === "string") return ts;
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString();
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
