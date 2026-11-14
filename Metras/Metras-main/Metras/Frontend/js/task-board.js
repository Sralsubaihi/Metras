// task-board.js - Member "My Tasks" landing page (task-board.html).
// Lists the projects the member belongs to (live) and highlights projects where the
// leader requested changes on the member's tasks. A project card opens
// member-project-tasks.html.

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import { getFirestore, collection, query, where, onSnapshot } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
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
const auth = getAuth(app);
const db = getFirestore(app);

// Every logout link signs out and clears cached session data.
setupLogout();

// Live listener handles and the latest data.
let unsubscribeProjects = null;
let unsubscribeTasks = null;
let memberProjects = [];
let memberTasks = [];

// ----------------------------------------------------------------------------
// Page setup
// ----------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  initDrawer();
});

// ----------------------------------------------------------------------------
// Auth guard: start the live listeners
// ----------------------------------------------------------------------------
requireRole(auth, db, ["team_member"]).then(({ user }) => {
  const email = user.email.toLowerCase();
  listenToMemberProjects(email);
  listenToMemberTasks(email);
});

// Listen to projects that list this member's email. Firestore checks every query
// against the security rules, so the query must filter on memberEmails; reading the
// whole collection would be rejected for a member.
function listenToMemberProjects(email) {
  unsubscribeProjects?.();
  const memberProjectsQuery = query(
    collection(db, "projects"),
    where("memberEmails", "array-contains", email)
  );
  unsubscribeProjects = onSnapshot(memberProjectsQuery, snapshot => {
    memberProjects = snapshot.docs.map(projectDoc => ({ ...projectDoc.data(), id: projectDoc.id }));
    renderProjects();
  }, error => {
    console.error("Failed to load member projects:", error);
    showError("Unable to load your projects. Please refresh.");
  });
}

// Listen to the member's tasks. Two queries are merged: the current format
// (assignedEmails array) and the legacy format (single assignedTo.email).
function listenToMemberTasks(email) {
  unsubscribeTasks?.();
  let newTasks = [];
  let legacyTasks = [];
  const renderMerged = () => {
    const byId = new Map();
    [...legacyTasks, ...newTasks].forEach(task => byId.set(task.id, task));
    memberTasks = [...byId.values()];
    renderProjects();
  };
  const newQuery = query(collection(db, "tasks"), where("assignedEmails", "array-contains", email));
  const legacyQuery = query(collection(db, "tasks"), where("assignedTo.email", "==", email));
  const unsubNew = onSnapshot(newQuery, snapshot => {
    newTasks = snapshot.docs.map(taskDoc => ({ ...taskDoc.data(), id: taskDoc.id }));
    renderMerged();
  }, error => console.error("Failed to load shared task alerts:", error));
  const unsubLegacy = onSnapshot(legacyQuery, snapshot => {
    legacyTasks = snapshot.docs.map(taskDoc => ({ ...taskDoc.data(), id: taskDoc.id }));
    renderMerged();
  }, error => console.error("Failed to load legacy task alerts:", error));
  unsubscribeTasks = () => { unsubNew(); unsubLegacy(); };
}

// Render one card per project, with a "Changes requested" alert when needed.
function renderProjects() {
  const grid = document.getElementById("memberTaskProjectsGrid");
  if (!grid) return;
  if (!memberProjects.length) {
    grid.innerHTML = '<div class="empty-state">You have not been added to any projects yet.</div>';
    return;
  }

  memberProjects.sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  grid.innerHTML = memberProjects.map(project => {
    const memberCount = (project.members || []).length;
    const changesCount = memberTasks.filter(task => task.projectId === project.id && needsChanges(task)).length;
    return `
      <article class="leader-project-card ${changesCount ? "has-change-request" : ""}" data-project-id="${escapeHtml(project.id)}" tabindex="0" role="link">
        <div class="leader-project-head">
          <div><h2>${escapeHtml(project.name || "Unnamed Project")}</h2><p>${escapeHtml(project.description || "No description provided.")}</p></div>
          <span class="status ${statusClass(project.status)}">${escapeHtml(project.status || "Draft")}</span>
        </div>
        ${changesCount ? `<div class="change-request-alert"><strong>Changes requested</strong><span>${changesCount} task${changesCount === 1 ? "" : "s"} need your update</span></div>` : ""}
        <div class="member-project-team">
          <strong>Project team</strong>
          <p>${(project.members || []).map(member => escapeHtml(member.name || member.email)).join(", ") || "No members added"}</p>
        </div>
        <div class="leader-project-footer"><span>${memberCount} team member${memberCount === 1 ? "" : "s"}</span><span class="view-project-tasks">View Project Tasks →</span></div>
      </article>`;
  }).join("");

  // Cards open the project's tasks on click or Enter/Space.
  grid.querySelectorAll("[data-project-id]").forEach(card => {
    const openProject = () => {
      window.location.href = `member-project-tasks.html?projectId=${encodeURIComponent(card.dataset.projectId)}`;
    };
    card.addEventListener("click", openProject);
    card.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openProject();
      }
    });
  });
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
// True when the leader sent the task back for changes.
function needsChanges(task) {
  return task.status === "In Progress" && (task.changeRequested === true || Boolean(task.leaderFeedback));
}

// CSS class for a status, e.g. "In Progress" -> "in-progress".
function statusClass(status) {
  return String(status || "Draft").toLowerCase().replace(/\s+/g, "-");
}

function showError(message) {
  const grid = document.getElementById("memberTaskProjectsGrid");
  if (grid) grid.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
}

// Escape text before inserting it into HTML (prevents XSS).
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

// Open/close the mobile navigation drawer.
function initDrawer() {
  const btnMenu = document.getElementById("btnMenu");
  const btnCloseDrawer = document.getElementById("btnCloseDrawer");
  const drawer = document.getElementById("drawer");
  const backdrop = document.getElementById("backdrop");
  btnMenu?.addEventListener("click", () => { drawer.classList.add("open"); backdrop.hidden = false; });
  btnCloseDrawer?.addEventListener("click", () => { drawer.classList.remove("open"); backdrop.hidden = true; });
  backdrop?.addEventListener("click", () => { drawer.classList.remove("open"); backdrop.hidden = true; });
}
