// member-project-tasks.js - Member's task page for one project
// (member-project-tasks.html?projectId=...). Shows the member's tasks live with
// filters and deadline colours: start a task, continue working (task-work.html),
// make requested changes, or view details read-only.

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { attachInfoTooltip, DEADLINE_LEGEND_HTML } from "./info-tooltip.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import { getFirestore, collection, query, where, onSnapshot, doc, getDoc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
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

// Project id from the URL.
const projectId = new URLSearchParams(window.location.search).get("projectId");

// Page state.
let currentUserEmail = "";
let tasks = [];
let activeFilter = "All";
let unsubscribeTasks = null;
let viewingTaskId = null;

// ----------------------------------------------------------------------------
// Page setup (also links the AI assistant to this project)
// ----------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  initDrawer();
  initFilters();
  initViewModal();
  attachInfoTooltip(document.getElementById("deadlineLegendIcon"), DEADLINE_LEGEND_HTML);
  if (projectId) {
    const chatUrl = `chatbot.html?projectId=${encodeURIComponent(projectId)}`;
    document.getElementById("projectChatLink")?.setAttribute("href", chatUrl);
    document.getElementById("drawerProjectChatLink")?.setAttribute("href", chatUrl);
  }
});

// ----------------------------------------------------------------------------
// Auth guard: load the project
// ----------------------------------------------------------------------------
requireRole(auth, db, ["team_member"]).then(async ({ user }) => {
  currentUserEmail = user.email.toLowerCase();
  if (!projectId) {
    showPageError("No project was selected.");
    return;
  }
  await loadProject();
});

// Load the project and check that the user is a member.
async function loadProject() {
  try {
    const snapshot = await getDoc(doc(db, "projects", projectId));
    if (!snapshot.exists()) {
      showPageError("This project does not exist.");
      return;
    }
    const project = snapshot.data();
    const memberEmails = project.memberEmails || (project.members || []).map(member => member.email);
    if (!memberEmails.map(email => String(email).toLowerCase()).includes(currentUserEmail)) {
      showPageError("You are not a member of this project.");
      return;
    }
    document.getElementById("memberProjectName").textContent = project.name || "Unnamed Project";
    listenToTasks();
  } catch (error) {
    console.error("Failed to load member project:", error);
    showPageError("Unable to load this project. Please refresh.");
  }
}

// Listen to the member's tasks in this project (current + legacy assignment format).
function listenToTasks() {
  unsubscribeTasks?.();
  let assignedTasks = [];
  let legacyTasks = [];

  // Merge both result sets by id and re-render (also refreshes an open details modal).
  const renderMergedTasks = () => {
    const byId = new Map();
    [...legacyTasks, ...assignedTasks]
      .filter(task => task.projectId === projectId)
      .forEach(task => byId.set(task.id, task));
    tasks = [...byId.values()];
    renderTasks();
    if (viewingTaskId) openViewModal(viewingTaskId);
  };

  // A member may only read their own tasks; a query over every task in the project
  // would be rejected as a whole by the Firestore rules.
  const assignedQuery = query(
    collection(db, "tasks"),
    where("assignedEmails", "array-contains", currentUserEmail)
  );
  const legacyQuery = query(
    collection(db, "tasks"),
    where("assignedTo.email", "==", currentUserEmail)
  );

  const unsubscribeAssigned = onSnapshot(assignedQuery, snapshot => {
    assignedTasks = snapshot.docs.map(taskDoc => ({ ...taskDoc.data(), id: taskDoc.id }));
    renderMergedTasks();
  }, error => {
    console.error("Failed to load assigned tasks:", error);
    showTableMessage("Unable to load your assigned tasks. Please refresh.");
  });

  const unsubscribeLegacy = onSnapshot(legacyQuery, snapshot => {
    legacyTasks = snapshot.docs.map(taskDoc => ({ ...taskDoc.data(), id: taskDoc.id }));
    renderMergedTasks();
  }, error => console.warn("Legacy assigned tasks could not be loaded:", error));

  // Stop both listeners together.
  unsubscribeTasks = () => {
    unsubscribeAssigned();
    unsubscribeLegacy();
  };
}

// ----------------------------------------------------------------------------
// Task table
// ----------------------------------------------------------------------------
// Status filter pills.
function initFilters() {
  document.querySelectorAll("[data-filter]").forEach(button => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-filter]").forEach(item => item.classList.remove("pill-active"));
      button.classList.add("pill-active");
      activeFilter = button.dataset.filter;
      renderTasks();
    });
  });
}

// Render the task table sorted by nearest deadline.
function renderTasks() {
  const body = document.getElementById("memberProjectTasksBody");
  let filtered = activeFilter === "All" ? [...tasks] : tasks.filter(task => task.status === activeFilter);
  filtered.sort((a, b) => deadlineTime(a.deadline) - deadlineTime(b.deadline));
  if (!filtered.length) {
    showTableMessage(activeFilter === "All" ? "No tasks are assigned to you in this project." : `No assigned tasks with status “${activeFilter}”.`);
    return;
  }

  body.innerHTML = filtered.map(task => {
    const isMine = isTaskAssignedTo(task, currentUserEmail);
    const deadline = deadlineInfo(task);
    const extension = latestDeadlineExtension(task);
    return `
      <tr class="${isMine ? "my-task-row" : "readonly-task-row"} ${isMine && needsChanges(task) ? "change-requested-row" : ""}">
        <td data-label="Task"><div class="table-task-title">${escapeHtml(task.title || "Untitled Task")}</div><div class="table-task-priority">${escapeHtml(task.priority || "Medium")} priority ${isMine ? '<span class="my-task-label">My task</span>' : '<span class="readonly-label">Read only</span>'}</div>${isMine && needsChanges(task) ? '<div class="task-change-notice">Leader requested changes</div>' : ''}</td>
        <td data-label="Assigned To">${escapeHtml(assignedNames(task))}</td>
        <td data-label="Status"><span class="task-status status-${statusClass(task.status)}">${escapeHtml(task.status || "Assigned")}</span></td>
        <td data-label="Work Update"><div class="work-update-preview">${escapeHtml(workUpdatePreview(task))}</div></td>
        <td data-label="Deadline">
          <span class="deadline-badge ${deadline.className}">${escapeHtml(formatDate(task.deadline))}</span>
          ${extension ? `<div class="deadline-extension-note" title="${escapeAttr(extension.reason || "")}">Extended: ${escapeHtml(extension.reason || "Reason recorded")}</div>` : ""}
        </td>
        <td data-label="Action">${taskAction(task, isMine)}</td>
      </tr>`;
  }).join("");

  // Wire the action buttons.
  body.querySelectorAll("[data-start-id]").forEach(button => button.addEventListener("click", () => startTask(button.dataset.startId)));
  body.querySelectorAll("[data-work-id]").forEach(button => button.addEventListener("click", () => openWorkspace(button.dataset.workId)));
  body.querySelectorAll("[data-view-id]").forEach(button => button.addEventListener("click", () => openViewModal(button.dataset.viewId)));
}

// Action for a task: Start Working, Continue Working / Make Changes, or View.
function taskAction(task, isMine) {
  if (!isMine) return `<button class="btn btn-secondary table-action" data-view-id="${task.id}">View</button>`;
  if (task.status === "Assigned") return `<button class="btn btn-primary table-action" data-start-id="${task.id}">Start Working</button>`;
  if (task.status === "In Progress") return `<button class="btn btn-primary table-action" data-work-id="${task.id}">${needsChanges(task) ? "Make Changes" : "Continue Working"}</button>`;
  return `<button class="btn btn-secondary table-action" data-view-id="${task.id}">View</button>`;
}

// Mark the task In Progress and open the workspace.
async function startTask(taskId) {
  try {
    await updateDoc(doc(db, "tasks", taskId), { status: "In Progress", startedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    openWorkspace(taskId);
  } catch (error) {
    console.error("Failed to start task:", error);
    alert("Failed to start the task. Please try again.");
  }
}

// Open the shared workspace for a task.
function openWorkspace(taskId) {
  window.location.href = `task-work.html?taskId=${encodeURIComponent(taskId)}`;
}

// ----------------------------------------------------------------------------
// Read-only details modal
// ----------------------------------------------------------------------------
function initViewModal() {
  document.getElementById("closeMemberView")?.addEventListener("click", closeViewModal);
  document.getElementById("closeMemberViewFooter")?.addEventListener("click", closeViewModal);
  document.getElementById("memberTaskViewModal")?.addEventListener("click", event => {
    if (event.target.id === "memberTaskViewModal") closeViewModal();
  });
}

function openViewModal(taskId) {
  const task = tasks.find(item => item.id === taskId);
  if (!task) return;
  viewingTaskId = taskId;
  document.getElementById("memberViewTitle").textContent = task.title || "Task Details";
  document.getElementById("memberViewAssignee").textContent = assignedNames(task);
  document.getElementById("memberViewStatus").textContent = task.status || "Assigned";
  document.getElementById("memberViewUpdated").textContent = formatTimestamp(task.updatedAt || task.createdAt);
  document.getElementById("memberViewOriginal").textContent = task.description || "—";
  document.getElementById("memberViewRevised").textContent = task.revisedRequirement || "Not started yet.";
  document.getElementById("memberViewMitigation").textContent = task.mitigationExplanation || task.submission || "Not started yet.";
  const extension = latestDeadlineExtension(task);
  const extensionBox = document.getElementById("memberDeadlineExtensionBox");
  if (extension) {
    document.getElementById("memberDeadlineExtension").textContent = deadlineExtensionSummary(extension);
    extensionBox.hidden = false;
  } else {
    extensionBox.hidden = true;
  }
  document.getElementById("memberTaskViewModal").style.display = "flex";
}

function closeViewModal() {
  viewingTaskId = null;
  document.getElementById("memberTaskViewModal").style.display = "none";
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
// Assignees as a list; older tasks stored a single assignedTo object.
function normalizedAssignees(task) {
  if (Array.isArray(task.assignedTo)) return task.assignedTo;
  if (task.assignedTo?.email) return [task.assignedTo];
  return [];
}

function assignedNames(task) {
  return normalizedAssignees(task).map(m => m.name || m.email).join(", ") || "—";
}

function isTaskAssignedTo(task, email) {
  return normalizedAssignees(task).some(m => String(m.email || "").toLowerCase() === email);
}

// Short preview: leader feedback first, then the draft, then a status message.
function workUpdatePreview(task) {
  if (needsChanges(task)) return `Leader feedback: ${task.leaderFeedback || "Changes are required before approval."}`;
  if (task.revisedRequirement) return task.revisedRequirement;
  if (task.mitigationExplanation || task.submission) return task.mitigationExplanation || task.submission;
  if (task.status === "Assigned") return "Work has not started yet.";
  return "No written update yet.";
}

// True when the leader sent the task back for changes.
function needsChanges(task) {
  return task.status === "In Progress" && (task.changeRequested === true || Boolean(task.leaderFeedback));
}

// Deadline colour by share of time used: <1/3 green, <2/3 orange, else red
// (same rule as the leader's page).
function deadlineInfo(task) {
  if (task.status === "Done") return { className: "deadline-done" };
  const end = parseDeadline(task.deadline);
  if (!end) return { className: "deadline-neutral" };
  const now = new Date();
  if (now.getTime() > end.getTime()) return { className: "deadline-red" };
  // Restart the colour calculation from the latest extension time so a newly
  // extended deadline begins green for both leaders and assigned members.
  const extension = latestDeadlineExtension(task);
  const extensionStart = extension?.newDeadline === task.deadline
    ? timestampToDate(extension.changedAt)
    : null;
  const start = extensionStart || timestampToDate(task.createdAt);
  if (!start) return { className: "deadline-neutral" };
  const total = end.getTime() - start.getTime();
  if (total <= 0) return { className: "deadline-red" };
  const progress = Math.max(0, (now.getTime() - start.getTime()) / total);
  if (progress < 1 / 3) return { className: "deadline-green" };
  if (progress < 2 / 3) return { className: "deadline-orange" };
  return { className: "deadline-red" };
}

function showPageError(message) { document.getElementById("memberProjectName").textContent = message; showTableMessage("Return to My Task Projects and select a project."); }
function showTableMessage(message) { document.getElementById("memberProjectTasksBody").innerHTML = `<tr><td colspan="6" class="table-empty">${escapeHtml(message)}</td></tr>`; }

// Date helpers (deadlines count until 23:59:59).
function timestampToDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
function parseDeadline(value) {
  if (!value) return null;
  const date = new Date(`${value}T23:59:59`);
  return Number.isNaN(date.getTime()) ? null : date;
}
function deadlineTime(value) { return parseDeadline(value)?.getTime() || Number.MAX_SAFE_INTEGER; }
function formatDate(value) { const date = parseDeadline(value); return date ? date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—"; }
function formatTimestamp(value) {
  const date = timestampToDate(value);
  return date ? date.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "No updates yet";
}
function latestDeadlineExtension(task) {
  if (task?.latestDeadlineExtension) return task.latestDeadlineExtension;
  const history = Array.isArray(task?.deadlineExtensionHistory) ? task.deadlineExtensionHistory : [];
  return history.length ? history[history.length - 1] : null;
}
function deadlineExtensionSummary(entry) {
  return `${formatDate(entry.previousDeadline)} → ${formatDate(entry.newDeadline)} · ${entry.reason || "Reason recorded"} · Recorded by ${entry.changedByName || entry.changedByEmail || "Project Leader"} on ${formatTimestamp(entry.changedAt)}`;
}
function statusClass(status) { return { "Assigned": "open", "In Progress": "progress", "For Review": "review", "Done": "pending" }[status] || "open"; }

// Escape text before inserting it into HTML (prevents XSS).
function escapeHtml(text) { const div = document.createElement("div"); div.textContent = text ?? ""; return div.innerHTML; }
function escapeAttr(text) { return String(text ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

// Open/close the mobile navigation drawer.
function initDrawer() {
  const btnMenu = document.getElementById("btnMenu"); const btnCloseDrawer = document.getElementById("btnCloseDrawer"); const drawer = document.getElementById("drawer"); const backdrop = document.getElementById("backdrop");
  btnMenu?.addEventListener("click", () => { drawer.classList.add("open"); backdrop.hidden = false; });
  btnCloseDrawer?.addEventListener("click", () => { drawer.classList.remove("open"); backdrop.hidden = true; });
  backdrop?.addEventListener("click", () => { drawer.classList.remove("open"); backdrop.hidden = true; });
}
