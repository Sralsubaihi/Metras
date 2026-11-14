// project-tasks.js - Leader's task page for one project (project-tasks.html?projectId=...).
// Lists the project's tasks live with status filters and deadline colours. The leader
// reviews submissions (approve / request changes), sends approved work back for
// rework, sees the approved requirements and downloads the updated requirements
// document (.doc).

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { attachInfoTooltip, DEADLINE_LEGEND_HTML } from "./info-tooltip.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import { getFirestore, collection, query, where, onSnapshot, doc, getDoc, updateDoc, serverTimestamp, arrayUnion } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
import { requireRole, setupLogout } from "./session.js";
import { API_BASE } from "./config.js";

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
let tasks = [];
let activeFilter = "All";
let selectedTaskId = null;
let unsubscribeTasks = null;
let currentProject = null;
let currentLeaderEmail = "";
let currentLeaderName = "Project Leader";
let deadlineTaskId = null;

// ----------------------------------------------------------------------------
// Page setup
// ----------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  initDrawer();
  initFilters();
  initReviewModal();
  initReworkModal();
  initDeadlineExtensionModal();
  document.getElementById("downloadRequirements")?.addEventListener("click", downloadRequirementsDocument);
  attachInfoTooltip(document.getElementById("deadlineLegendIcon"), DEADLINE_LEGEND_HTML);
});

// ----------------------------------------------------------------------------
// Auth guard: load the project
// ----------------------------------------------------------------------------
requireRole(auth, db, ["leader"]).then(async ({ user, profile }) => {
  currentLeaderEmail = String(user.email || "").toLowerCase();
  currentLeaderName = profile?.name || user.displayName || user.email || "Project Leader";
  if (!projectId) {
    showPageError("No project was selected.");
    return;
  }
  await loadProject(currentLeaderEmail);
});

// Load the project and check that the signed-in user is its leader.
async function loadProject(userEmail) {
  try {
    const projectSnapshot = await getDoc(doc(db, "projects", projectId));
    if (!projectSnapshot.exists()) {
      showPageError("This project does not exist.");
      return;
    }
    const project = projectSnapshot.data();
    currentProject = { id: projectSnapshot.id, ...project };
    if ((project.leaderEmail || "").toLowerCase() !== userEmail) {
      showPageError("You do not have permission to view this project's tasks.");
      return;
    }
    document.getElementById("projectTaskName").textContent = project.name || "Unnamed Project";
    document.getElementById("compareVersionsLink")?.setAttribute("href", `compare.html?projectId=${encodeURIComponent(projectId)}`);
    renderApprovedRequirements();
    listenToProjectTasks();
  } catch (error) {
    console.error("Failed to load project:", error);
    showPageError("Unable to load this project. Please refresh.");
  }
}

// Listen to the project's tasks in real time.
function listenToProjectTasks() {
  unsubscribeTasks?.();
  const tasksQuery = query(collection(db, "tasks"), where("projectId", "==", projectId));
  unsubscribeTasks = onSnapshot(tasksQuery, snapshot => {
    tasks = snapshot.docs.map(taskDoc => ({ ...taskDoc.data(), id: taskDoc.id }));
    renderTasks();
  }, error => {
    console.error("Failed to load project tasks:", error);
    showTableMessage("Unable to load tasks. Please refresh.");
  });
}

// ----------------------------------------------------------------------------
// Task table
// ----------------------------------------------------------------------------
// Status filter pills (All / Assigned / In Progress / For Review / Done).
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

// Render the tasks sorted by nearest deadline. Actions by status:
// Review (For Review), View + Request Rework (Done).
function renderTasks() {
  const body = document.getElementById("projectTasksBody");
  let filtered = activeFilter === "All" ? [...tasks] : tasks.filter(task => task.status === activeFilter);
  filtered.sort((a, b) => deadlineTime(a.deadline) - deadlineTime(b.deadline));

  if (!filtered.length) {
    showTableMessage(activeFilter === "All" ? "No tasks have been created for this project." : `No tasks with status “${activeFilter}”.`);
    return;
  }

  body.innerHTML = filtered.map(task => {
    const deadline = deadlineInfo(task);
    const latestExtension = latestDeadlineExtension(task);
    return `
      <tr>
        <td data-label="Task"><div class="table-task-title">${escapeHtml(task.title || "Untitled Task")}</div><div class="table-task-priority">${escapeHtml(task.priority || "Medium")} priority</div></td>
        <td data-label="Assigned To">${escapeHtml(assignedNames(task))}</td>
        <td data-label="Status"><span class="task-status status-${statusClass(task.status)}">${escapeHtml(task.status || "Assigned")}</span></td>
        <td data-label="Deadline">
          <span class="deadline-badge ${deadline.className}">${escapeHtml(formatDate(task.deadline))}</span>
          ${latestExtension ? `<div class="deadline-extension-note" title="${escapeAttr(latestExtension.reason || "")}">Extended: ${escapeHtml(latestExtension.reason || "Reason recorded")}</div>` : ""}
        </td>
        <td data-label="Action">
          <div class="task-action-group">
            ${task.status === "For Review" ? `<button class="btn btn-primary table-action" data-review-id="${task.id}">Review</button>` : ""}
            ${task.status === "Done" ? `<button class="btn btn-secondary table-action" data-view-id="${task.id}">View</button> <button class="btn btn-secondary table-action" data-rework-id="${task.id}">Request Rework</button>` : ""}
            ${task.status !== "Done" ? `<button class="btn btn-secondary table-action" data-deadline-id="${task.id}">Extend Deadline</button>` : ""}
          </div>
        </td>
      </tr>`;
  }).join("");

  // Wire the action buttons.
  body.querySelectorAll("[data-review-id]").forEach(button => {
    button.addEventListener("click", () => openReviewModal(button.dataset.reviewId));
  });
  body.querySelectorAll("[data-view-id]").forEach(button => {
    button.addEventListener("click", () => openReviewModal(button.dataset.viewId));
  });
  body.querySelectorAll("[data-rework-id]").forEach(button => {
    button.addEventListener("click", () => openReworkModal(button.dataset.reworkId));
  });
  body.querySelectorAll("[data-deadline-id]").forEach(button => {
    button.addEventListener("click", () => openDeadlineExtensionModal(button.dataset.deadlineId));
  });
}

// Assignees as a list; older tasks stored a single assignedTo object.
function normalizedAssignees(task) {
  if (Array.isArray(task.assignedTo)) return task.assignedTo;
  if (task.assignedTo?.email) return [task.assignedTo];
  return [];
}
function assignedNames(task) {
  return normalizedAssignees(task).map(m => m.name || m.email).join(", ") || "—";
}

// Deadline colour by the share of the task's time already used:
// under 1/3 green, under 2/3 orange, otherwise (or overdue) red.
// Done tasks and tasks without dates are neutral.
function deadlineInfo(task) {
  if (task.status === "Done") return { className: "deadline-done" };
  const end = parseDeadline(task.deadline);
  if (!end) return { className: "deadline-neutral" };

  const now = new Date();
  if (now.getTime() > end.getTime()) return { className: "deadline-red" };

  // A deadline extension starts a fresh colour window. Without an extension,
  // use the original task creation time as before.
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

// ----------------------------------------------------------------------------
// Deadline extension modal and audit trail
// ----------------------------------------------------------------------------
// A deadline can only move later. Every change records the old/new date, reason,
// leader identity and timestamp so the team has a durable project audit trail.
function initDeadlineExtensionModal() {
  document.getElementById("closeDeadlineModal")?.addEventListener("click", closeDeadlineExtensionModal);
  document.getElementById("cancelDeadlineChange")?.addEventListener("click", closeDeadlineExtensionModal);
  document.getElementById("deadlineExtensionModal")?.addEventListener("click", event => {
    if (event.target.id === "deadlineExtensionModal") closeDeadlineExtensionModal();
  });
  document.getElementById("saveDeadlineChange")?.addEventListener("click", submitDeadlineExtension);
}

function deadlineHistory(task) {
  return Array.isArray(task?.deadlineExtensionHistory) ? task.deadlineExtensionHistory : [];
}

function latestDeadlineExtension(task) {
  if (task?.latestDeadlineExtension) return task.latestDeadlineExtension;
  const history = deadlineHistory(task);
  return history.length ? history[history.length - 1] : null;
}

function openDeadlineExtensionModal(taskId) {
  const task = tasks.find(item => item.id === taskId);
  if (!task || task.status === "Done") return;

  deadlineTaskId = taskId;
  document.getElementById("deadlineModalTitle").textContent = `Extend Deadline — ${task.title || "Task"}`;
  document.getElementById("deadlineCurrentDate").textContent = formatDate(task.deadline);
  const newDateInput = document.getElementById("deadlineNewDate");
  newDateInput.value = "";
  newDateInput.min = minimumExtensionDate(task.deadline);
  document.getElementById("deadlineReason").value = "";
  document.getElementById("deadlineError").hidden = true;
  document.getElementById("deadlineSuccess").hidden = true;
  renderDeadlineHistory(task);
  document.getElementById("deadlineExtensionModal").style.display = "flex";
}

function closeDeadlineExtensionModal() {
  deadlineTaskId = null;
  document.getElementById("deadlineExtensionModal").style.display = "none";
}

function renderDeadlineHistory(task) {
  const container = document.getElementById("deadlineHistoryList");
  const history = deadlineHistory(task).slice().reverse();
  container.innerHTML = history.length ? history.map(entry => `
    <article class="deadline-history-item">
      <div><strong>${escapeHtml(formatDate(entry.previousDeadline))} → ${escapeHtml(formatDate(entry.newDeadline))}</strong><span>${escapeHtml(formatAuditTimestamp(entry.changedAt))}</span></div>
      <p>${escapeHtml(entry.reason || "—")}</p>
      <small>Recorded by ${escapeHtml(entry.changedByName || entry.changedByEmail || "Project Leader")}${entry.changedByEmail ? ` (${escapeHtml(entry.changedByEmail)})` : ""}</small>
    </article>`).join("") : '<p class="field-help">No previous deadline extensions.</p>';
}

async function submitDeadlineExtension() {
  if (!deadlineTaskId) return;
  const task = tasks.find(item => item.id === deadlineTaskId);
  if (!task || task.status === "Done") return;

  const newDeadline = document.getElementById("deadlineNewDate").value;
  const reason = document.getElementById("deadlineReason").value.trim();
  const errorEl = document.getElementById("deadlineError");
  const successEl = document.getElementById("deadlineSuccess");
  errorEl.hidden = true;
  successEl.hidden = true;

  if (!newDeadline) {
    errorEl.textContent = "Please select the new deadline.";
    errorEl.hidden = false;
    return;
  }
  if (newDeadline < todayDateString()) {
    errorEl.textContent = "The new deadline cannot be before today.";
    errorEl.hidden = false;
    return;
  }
  if (task.deadline && newDeadline <= task.deadline) {
    errorEl.textContent = "The new deadline must be later than the current deadline.";
    errorEl.hidden = false;
    return;
  }
  if (!reason) {
    errorEl.textContent = "A postponement reason is required for the audit record.";
    errorEl.hidden = false;
    return;
  }

  const changedAt = new Date().toISOString();
  const auditEntry = {
    previousDeadline: task.deadline || null,
    newDeadline,
    reason,
    changedByEmail: currentLeaderEmail,
    changedByName: currentLeaderName,
    changedAt
  };
  const discussionEntry = {
    authorEmail: currentLeaderEmail,
    authorName: currentLeaderName,
    text: `Deadline extended from ${formatDate(task.deadline)} to ${formatDate(newDeadline)}. Reason: ${reason}`,
    at: changedAt,
    system: true
  };
  const saveButton = document.getElementById("saveDeadlineChange");
  saveButton.disabled = true;
  saveButton.textContent = "Saving...";

  try {
    await updateDoc(doc(db, "tasks", deadlineTaskId), {
      deadline: newDeadline,
      deadlineExtensionHistory: arrayUnion(auditEntry),
      latestDeadlineExtension: auditEntry,
      deadlineUpdatedAt: serverTimestamp(),
      deadlineUpdatedBy: currentLeaderEmail,
      discussion: arrayUnion(discussionEntry),
      updatedAt: serverTimestamp()
    });
    successEl.textContent = "Deadline extended and the reason was added to the audit record.";
    successEl.hidden = false;
    setTimeout(closeDeadlineExtensionModal, 1000);
  } catch (error) {
    console.error("Failed to extend deadline:", error);
    errorEl.textContent = "Failed to save the deadline extension. Please try again.";
    errorEl.hidden = false;
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "Save Extension";
  }
}

// ----------------------------------------------------------------------------
// Review modal (approve / request changes / read-only view)
// ----------------------------------------------------------------------------
function initReviewModal() {
  document.getElementById("closeReviewModal")?.addEventListener("click", closeReviewModal);
  document.getElementById("reviewTaskModal")?.addEventListener("click", event => {
    if (event.target.id === "reviewTaskModal") closeReviewModal();
  });
  document.getElementById("approveTask")?.addEventListener("click", approveSelectedTask);
  document.getElementById("requestChanges")?.addEventListener("click", requestTaskChanges);
  document.getElementById("closeReviewView")?.addEventListener("click", closeReviewModal);
}

// ----------------------------------------------------------------------------
// Rework modal
// ----------------------------------------------------------------------------
// Sends an approved ("Done") task back for more work, optionally reassigning it.
let reworkTaskId = null;

function initReworkModal() {
  document.getElementById("closeReworkModal")?.addEventListener("click", closeReworkModal);
  document.getElementById("cancelRework")?.addEventListener("click", closeReworkModal);
  document.getElementById("reworkModal")?.addEventListener("click", event => {
    if (event.target.id === "reworkModal") closeReworkModal();
  });
  document.getElementById("sendRework")?.addEventListener("click", submitReworkRequest);
}

// Open the rework modal with the current assignees pre-checked.
function openReworkModal(taskId) {
  const task = tasks.find(item => item.id === taskId);
  if (!task) return;

  reworkTaskId = taskId;
  document.getElementById("reworkTaskTitle").textContent = `Request Rework — ${task.title || "Task"}`;
  document.getElementById("reworkApprovedText").textContent = task.revisedRequirement || "—";
  document.getElementById("reworkReason").value = "";
  document.getElementById("reworkCurrentDeadline").textContent = formatDate(task.deadline);
  const reworkDeadlineInput = document.getElementById("reworkDeadline");
  reworkDeadlineInput.min = minimumExtensionDate(task.deadline);
  reworkDeadlineInput.value = reworkDeadlineInput.min;
  document.getElementById("reworkError").hidden = true;
  document.getElementById("reworkSuccess").hidden = true;

  const currentAssigneeEmails = normalizedAssignees(task).map(m => String(m.email || "").toLowerCase());
  const members = Array.isArray(currentProject?.members) ? currentProject.members : [];
  const list = document.getElementById("reworkAssigneeList");

  if (!members.length) {
    list.innerHTML = '<span class="field-help">No team members on this project.</span>';
  } else {
    list.innerHTML = members.map((m, i) => `
      <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
        <input type="checkbox" class="rework-assignee-checkbox" value="${escapeAttr(m.email)}" id="reworkAssignee_${i}"
          ${currentAssigneeEmails.includes(String(m.email || "").toLowerCase()) ? "checked" : ""}>
        <span>${escapeHtml(m.name)} <span style="color:var(--muted,#8a8fa3);">(${escapeHtml(m.email)})</span></span>
      </label>
    `).join("");
  }

  document.getElementById("reworkModal").style.display = "flex";
}

function closeReworkModal() {
  reworkTaskId = null;
  document.getElementById("reworkModal").style.display = "none";
}

// Send the task back: In Progress + leader feedback + (optionally) new assignees.
async function submitReworkRequest() {
  if (!reworkTaskId) return;
  const task = tasks.find(item => item.id === reworkTaskId);
  if (!task) return;

  const reason = document.getElementById("reworkReason").value.trim();
  const newDeadline = document.getElementById("reworkDeadline").value;
  const errorEl = document.getElementById("reworkError");
  const successEl = document.getElementById("reworkSuccess");
  errorEl.hidden = true;
  successEl.hidden = true;

  // Validation: a reason, an extended deadline and at least one assignee.
  if (!reason) {
    errorEl.textContent = "Please explain what still needs to be fixed.";
    errorEl.hidden = false;
    return;
  }
  if (!newDeadline) {
    errorEl.textContent = "Please select the extended deadline.";
    errorEl.hidden = false;
    return;
  }
  if (newDeadline < todayDateString()) {
    errorEl.textContent = "The extended deadline cannot be before today.";
    errorEl.hidden = false;
    return;
  }
  if (task.deadline && newDeadline <= task.deadline) {
    errorEl.textContent = "The extended deadline must be later than the current deadline.";
    errorEl.hidden = false;
    return;
  }

  const checkedEmails = Array.from(document.querySelectorAll(".rework-assignee-checkbox:checked")).map(cb => cb.value);
  if (!checkedEmails.length) {
    errorEl.textContent = "Please select at least one team member to assign this to.";
    errorEl.hidden = false;
    return;
  }

  const members = Array.isArray(currentProject?.members) ? currentProject.members : [];
  const newAssignedTo = members.filter(m => checkedEmails.includes(m.email));

  const sendButton = document.getElementById("sendRework");
  sendButton.disabled = true;
  sendButton.textContent = "Sending...";

  try {
    const changedAt = new Date().toISOString();
    const auditEntry = {
      previousDeadline: task.deadline || null,
      newDeadline,
      reason: `Rework requested: ${reason}`,
      changedByEmail: currentLeaderEmail,
      changedByName: currentLeaderName,
      changedAt
    };
    const discussionEntry = {
      authorEmail: currentLeaderEmail,
      authorName: currentLeaderName,
      text: `Rework requested and deadline extended from ${formatDate(task.deadline)} to ${formatDate(newDeadline)}. Reason: ${reason}`,
      at: changedAt,
      system: true
    };

    // Reassigning changes assignedTo/assignedEmails, so the Firestore rules must let the
    // leader update those fields as well.
    await updateDoc(doc(db, "tasks", reworkTaskId), {
      status: "In Progress",
      leaderFeedback: reason,
      changeRequested: true,
      changeRequestedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      assignedTo: newAssignedTo,
      assignedEmails: newAssignedTo.map(m => String(m.email || "").toLowerCase()),
      deadline: newDeadline,
      deadlineExtensionHistory: arrayUnion(auditEntry),
      latestDeadlineExtension: auditEntry,
      deadlineUpdatedAt: serverTimestamp(),
      deadlineUpdatedBy: currentLeaderEmail,
      discussion: arrayUnion(discussionEntry)
    });

    // The old approval is no longer valid: remove it from approvedRequirements so it stops
    // counting as resolved and is left out of the exported document.
    const approved = Array.isArray(currentProject?.approvedRequirements) ? currentProject.approvedRequirements : [];
    const updatedApproved = approved.filter(entry => entry.taskId !== reworkTaskId);
    if (updatedApproved.length !== approved.length) {
      await updateDoc(doc(db, "projects", projectId), { approvedRequirements: updatedApproved, updatedAt: serverTimestamp() });
      currentProject.approvedRequirements = updatedApproved;
      renderApprovedRequirements();
    }

    successEl.textContent = "Rework request sent.";
    successEl.hidden = false;
    setTimeout(closeReworkModal, 900);

  } catch (error) {
    console.error("Failed to send rework request:", error);
    errorEl.textContent = "Failed to send the rework request. Please try again.";
    errorEl.hidden = false;
  } finally {
    sendButton.disabled = false;
    sendButton.textContent = "Send Rework Request";
  }
}

// Open the review modal. For a Done task it is a read-only view of what was approved
// (with its new-risk check); otherwise the leader can approve or request changes.
function openReviewModal(taskId) {
  const task = tasks.find(item => item.id === taskId);
  if (!task) return;
  selectedTaskId = taskId;

  const isDone = task.status === "Done";

  document.getElementById("reviewTaskTitle").textContent = (isDone ? "Submission Details — " : "") + (task.title || "Review Task");
  document.getElementById("reviewOriginal").textContent = task.description || "—";
  document.getElementById("reviewRevised").textContent = task.revisedRequirement || "—";
  document.getElementById("reviewMitigation").textContent = task.mitigationExplanation || task.submission || "—";
  document.getElementById("reviewTeam").textContent = assignedNames(task) +
    (task.lastEditedByName ? ` · last edited by ${task.lastEditedByName}` : "");

  // Team discussion notes, as context for the leader.
  const discussionBox = document.getElementById("reviewDiscussion");
  if (discussionBox) {
    const discussion = Array.isArray(task.discussion) ? task.discussion : [];
    discussionBox.innerHTML = discussion.length ? `
      <div class="review-detail"><span>Team notes (context for you)</span>
        <div style="max-height:140px;overflow-y:auto;display:flex;flex-direction:column;gap:6px;">
          ${discussion.map(n => `<p style="margin:0;font-size:12px;"><strong>${escapeHtml(n.authorName || n.authorEmail || "Teammate")}:</strong> ${escapeHtml(n.text || "")}</p>`).join("")}
        </div>
      </div>` : "";
  }

  // New-risk check result of an approved task.
  const riskCheckBox = document.getElementById("reviewRiskCheck");
  if (isDone) {
    const approvedEntry = (currentProject?.approvedRequirements || []).find(entry => entry.taskId === taskId);
    if (approvedEntry && approvedEntry.newSeverity) {
      riskCheckBox.innerHTML = `
        <div class="review-detail" style="${approvedEntry.newRiskFlagged ? "border-color:rgba(255,138,150,.4);" : ""}">
          <span>New-risk check result</span>
          <p style="${approvedEntry.newRiskFlagged ? "color:#ff8a96;font-weight:800;" : ""}">
            ${approvedEntry.newRiskFlagged ? "⚠ Still flagged" : "✓ Clean"} —
            severity ${escapeHtml(approvedEntry.newSeverity)}${approvedEntry.newTopCve ? `, matches ${escapeHtml(approvedEntry.newTopCve)}` : ""}
          </p>
        </div>`;
    } else {
      riskCheckBox.innerHTML = `<div class="review-detail"><span>New-risk check result</span><p>Not checked yet.</p></div>`;
    }
  } else {
    riskCheckBox.innerHTML = "";
  }

  // Show only the controls that fit the task's status.
  document.getElementById("reviewFeedback").value = "";
  document.getElementById("reviewFeedback").closest(".field").style.display = isDone ? "none" : "";
  document.getElementById("requestChanges").style.display = isDone ? "none" : "";
  document.getElementById("approveTask").style.display = isDone ? "none" : "";
  document.getElementById("closeReviewView").style.display = isDone ? "" : "none";
  document.getElementById("reviewError").hidden = true;
  document.getElementById("reviewTaskModal").style.display = "flex";
}

function closeReviewModal() {
  selectedTaskId = null;
  document.getElementById("reviewTaskModal").style.display = "none";
}

// Approve: re-check the revised text for new risks, mark the task Done and add the
// revision to the project's approvedRequirements.
async function approveSelectedTask() {
  if (!selectedTaskId) return;
  const task = tasks.find(item => item.id === selectedTaskId);
  if (!task) return;

  if (!task.revisedRequirement) {
    showReviewError("The team hasn't written a revised requirement yet — nothing to approve.");
    return;
  }

  setReviewBusy(true);
  try {
    // Re-run the AI pipeline on the revised wording. Soft check: if the backend is offline
    // the approval still goes ahead, just without a new-risk result.
    let riskCheck = null;
    try {
      const idToken = await auth.currentUser.getIdToken();
      const response = await fetch(`${API_BASE}/reanalyze-requirement`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${idToken}` },
        body: JSON.stringify({ project_id: projectId, text: task.revisedRequirement })
      });
      if (response.ok) riskCheck = await response.json();
      else console.warn("New-risk check returned an error:", await response.text());
    } catch (riskError) {
      console.warn("New-risk check failed (backend may be offline):", riskError);
    }

    // One approved entry per task, credited to everyone who worked on it.
    const entry = {
      requirementText: task.revisedRequirement,
      originalRequirementText: task.originalRequirementText || "",
      mitigationExplanation: task.mitigationExplanation || task.submission || "",
      taskId: selectedTaskId,
      taskTitle: task.title || "Task",
      cveId: task.cveId || null,
      contributedBy: assignedNames(task),
      approvedAt: new Date().toISOString(),

      // New-risk check result (null if the check could not run), used by the Compare page.
      newSeverity: riskCheck?.newSeverity ?? null,
      newRiskLevel: riskCheck?.newRiskLevel ?? null,
      newTopCve: riskCheck?.newTopCve ?? null,
      newSimilarity: riskCheck?.newSimilarity ?? null,
      newCveDescription: riskCheck?.newCveDescription ?? null,
      newRiskFlagged: riskCheck?.flagged ?? false
    };

    // Save the task status and append the entry to the project.
    const taskRef = doc(db, "tasks", selectedTaskId);
    const projectRef = doc(db, "projects", projectId);
    await updateDoc(taskRef, { status: "Done", leaderFeedback: "", changeRequested: false, reviewedAt: serverTimestamp(), updatedAt: serverTimestamp() });
    await updateDoc(projectRef, { approvedRequirements: arrayUnion(entry), updatedAt: serverTimestamp() });

    currentProject.approvedRequirements = [...(currentProject.approvedRequirements || []), entry];
    renderApprovedRequirements();
    closeReviewModal();
  } catch (error) {
    console.error("Failed to approve task:", error);
    showReviewError("Failed to approve the task and update the requirements document.");
  } finally {
    setReviewBusy(false);
  }
}

// Request changes: back to In Progress with the leader's feedback.
async function requestTaskChanges() {
  if (!selectedTaskId) return;
  const feedback = document.getElementById("reviewFeedback").value.trim();
  if (!feedback) {
    showReviewError("Please explain what the team needs to change.");
    return;
  }
  await updateSelectedTask({ status: "In Progress", leaderFeedback: feedback, changeRequested: true, changeRequestedAt: serverTimestamp(), updatedAt: serverTimestamp() });
}

// Apply an update to the selected task and close the modal.
async function updateSelectedTask(changes) {
  setReviewBusy(true);
  try {
    await updateDoc(doc(db, "tasks", selectedTaskId), changes);
    closeReviewModal();
  } catch (error) {
    console.error("Failed to review task:", error);
    showReviewError("Failed to update the task. Please try again.");
  } finally {
    setReviewBusy(false);
  }
}

// Disable the review buttons while saving.
function setReviewBusy(busy) {
  document.getElementById("approveTask").disabled = busy;
  document.getElementById("requestChanges").disabled = busy;
}

function showReviewError(message) {
  const error = document.getElementById("reviewError");
  error.textContent = message;
  error.hidden = false;
}

// ----------------------------------------------------------------------------
// Requirements document export
// ----------------------------------------------------------------------------
// Build a Word-compatible .doc of the requirement set as it stands now: every original
// requirement replaced by its latest approved revision.
async function downloadRequirementsDocument() {
  if (!currentProject) return;
  try {
    const resultSnap = await getDoc(doc(db, "project_results", projectId));
    const originalRows = resultSnap.exists() && Array.isArray(resultSnap.data().results) ? resultSnap.data().results : [];
    const approved = Array.isArray(currentProject.approvedRequirements) ? currentProject.approvedRequirements : [];

    if (!originalRows.length && !approved.length) {
      alert("There are no analyzed requirements yet. Run an analysis first.");
      return;
    }

    // Remove duplicates (same rule as the Results table).
    const seenGroups = new Set();
    const uniqueOriginalRows = originalRows.filter(r => {
      if (!r["Is Duplicate"]) return true;
      const group = r["Duplicate Group"];
      if (!seenGroups.has(group)) { seenGroups.add(group); return true; }
      return false;
    });

    // Latest approved revision for each original requirement, matched by exact original text.
    const approvedByOriginalText = new Map();
    approved.forEach(entry => {
      const key = (entry.originalRequirementText || "").trim();
      if (!key) return;
      const existing = approvedByOriginalText.get(key);
      if (!existing || new Date(entry.approvedAt || 0) > new Date(existing.approvedAt || 0)) {
        approvedByOriginalText.set(key, entry);
      }
    });

    // Use the revision when there is one and mark it as updated.
    const finalRequirements = uniqueOriginalRows.map(row => {
      const originalText = (row.Requirement || row.requirement || "").trim();
      const match = approvedByOriginalText.get(originalText);
      return {
        text: match ? match.requirementText : originalText,
        updated: Boolean(match)
      };
    });

    // Approved entries whose original line is not in the results are still included.
    const coveredOriginals = new Set(uniqueOriginalRows.map(r => (r.Requirement || r.requirement || "").trim()));
    approved.forEach(entry => {
      const key = (entry.originalRequirementText || "").trim();
      if (key && !coveredOriginals.has(key)) {
        finalRequirements.push({ text: entry.requirementText, updated: true });
      }
    });

    if (!finalRequirements.length) {
      alert("There are no requirements available to export yet.");
      return;
    }

    const escapeDoc = value => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // Plain numbered list, like a real SRS.
    const listItems = finalRequirements.map((item, i) => `
      <li style="margin-bottom:10px;">
        ${escapeDoc(item.text)}
        ${item.updated ? '<span style="color:#5861b5;font-style:italic;"> (updated after security review)</span>' : ""}
      </li>`).join("");

    const html = `<html><head><meta charset="utf-8"><title>${escapeDoc(currentProject.name || "Metras Requirements")}</title></head>
      <body style="font-family:Arial,sans-serif;line-height:1.6;">
        <h1 style="margin-bottom:4px;">${escapeDoc(currentProject.name || "Project")} — Software Requirements Document</h1>
        <p style="color:#555;margin-top:0;">Generated by METRAS on ${new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "long", year: "numeric" })}</p>
        <ol style="padding-left:22px;">${listItems}</ol>
      </body></html>`;

    // Download as .doc (Word opens HTML saved with this MIME type).
    const blob = new Blob(["\ufeff", html], { type: "application/msword" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(currentProject.name || "Metras").replace(/[^a-z0-9_-]+/gi, "_")}_Requirements.doc`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  } catch (error) {
    console.error("Failed to generate requirements document:", error);
    alert("Could not generate the requirements document. Please try again.");
  }
}

// ----------------------------------------------------------------------------
// Approved requirements list
// ----------------------------------------------------------------------------
// Show the approved requirements with auto-approval and new-risk notes.
function renderApprovedRequirements() {
  const list = document.getElementById("approvedRequirementsList");
  const count = document.getElementById("approvedRequirementsCount");
  if (!list) return;

  const approved = Array.isArray(currentProject?.approvedRequirements)
    ? currentProject.approvedRequirements
    : [];

  if (count) count.textContent = String(approved.length);

  // The Compare button only makes sense once something has been approved.
  const compareLink = document.getElementById("compareVersionsLink");
  if (compareLink) compareLink.style.display = approved.length ? "inline-flex" : "none";

  if (!approved.length) {
    list.innerHTML = '<div class="table-empty">No requirements have been approved yet.</div>';
    return;
  }

  list.innerHTML = approved.map((item, index) => `
    <article class="approved-requirement-item">
      <div class="approved-requirement-number">${index + 1}</div>
      <div class="approved-requirement-content">
        <p class="approved-requirement-text">${escapeHtml(item.requirementText || "—")}</p>
        ${item.autoApproved ? `
          <p style="margin:6px 0 0;font-size:11px;color:#6ee7a8;">
            ✓ Automatically marked clean — no security risk was detected, so no task was needed.
          </p>` : ""}
        ${item.newRiskFlagged ? `
          <p style="margin:6px 0 0;font-size:12px;color:#ff8a96;font-weight:800;">
            ⚠ New risk check: still matches ${escapeHtml(item.newTopCve || "a CVE")} (${escapeHtml(item.newSeverity || "High")} severity) — consider reviewing this fix again.
          </p>` : ""}
        <div class="approved-requirement-meta">
          ${item.autoApproved ? "" : `<span>Task: ${escapeHtml(item.taskTitle || "—")}</span>
          <span>Contributed by: ${escapeHtml(item.contributedBy || item.contributedByEmail || "Member")}</span>`}
          ${item.cveId ? `<span>CVE: ${escapeHtml(item.cveId)}</span>` : ""}
          <span>Approved: ${escapeHtml(item.approvedAt ? new Date(item.approvedAt).toLocaleDateString("en-GB") : "—")}</span>
        </div>
      </div>
    </article>
  `).join("");
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
// Show an error in the page title and in the table.
function showPageError(message) {
  document.getElementById("projectTaskName").textContent = message;
  showTableMessage("Return to Task Projects and select a project.");
}

function showTableMessage(message) {
  document.getElementById("projectTasksBody").innerHTML = `<tr><td colspan="5" class="table-empty">${escapeHtml(message)}</td></tr>`;
}

// Convert a Firestore timestamp, {seconds} object or date string to a Date.
function timestampToDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value.seconds === "number") return new Date(value.seconds * 1000);
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Deadlines count until the end of their day (23:59:59).
function parseDeadline(value) {
  if (!value) return null;
  const date = new Date(`${value}T23:59:59`);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Sort key: tasks without a deadline go last.
function deadlineTime(value) {
  const date = parseDeadline(value);
  return date ? date.getTime() : Number.MAX_SAFE_INTEGER;
}

function formatDate(value) {
  const date = parseDeadline(value);
  return date ? date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "—";
}

function nextDateString(value) {
  const date = value ? new Date(`${value}T12:00:00`) : new Date();
  if (Number.isNaN(date.getTime())) return "";
  date.setDate(date.getDate() + 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function todayDateString() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function minimumExtensionDate(currentDeadline) {
  const today = todayDateString();
  const afterCurrent = nextDateString(currentDeadline);
  return afterCurrent && afterCurrent > today ? afterCurrent : today;
}

function formatAuditTimestamp(value) {
  const date = timestampToDate(value);
  return date ? date.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "Time unavailable";
}

// CSS class of a task status badge.
function statusClass(status) {
  return { "Assigned": "open", "In Progress": "progress", "For Review": "review", "Done": "pending" }[status] || "open";
}

// Escape text before inserting it into HTML (prevents XSS).
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}

// Escape double quotes for use inside an HTML attribute.
function escapeAttr(text) {
  return String(text ?? "").replace(/"/g, "&quot;");
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
