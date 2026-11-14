// task-work.js - Shared task workspace (task-work.html?taskId=...).
// Everyone assigned to a task edits one shared draft (revised requirement + mitigation
// explanation), sees teammates' updates live, reads leader feedback, posts team notes,
// saves progress and submits the work for the leader's review. With several assignees the
// task only goes to the leader once EVERY assignee has submitted (see submittedBy).

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, updateDoc, onSnapshot,
  serverTimestamp, arrayUnion
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
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Every logout link signs out and clears cached session data.
setupLogout();

// Task id from the URL.
const taskId = new URLSearchParams(window.location.search).get("taskId");

// Page state. hasUnsavedEdits protects text being typed from live updates;
// pendingRemoteDraft holds a teammate's newer draft until the user loads it.
let currentTask = null;
let currentUserEmail = "";
let currentUserName = "";
let unsubscribeTask = null;
let hasUnsavedEdits = false;
let pendingRemoteDraft = null;

// ----------------------------------------------------------------------------
// Page setup
// ----------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  initDrawer();
  document.getElementById("saveDraft")?.addEventListener("click", saveDraft);
  document.getElementById("submitReview")?.addEventListener("click", submitForReview);
  document.getElementById("postNote")?.addEventListener("click", postDiscussionNote);
  document.getElementById("loadLatestDraft")?.addEventListener("click", loadPendingRemoteDraft);

  // Mark the draft as being edited once the user types.
  document.getElementById("revisedRequirement")?.addEventListener("input", () => { hasUnsavedEdits = true; });
  document.getElementById("mitigationExplanation")?.addEventListener("input", () => { hasUnsavedEdits = true; });
});

// ----------------------------------------------------------------------------
// Auth guard: load the task
// ----------------------------------------------------------------------------
requireRole(auth, db, ["team_member"]).then(async ({ user, profile }) => {
  if (!taskId) {
    showLoadError("No task was selected.");
    return;
  }
  currentUserEmail = user.email.toLowerCase();
  currentUserName = profile?.name || user.displayName || user.email;
  await loadTask();
});

// Load the task and check that the user is assigned to it.
async function loadTask() {
  try {
    const snapshot = await getDoc(doc(db, "tasks", taskId));
    if (!snapshot.exists()) {
      showLoadError("This task does not exist.");
      return;
    }

    const task = { id: snapshot.id, ...snapshot.data() };
    if (!isTaskAssignedTo(task, currentUserEmail)) {
      showLoadError("You do not have permission to work on this task.");
      return;
    }

    currentTask = task;
    renderTask(task, true);
    listenForLiveUpdates();
  } catch (error) {
    console.error("Failed to load task:", error);
    showLoadError("Unable to load this task. Please try again.");
  }
}

// ----------------------------------------------------------------------------
// Live updates
// ----------------------------------------------------------------------------
// Status, feedback, notes and "last edited by" stay live. A teammate's new draft never
// overwrites text being typed; a banner offers to load it instead.
function listenForLiveUpdates() {
  unsubscribeTask?.();
  unsubscribeTask = onSnapshot(doc(db, "tasks", taskId), (snapshot) => {
    if (!snapshot.exists()) return;
    const task = { id: snapshot.id, ...snapshot.data() };
    const draftChangedRemotely =
      task.revisedRequirement !== currentTask?.revisedRequirement ||
      task.mitigationExplanation !== currentTask?.mitigationExplanation;

    currentTask = task;

    if (draftChangedRemotely && hasUnsavedEdits) {
      // Leave the textareas alone and show the "newer draft" banner.
      pendingRemoteDraft = task;
      document.getElementById("draftUpdateBanner").hidden = false;
      renderTask(task, false);
    } else {
      renderTask(task, !hasUnsavedEdits);
    }
  }, (error) => {
    console.error("Live task updates failed:", error);
  });
}

// Replace the textareas with the teammate's newer draft.
function loadPendingRemoteDraft() {
  if (!pendingRemoteDraft) return;
  document.getElementById("revisedRequirement").value = pendingRemoteDraft.revisedRequirement || "";
  document.getElementById("mitigationExplanation").value = pendingRemoteDraft.mitigationExplanation || "";
  document.getElementById("draftUpdateBanner").hidden = true;
  hasUnsavedEdits = false;
  pendingRemoteDraft = null;
}

// ----------------------------------------------------------------------------
// Rendering
// ----------------------------------------------------------------------------
// Show the task; textareas are filled only when fillTextareas is true.
function renderTask(task, fillTextareas) {
  document.getElementById("taskLoading").hidden = true;
  document.getElementById("taskWorkspace").hidden = false;
  setText("workTaskTitle", task.title || "Task");
  setText("workProjectName", task.projectName || "Unnamed project");

  // Link the AI assistant to this task's project.
  if (task.projectId) {
    const chatUrl = `chatbot.html?projectId=${encodeURIComponent(task.projectId)}`;
    document.getElementById("taskChatNav")?.setAttribute("href", chatUrl);
    document.getElementById("taskChatButton")?.setAttribute("href", chatUrl);
    document.getElementById("taskChatDrawer")?.setAttribute("href", chatUrl);
  }

  setText("workPriority", task.priority || "—");
  setText("workDeadline", task.deadline || "—");
  setText("workSeverity", task.severity || "—");
  setText("workCve", task.cveId || "—");
  setText("workDescription", task.description || "—");
  document.getElementById("workStatus").innerHTML = `<span class="task-status status-${statusClass(task.status)}">${escapeHtml(task.status || "Assigned")}</span>`;

  if (fillTextareas) {
    document.getElementById("revisedRequirement").value = task.revisedRequirement || "";
    document.getElementById("mitigationExplanation").value = task.mitigationExplanation || "";
  }

  const lastEditedNote = document.getElementById("lastEditedNote");
  if (task.lastEditedByName && task.lastEditedAt) {
    lastEditedNote.textContent = `Last edited by ${task.lastEditedByName} · ${formatTimestamp(task.lastEditedAt)}`;
  } else {
    lastEditedNote.textContent = "Not started yet";
  }

  const feedbackBox = document.getElementById("leaderFeedbackBox");
  if (task.leaderFeedback) {
    setText("leaderFeedbackText", task.leaderFeedback);
    feedbackBox.hidden = false;
  } else {
    feedbackBox.hidden = true;
  }

  const deadlineExtension = latestDeadlineExtension(task);
  const deadlineExtensionBox = document.getElementById("deadlineExtensionBox");
  if (deadlineExtension) {
    setText("deadlineExtensionText", deadlineExtensionSummary(deadlineExtension));
    deadlineExtensionBox.hidden = false;
  } else {
    deadlineExtensionBox.hidden = true;
  }

  renderDiscussion(task.discussion || []);

  // Read-only once the task is For Review or Done.
  const readOnly = task.status === "Done" || task.status === "For Review";
  document.getElementById("revisedRequirement").readOnly = readOnly;
  document.getElementById("mitigationExplanation").readOnly = readOnly;
  document.getElementById("saveDraft").hidden = readOnly;
  document.getElementById("submitReview").hidden = readOnly;

  if (readOnly) {
    document.getElementById("draftUpdateBanner").hidden = true;
  }

  updateSubmissionUI(task);
}

// ----------------------------------------------------------------------------
// Joint submission: a task with several assignees goes to the leader only when
// every assignee has submitted. Each submission is { email, name, at }.
// ----------------------------------------------------------------------------
function assigneeList(task) {
  const people = normalizedAssignees(task).map(m => ({
    email: String(m.email || "").toLowerCase(),
    name: m.name || m.email || ""
  })).filter(m => m.email);
  if (people.length) return people;
  return (task.assignedEmails || []).map(e => ({ email: String(e).toLowerCase(), name: e }));
}

// Submissions that still count: from a current assignee and newer than the last
// "changes requested" by the leader (a rework starts a fresh round).
function validSubmissions(task) {
  const assignees = new Set(assigneeList(task).map(m => m.email));
  const since = task.changeRequestedAt?.toDate ? task.changeRequestedAt.toDate().getTime() : 0;
  const seen = new Set();
  return (Array.isArray(task.submittedBy) ? task.submittedBy : []).filter(item => {
    const email = String(item?.email || "").toLowerCase();
    if (!assignees.has(email) || seen.has(email)) return false;
    if (new Date(item.at || 0).getTime() <= since) return false;
    seen.add(email);
    return true;
  });
}

// Show who has submitted and set the Submit button for the current user.
function updateSubmissionUI(task) {
  const people = assigneeList(task);
  const done = new Set(validSubmissions(task).map(item => item.email));
  const isFinal = task.status === "Done" || task.status === "For Review";
  const multi = people.length > 1;

  const box = document.getElementById("submissionStatus");
  if (box) {
    if (multi && !isFinal) {
      box.hidden = false;
      box.innerHTML = `<strong>Submissions: ${done.size} of ${people.length}</strong> — the task goes to the leader once everyone has submitted.
        <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px 14px;font-size:13px;">
          ${people.map(m => `<span>${done.has(m.email) ? "✅" : "⏳"} ${escapeHtml(m.name)}${m.email === currentUserEmail ? " (you)" : ""}</span>`).join("")}
        </div>`;
    } else {
      box.hidden = true;
    }
  }

  const button = document.getElementById("submitReview");
  if (!button) return;
  const mineDone = done.has(currentUserEmail);
  const waiting = people.filter(m => !done.has(m.email)).map(m => m.name);
  button.textContent = mineDone
    ? `Submitted ✓ — waiting for ${waiting.join(", ") || "teammates"}`
    : (multi ? "Submit my part" : "Submit for Review");
  button.disabled = mineDone && !isFinal;
  button.title = mineDone ? "Editing and saving the draft clears everyone's submissions." : "";
}

// Render the team notes, oldest first so the thread reads top to bottom.
function renderDiscussion(discussion) {
  const list = document.getElementById("discussionList");
  if (!list) return;

  if (!discussion.length) {
    list.innerHTML = '<p class="field-help">No notes yet — start the conversation with your teammates.</p>';
    return;
  }

  const sorted = [...discussion].sort((a, b) => new Date(a.at || 0) - new Date(b.at || 0));

  list.innerHTML = sorted.map(note => `
    <div style="background:rgba(255,255,255,0.04);border-radius:10px;padding:10px 12px;">
      <div style="display:flex;justify-content:space-between;gap:8px;font-size:12px;color:var(--muted,#8a8fa3);margin-bottom:4px;">
        <strong style="color:inherit;">${escapeHtml(note.authorName || note.authorEmail || "Teammate")}</strong>
        <span>${formatTimestamp(note.at)}</span>
      </div>
      <div style="font-size:13px;white-space:pre-wrap;">${escapeHtml(note.text || "")}</div>
    </div>
  `).join("");

  list.scrollTop = list.scrollHeight;
}

// ----------------------------------------------------------------------------
// Actions
// ----------------------------------------------------------------------------
// Append a note to the task's discussion thread.
async function postDiscussionNote() {
  const input = document.getElementById("discussionInput");
  const text = input.value.trim();
  if (!text) return;

  try {
    await updateDoc(doc(db, "tasks", taskId), {
      discussion: arrayUnion({
        authorEmail: currentUserEmail,
        authorName: currentUserName,
        text,
        at: new Date().toISOString()
      }),
      updatedAt: serverTimestamp()
    });
    input.value = "";
  } catch (error) {
    console.error("Failed to post note:", error);
    showError("Failed to post your note. Please try again.");
  }
}

// Save the shared draft (an Assigned task becomes In Progress). Changing the text
// clears earlier submissions, because teammates approved a different version.
async function saveDraft() {
  clearMessages();
  const revisedRequirement = document.getElementById("revisedRequirement").value.trim();
  const mitigationExplanation = document.getElementById("mitigationExplanation").value.trim();
  const draftChanged =
    revisedRequirement !== String(currentTask?.revisedRequirement || "").trim() ||
    mitigationExplanation !== String(currentTask?.mitigationExplanation || "").trim();
  const resetSubmissions = draftChanged && validSubmissions(currentTask).length > 0;

  setBusy(true);
  try {
    const changes = {
      revisedRequirement,
      mitigationExplanation,
      lastEditedBy: currentUserEmail,
      lastEditedByName: currentUserName,
      lastEditedAt: new Date().toISOString(),
      status: currentTask?.status === "Assigned" ? "In Progress" : currentTask?.status,
      updatedAt: serverTimestamp()
    };
    if (resetSubmissions) {
      changes.submittedBy = [];
      changes.discussion = arrayUnion(autoNote(`${currentUserName} changed the draft, so earlier submissions were cleared. Everyone needs to submit again.`));
    }
    await updateDoc(doc(db, "tasks", taskId), changes);
    hasUnsavedEdits = false;
    document.getElementById("draftUpdateBanner").hidden = true;
    showSuccess("Progress saved — your teammates will see this update.");
  } catch (error) {
    console.error("Failed to save draft:", error);
    showError(submitErrorMessage(error, "Failed to save your progress. Please try again."));
  } finally {
    setBusy(false);
  }
}

// Submit my part. The task moves to For Review only when every assignee has submitted;
// each submission also leaves an automatic note in the team thread.
async function submitForReview() {
  clearMessages();
  const revisedRequirement = document.getElementById("revisedRequirement").value.trim();
  const mitigationExplanation = document.getElementById("mitigationExplanation").value.trim();
  if (!revisedRequirement || !mitigationExplanation) {
    showError("Please complete the revised requirement and mitigation explanation before submitting.");
    return;
  }

  const people = assigneeList(currentTask);
  const draftChanged =
    revisedRequirement !== String(currentTask?.revisedRequirement || "").trim() ||
    mitigationExplanation !== String(currentTask?.mitigationExplanation || "").trim();

  // Others' submissions only stand if the draft they agreed to is unchanged.
  const others = draftChanged
    ? []
    : validSubmissions(currentTask).filter(item => item.email !== currentUserEmail);
  const submittedBy = [...others, { email: currentUserEmail, name: currentUserName, at: new Date().toISOString() }];

  const submittedEmails = new Set(submittedBy.map(item => item.email));
  const waiting = people.filter(m => !submittedEmails.has(m.email)).map(m => m.name);
  const everyoneDone = waiting.length === 0;

  let noteText;
  if (people.length <= 1) {
    noteText = `${currentUserName} submitted this task for the leader's review.`;
  } else if (everyoneDone) {
    noteText = `${currentUserName} submitted their part. All ${people.length} members have submitted, so the task was sent to the leader for review.`;
  } else {
    noteText = `${currentUserName} submitted their part (${submittedBy.length} of ${people.length}). Waiting for: ${waiting.join(", ")}.`;
  }
  if (draftChanged && others.length === 0 && validSubmissions(currentTask).some(item => item.email !== currentUserEmail)) {
    noteText += " The draft was changed, so earlier submissions were cleared.";
  }

  setBusy(true);
  try {
    await updateDoc(doc(db, "tasks", taskId), {
      revisedRequirement,
      mitigationExplanation,
      lastEditedBy: currentUserEmail,
      lastEditedByName: currentUserName,
      lastEditedAt: new Date().toISOString(),
      submittedBy,
      discussion: arrayUnion(autoNote(noteText)),
      status: everyoneDone ? "For Review" : (currentTask?.status === "Assigned" ? "In Progress" : currentTask?.status),
      updatedAt: serverTimestamp()
    });
    hasUnsavedEdits = false;
    if (everyoneDone) {
      showSuccess("Submitted for review! Everyone has submitted, so the task was sent to the leader.");
      setTimeout(() => { window.location.href = "task-board.html"; }, 1200);
    } else {
      showSuccess(`Your part is submitted. Waiting for ${waiting.join(", ")} before the task goes to the leader.`);
      setBusy(false);
    }
  } catch (error) {
    console.error("Failed to submit work:", error);
    showError(submitErrorMessage(error, "Failed to submit your work. Please try again."));
    setBusy(false);
  }
}

// Automatic team note written on behalf of the current user.
function autoNote(text) {
  return {
    authorEmail: currentUserEmail,
    authorName: currentUserName,
    text,
    at: new Date().toISOString()
  };
}

function submitErrorMessage(error, fallback) {
  if (error?.code === "permission-denied") {
    return fallback + " (Permission denied — the Firestore rules must allow members to update 'submittedBy'.)";
  }
  return fallback;
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
function isTaskAssignedTo(task, email) {
  return normalizedAssignees(task).some(m => String(m.email || "").toLowerCase() === email);
}

// Messages and button state.
function showLoadError(message) {
  document.getElementById("taskLoading").innerHTML = `<div class="empty-state">${escapeHtml(message)} <a href="task-board.html">Return to My Tasks</a></div>`;
}

function setBusy(busy) {
  document.getElementById("saveDraft").disabled = busy;
  document.getElementById("submitReview").disabled = busy;
  if (!busy && currentTask) updateSubmissionUI(currentTask);
}

function clearMessages() {
  document.getElementById("workError").hidden = true;
  document.getElementById("workSuccess").hidden = true;
}

function showError(message) {
  const element = document.getElementById("workError");
  element.textContent = message;
  element.hidden = false;
}

function showSuccess(message) {
  const element = document.getElementById("workSuccess");
  element.textContent = message;
  element.hidden = false;
}

function setText(id, value) { document.getElementById(id).textContent = value; }

function formatTimestamp(value) {
  if (!value) return "just now";
  const date = typeof value === "string" ? new Date(value) : (value.toDate ? value.toDate() : new Date(value));
  if (Number.isNaN(date.getTime())) return "just now";
  return date.toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function latestDeadlineExtension(task) {
  if (task?.latestDeadlineExtension) return task.latestDeadlineExtension;
  const history = Array.isArray(task?.deadlineExtensionHistory) ? task.deadlineExtensionHistory : [];
  return history.length ? history[history.length - 1] : null;
}

function formatDeadline(value) {
  if (!value) return "—";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function deadlineExtensionSummary(entry) {
  return `${formatDeadline(entry.previousDeadline)} → ${formatDeadline(entry.newDeadline)} · ${entry.reason || "Reason recorded"} · Recorded by ${entry.changedByName || entry.changedByEmail || "Project Leader"} on ${formatTimestamp(entry.changedAt)}`;
}

function statusClass(status) {
  return { "Assigned": "open", "In Progress": "progress", "For Review": "review", "Done": "pending" }[status] || "open";
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
