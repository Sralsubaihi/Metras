// leader-tasks.js - Leader "Task Board" landing page (leader-tasks.html).
// Lists the leader's projects (live) with task counters: total, for review, done and
// overdue. A project card opens project-tasks.html.

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

// Latest data and live listener handles.
let projects = [];
let tasks = [];
let unsubscribeProjects = null;
let unsubscribeTasks = null;

// ----------------------------------------------------------------------------
// Page setup
// ----------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  initDrawer();
});

// ----------------------------------------------------------------------------
// Auth guard: start the live listeners
// ----------------------------------------------------------------------------
requireRole(auth, db, ["leader"]).then(({ user }) => {
  const email = user.email.toLowerCase();
  listenToProjects(email);
  listenToTasks(email);
});

// Listen to projects led by this user.
function listenToProjects(email) {
  unsubscribeProjects?.();
  const projectsQuery = query(collection(db, "projects"), where("leaderEmail", "==", email));
  unsubscribeProjects = onSnapshot(projectsQuery, (snapshot) => {
    projects = snapshot.docs.map(projectDoc => ({ ...projectDoc.data(), id: projectDoc.id }));
    renderProjects();
  }, handleLoadError);
}

// Listen to tasks created by this user.
function listenToTasks(email) {
  unsubscribeTasks?.();
  const tasksQuery = query(collection(db, "tasks"), where("createdBy", "==", email));
  unsubscribeTasks = onSnapshot(tasksQuery, (snapshot) => {
    tasks = snapshot.docs.map(taskDoc => ({ ...taskDoc.data(), id: taskDoc.id }));
    renderProjects();
  }, handleLoadError);
}

// Render one card per project with its task counters.
function renderProjects() {
  const grid = document.getElementById("taskProjectsGrid");
  if (!grid) return;
  if (!projects.length) {
    grid.innerHTML = '<div class="empty-state">You do not have any projects yet.</div>';
    return;
  }

  const sortedProjects = [...projects].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
  grid.innerHTML = sortedProjects.map(project => {
    const projectTasks = tasks.filter(task => task.projectId === project.id);
    const doneCount = projectTasks.filter(task => task.status === "Done").length;
    const reviewCount = projectTasks.filter(task => task.status === "For Review").length;
    const overdueCount = projectTasks.filter(task => task.status !== "Done" && isOverdue(task.deadline)).length;
    const memberCount = (project.members || []).length;

    return `
      <article class="leader-project-card" data-project-id="${escapeHtml(project.id)}" tabindex="0" role="link">
        <div class="leader-project-head">
          <div><h2>${escapeHtml(project.name || "Unnamed Project")}</h2><p>${escapeHtml(project.description || "No description provided.")}</p></div>
          <span class="status ${statusClass(project.status)}">${escapeHtml(project.status || "Draft")}</span>
        </div>
        <div class="project-task-stats">
          <div><strong>${projectTasks.length}</strong><span>Total Tasks</span></div>
          <div><strong>${reviewCount}</strong><span>For Review</span></div>
          <div><strong>${doneCount}</strong><span>Done</span></div>
          <div class="${overdueCount ? "stat-danger" : ""}"><strong>${overdueCount}</strong><span>Overdue</span></div>
        </div>
        <div class="leader-project-footer"><span>${memberCount} team member${memberCount === 1 ? "" : "s"}</span><span class="view-project-tasks">View Tasks →</span></div>
      </article>`;
  }).join("");

  // Cards open the project's tasks on click or Enter/Space.
  grid.querySelectorAll("[data-project-id]").forEach(card => {
    const openProject = () => {
      window.location.href = `project-tasks.html?projectId=${encodeURIComponent(card.dataset.projectId)}`;
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
// CSS class for a status, e.g. "In Progress" -> "in-progress".
function statusClass(status) {
  return String(status || "Draft").toLowerCase().replace(/\s+/g, "-");
}

// A deadline is overdue after 23:59:59 on its date.
function isOverdue(deadline) {
  const date = deadline ? new Date(`${deadline}T23:59:59`) : null;
  return date && !Number.isNaN(date.getTime()) ? Date.now() > date.getTime() : false;
}

// Show a load error inside the grid.
function handleLoadError(error) {
  console.error("Failed to load task projects:", error);
  const grid = document.getElementById("taskProjectsGrid");
  if (grid) grid.innerHTML = '<div class="empty-state">Unable to load projects. Please refresh.</div>';
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
