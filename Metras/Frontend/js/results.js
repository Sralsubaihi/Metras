// results.js - Risk Assessment Results page (results.html).
// Shows the saved analysis of the active project (local cache first, then the shared
// Firestore copy), hides duplicate rows, explains every column with info icons,
// auto-approves clean requirements (Low severity, no CVE) and lets the leader create
// remediation tasks from risky rows.

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { attachInfoTooltip } from "./info-tooltip.js";
import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  addDoc,
  serverTimestamp,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  writeBatch,
  updateDoc
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

// Only leaders may open the results page.
requireRole(auth, db, ["leader"]);

// ----------------------------------------------------------------------------
// Page setup (everything below runs once the page has loaded)
// ----------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  const tableBody = document.getElementById("resultsTableBody");
  const currentProjectTab = document.getElementById("currentProjectTab");

  // Rows currently shown (used by the Create Task buttons) and the active project.
  let currentRows = [];
  let currentProject = null;

  initDrawer();
  initColumnInfoTooltips();
  initTaskModal();
  loadProjectName();
  loadSavedResults();

  // --------------------------------------------------------------------------
  // Project name and results table
  // --------------------------------------------------------------------------
  // Show the active project's name in the sub-bar.
  function loadProjectName() {
    currentProject = getCurrentProject();

    if (currentProject && currentProjectTab) {
      currentProjectTab.textContent = currentProject.name;
    }
  }

  // Load the results: show the local cache at once, then the shared Firestore copy.
  // For the leader it also marks the project Analyzed, migrates old local-only results
  // and auto-approves clean requirements.
  async function loadSavedResults() {
    currentProject = getCurrentProject();

    if (!tableBody) return;

    if (!currentProject) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align:center;color:#6b6b7a;padding:32px;">
            No project selected.
          </td>
        </tr>
      `;
      return;
    }

    // Show any locally cached results immediately.
    const projectId = currentProject.id || currentProject.projectId || currentProject.documentId;
    if (!projectId) { renderTable([]); return; }
    let localResults = [];
    try {
      const cache = JSON.parse(localStorage.getItem("metras_project_results") || "{}");
      localResults = Array.isArray(cache[projectId]) ? cache[projectId] : [];
    } catch (error) { console.error("Could not read local analysis cache:", error); }
    renderTable(localResults);

    // Load the shared copy from Firestore.
    try {
      const user = await new Promise((resolve, reject) => {
        const unsubscribe = onAuthStateChanged(auth, user => { unsubscribe(); resolve(user); }, reject);
      });
      if (!user) return;
      const projectRef = doc(db, "projects", projectId);
      const projectSnapshot = await getDoc(projectRef);
      if (!projectSnapshot.exists()) throw new Error("Project not found in Firestore.");
      const resultRef = doc(db, "project_results", projectId);
      const resultSnapshot = await getDoc(resultRef);
      const isLeader = projectSnapshot.data().leaderEmail?.toLowerCase() === user.email?.toLowerCase();

      // Saved results found: show them, mark the project Analyzed, auto-approve clean rows.
      if (resultSnapshot.exists() && Array.isArray(resultSnapshot.data().results) && resultSnapshot.data().results.length) {
        renderTable(resultSnapshot.data().results);
        if (resultSnapshot.data().results.length && projectSnapshot.data().status === "Draft" && isLeader) {
          const batch = writeBatch(db);
          batch.update(projectRef, { status: "Analyzed", analyzedAt: serverTimestamp() });
          await batch.commit();
        }
        if (isLeader) await syncCleanRequirements(resultSnapshot.data().results, projectRef, projectSnapshot.data());
        return;
      }

      // Older versions saved results under another document id; reuse them once.
      const oldResults = await getDocs(query(collection(db, "project_results"), where("projectId", "==", projectId)));
      const existing = oldResults.docs.find(item => Array.isArray(item.data().results) && item.data().results.length);
      if (existing) {
        renderTable(existing.data().results);
        if (existing.data().results.length && projectSnapshot.data().status === "Draft" && isLeader) {
          const batch = writeBatch(db);
          batch.update(projectRef, { status: "Analyzed", analyzedAt: serverTimestamp() });
          await batch.commit();
        }
        if (isLeader) await syncCleanRequirements(existing.data().results, projectRef, projectSnapshot.data());
        return;
      }

      // Results exist only in this browser: upload them to Firestore (leader only).
      if (!localResults.length) return;
      if (!isLeader) return;
      const batch = writeBatch(db);
      batch.set(resultRef, { projectId, results: localResults, analyzedAt: serverTimestamp() });
      batch.update(projectRef, { status: "Analyzed", analyzedAt: serverTimestamp() });
      await batch.commit();
      currentProject.status = "Analyzed";
      localStorage.setItem("metras_current_project", JSON.stringify(currentProject));
      await syncCleanRequirements(localResults, projectRef, projectSnapshot.data());
    } catch (error) {
      console.error("Could not synchronize analysis results:", error);

      // Warn that the results are only stored in this browser.
      if (localResults.length) {
        tableBody.insertAdjacentHTML("beforebegin", '<p class="error-message">These results are only stored in this browser. Could not save them to Firestore; check permissions and reload.</p>');
      }
    }
  }

  // Keep one row per duplicate group (same rule as compare.js and the document export).
  function dedupeRows(rows) {
    const seenGroups = new Set();
    return (rows || []).filter((r) => {
      if (!r["Is Duplicate"]) return true;
      const group = r["Duplicate Group"];
      if (!seenGroups.has(group)) { seenGroups.add(group); return true; }
      return false;
    });
  }

  // A requirement is "clean" (no task needed) when its severity is Low and no CVE was
  // matched, or matching was "Not applicable" (e.g. a protective control).
  function isCleanRequirement(row) {
    const severity = row["Predicted Severity"];
    if (severity !== "Low") return false;

    const topCve = row["Top CVE"];
    const noCveMatch = row["CVE Mapped"] === false
      || (row["CVE Mapped"] === undefined && ["No strong semantic match", "Not applicable"].includes(topCve));

    return noCveMatch;
  }

  // Render the table; every non-clean row gets a Create Task button.
  function renderTable(rows) {
    if (!rows || rows.length === 0) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="8" style="text-align:center;color:#6b6b7a;padding:32px;">
            No saved results for this project yet.
            <a href="teamleader.html" style="color:#5861b5;font-weight:900;">
              Run an analysis first →
            </a>
          </td>
        </tr>
      `;
      return;
    }

    const filteredRows = dedupeRows(rows);

    // Remember the shown rows so each button can find its row by index.
    currentRows = filteredRows;

    tableBody.innerHTML = filteredRows.map((r, idx) => `
      <tr>
        <td>
          <div class="cell-wrap">
            ${escapeHtml(r["Requirement"] ?? "—")}
          </div>
        </td>

        <td>${chip(r["Security Posture"])}</td>
        <td>${chip(r["Risk Level"])}</td>
        <td>${chip(r["Predicted Severity"])}</td>

        <td>
          <div class="metric-stack">
            <span><strong>Impact:</strong> ${escapeHtml(r["Predicted Impact"] ?? "—")}</span>
            <span><strong>Likelihood:</strong> ${escapeHtml(r["Predicted Likelihood"] ?? "—")}</span>
          </div>
        </td>

        <td class="cve-cell">
          <span class="mono cve-value ${["No strong semantic match", "Not applicable"].includes(r["Top CVE"]) ? "no-match" : ""}"
                title="${escapeHtml(r["Top CVE"] ?? "—")}">
            ${escapeHtml(r["Top CVE"] === "No strong semantic match" ? "No strong match" : (r["Top CVE"] ?? "—"))}
          </span>
          <div class="cve-meta">
            <span>Similarity: ${escapeHtml(fmtSim(r["Similarity"]))}</span>
            <span>Confidence: ${escapeHtml(r["CVE Match Confidence"] ?? "—")}</span>
          </div>
        </td>

        <td>
          <div class="cell-wrap interpretation-text">
            ${escapeHtml(r["CVE Match Interpretation"] ?? "No interpretation available.")}
          </div>
          <div class="cell-wrap cell-muted cve-description">
            ${escapeHtml(r["CVE Description"] ?? "No CVE description is applicable to this requirement.")}
          </div>
        </td>

        <td>
          ${isCleanRequirement(r)
            ? `<span style="font-size:11px;color:#6ee7a8;white-space:nowrap;" title="No security risk detected — automatically counted as resolved, no task needed.">✓ No risk detected</span>`
            : `<button class="btn btn-secondary" style="font-size:12px;padding:6px 12px;white-space:nowrap;" data-row-index="${idx}">
                + Create Task
              </button>`}
        </td>
      </tr>
    `).join("");

    // Wire the Create Task buttons.
    tableBody.querySelectorAll("[data-row-index]").forEach(btn => {
      btn.addEventListener("click", () => {
        const row = currentRows[Number(btn.dataset.rowIndex)];
        openTaskModal(row);
      });
    });
  }

  // Coloured chip for a level, e.g. "High Risk" -> chip-high.
  function chip(level) {
    if (!level) return '<span class="chip">—</span>';

    const normalized = level.toString().toLowerCase().split(/\s+/)[0];

    return `
      <span class="chip chip-${escapeHtml(normalized)}">
        ${escapeHtml(level)}
      </span>
    `;
  }

  // Similarity with 3 decimals.
  function fmtSim(n) {
    return Number.isFinite(Number(n)) ? Number(n).toFixed(3) : String(n ?? "—");
  }

  // Add clean requirements to the project's approvedRequirements (the same list task
  // approvals use) so they count as resolved on the Compare page and in the exported
  // document. Safe to repeat: only missing requirements are added.
  async function syncCleanRequirements(rows, projectRef, project) {
    try {
      const cleanRows = dedupeRows(rows).filter(isCleanRequirement);
      if (!cleanRows.length) return;

      const existingApproved = Array.isArray(project.approvedRequirements) ? project.approvedRequirements : [];
      const alreadyCovered = new Set(
        existingApproved.map(entry => (entry.originalRequirementText || "").trim())
      );

      const newEntries = cleanRows
        .filter(row => !alreadyCovered.has((row["Requirement"] || "").trim()))
        .map(row => ({
          requirementText: row["Requirement"] || "",
          originalRequirementText: row["Requirement"] || "",
          mitigationExplanation: "No action needed — no security risk was detected in this requirement.",
          taskId: null,
          taskTitle: "No risk detected",
          cveId: null,
          contributedBy: "Automatic (no risk detected)",
          approvedAt: new Date().toISOString(),
          autoApproved: true
        }));

      if (!newEntries.length) return;

      const updatedApproved = [...existingApproved, ...newEntries];
      await updateDoc(projectRef, { approvedRequirements: updatedApproved, updatedAt: serverTimestamp() });

      if (currentProject) {
        currentProject.approvedRequirements = updatedApproved;
        localStorage.setItem("metras_current_project", JSON.stringify(currentProject));
      }
    } catch (error) {
      // Fails quietly for non-leaders: Firestore rules let only the leader update this list.
      console.warn("Could not auto-sync clean requirements:", error);
    }
  }

  // Active project cached by the Projects page.
  function getCurrentProject() {
    try {
      return JSON.parse(localStorage.getItem("metras_current_project"));
    } catch {
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Create Task modal
  // --------------------------------------------------------------------------
  // Wire the modal buttons and the title picker.
  function initTaskModal() {
    const modal        = document.getElementById("createTaskModal");
    const closeBtn      = document.getElementById("closeTaskModal");
    const cancelBtn      = document.getElementById("cancelTask");
    const saveBtn        = document.getElementById("saveTask");
    const titleCategory  = document.getElementById("taskTitleCategory");
    const titleCustom    = document.getElementById("taskTitleCustom");

    closeBtn?.addEventListener("click", closeTaskModal);
    cancelBtn?.addEventListener("click", closeTaskModal);
    modal?.addEventListener("click", (e) => { if (e.target === modal) closeTaskModal(); });

    saveBtn?.addEventListener("click", handleSaveTask);

    // "Custom..." shows a free-text title; otherwise the selected option is the title.
    titleCategory?.addEventListener("change", () => {
      syncTaskTitleFromCategory();
    });
    titleCustom?.addEventListener("input", () => {
      document.getElementById("taskTitle").value = titleCustom.value.trim();
    });
  }

  // Copy the chosen category (or custom text) into the hidden taskTitle field.
  function syncTaskTitleFromCategory() {
    const titleCategory = document.getElementById("taskTitleCategory");
    const titleCustom    = document.getElementById("taskTitleCustom");
    const titleHidden     = document.getElementById("taskTitle");

    if (titleCategory.value === "__custom__") {
      titleCustom.hidden = false;
      titleHidden.value = titleCustom.value.trim();
    } else {
      titleCustom.hidden = true;
      titleHidden.value = titleCategory.value;
    }
  }

  // Title categories with keywords mirroring the backend's SECURITY_CONCEPTS, so the
  // suggested title matches how the AI classified the weakness.
  const TITLE_CATEGORY_KEYWORDS = [
    { value: "Fix Authentication / Password Issue", keywords: ["password", "credential", "authentication", "plaintext", "passphrase", "mfa", "login"] },
    { value: "Fix Encryption Issue",                keywords: ["encrypt", "crypto", "tls", "ssl", "cipher", "decrypt", "key"] },
    { value: "Fix Injection Vulnerability",         keywords: ["injection", "sql", "xss", "command", "sanitize", "query"] },
    { value: "Fix Access Control Issue",            keywords: ["access", "privilege", "authorization", "permission", "role", "rbac"] },
    { value: "Improve Logging & Monitoring",        keywords: ["log", "audit", "monitor", "record", "trail"] },
    { value: "Fix Session Management Issue",        keywords: ["session", "token", "cookie", "timeout", "expiry"] },
    { value: "Fix Data Exposure Issue",              keywords: ["exposure", "disclosure", "sensitive", "leak", "personal", "pii"] },
    { value: "Fix File Upload Vulnerability",       keywords: ["upload", "file", "path", "directory", "traversal"] },
    { value: "Fix API Security Issue",               keywords: ["api", "endpoint", "request", "response", "rest"] },
    { value: "Fix Denial of Service Risk",           keywords: ["denial", "dos", "ddos", "availability", "flood", "rate limit"] },
    { value: "Fix Data Integrity Issue",             keywords: ["integrity", "tamper", "checksum", "hash", "signature"] },
    { value: "Fix Network Security Issue",           keywords: ["network", "firewall", "port", "protocol", "traffic"] },
    { value: "Fix Third-Party Component Risk",       keywords: ["third party", "library", "dependency", "plugin", "component"] }
  ];

  // Suggest a task title from keywords in the requirement and CVE description.
  function guessTitleCategory(row) {
    const text = `${row["Requirement"] || ""} ${row["CVE Description"] || ""}`.toLowerCase();
    for (const category of TITLE_CATEGORY_KEYWORDS) {
      if (category.keywords.some(kw => text.includes(kw))) {
        return category.value;
      }
    }
    return "General Security Review";
  }

  // Open the modal pre-filled from a result row: title, description, priority,
  // a 7-day deadline and the project members as assignee checkboxes.
  function openTaskModal(row) {
    const project = getCurrentProject();
    const modal   = document.getElementById("createTaskModal");
    const error   = document.getElementById("taskError");
    const success = document.getElementById("taskSuccess");

    error.hidden = true;
    success.hidden = true;

    if (!project) {
      alert("No project selected. Please select a project first.");
      return;
    }

    // Suggested title category (the leader can change it).
    const titleCategory = document.getElementById("taskTitleCategory");
    const titleCustom    = document.getElementById("taskTitleCustom");
    titleCustom.value = "";
    titleCustom.hidden = true;
    titleCategory.value = guessTitleCategory(row);
    syncTaskTitleFromCategory();

    // Description = requirement text + related CVE.
    const descParts = [row["Requirement"] || ""];
    if (row["CVE Description"]) {
      descParts.push(`\n\nRelated CVE (${row["Top CVE"]}): ${row["CVE Description"]}`);
    }
    document.getElementById("taskDescription").value = descParts.join("");

    // Priority from the predicted severity.
    const severityToPriority = {
      "Critical": "High",
      "High":     "High",
      "Medium":   "Medium",
      "Low":      "Low"
    };
    document.getElementById("taskPriority").value =
      severityToPriority[row["Predicted Severity"]] || "Medium";

    // Default deadline: 7 days from today.
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 7);
    const deadlineInput = document.getElementById("taskDeadline");
    deadlineInput.min = localDateString(new Date());
    deadlineInput.value = localDateString(deadline);

    // Assignee checkboxes; everyone checked shares one task.
    const assigneeList = document.getElementById("taskAssigneeList");
    const members = project.members || [];

    if (members.length === 0) {
      assigneeList.innerHTML = '<span class="field-help">No team members added to this project</span>';
    } else {
      assigneeList.innerHTML = members.map((m, i) => `
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
          <input type="checkbox" class="task-assignee-checkbox" value="${escapeHtml(m.email)}" id="assignee_${i}">
          <span>${escapeHtml(m.name)} <span style="color:var(--muted,#8a8fa3);">(${escapeHtml(m.email)})</span></span>
        </label>
      `).join("");
    }

    // Keep the source row on the modal for handleSaveTask().
    modal.dataset.sourceRow = JSON.stringify(row);

    modal.style.display = "flex";
  }

  // Close and reset the modal.
  function closeTaskModal() {
    const modal = document.getElementById("createTaskModal");
    modal.style.display = "none";
    modal.dataset.sourceRow = "";
  }

  // Validate the form and save the task to Firestore.
  async function handleSaveTask() {
    const modal   = document.getElementById("createTaskModal");
    const error   = document.getElementById("taskError");
    const success = document.getElementById("taskSuccess");
    const project = getCurrentProject();

    error.hidden = true;
    success.hidden = true;

    // Re-sync the title in case the category changed without a change event.
    syncTaskTitleFromCategory();

    const title       = document.getElementById("taskTitle").value.trim();
    const description = document.getElementById("taskDescription").value.trim();
    const assigneeEmails = Array.from(document.querySelectorAll(".task-assignee-checkbox:checked"))
      .map(cb => String(cb.value || "").trim().toLowerCase())
      .filter(Boolean);
    const priority     = document.getElementById("taskPriority").value;
    const deadline     = document.getElementById("taskDeadline").value;

    // Validation: title, at least one assignee and a deadline.
    if (!title) {
      showTaskError(error, document.getElementById("taskTitleCategory").value === "__custom__"
        ? "Please type a custom task title."
        : "Please select a task title.");
      return;
    }
    if (!assigneeEmails.length) {
      showTaskError(error, "Please select at least one team member to assign this task to.");
      return;
    }
    if (!deadline) {
      showTaskError(error, "Please set a deadline.");
      return;
    }
    if (deadline < localDateString(new Date())) {
      showTaskError(error, "The deadline cannot be before today.");
      return;
    }

    // Full { name, email } objects of the selected members.
    const assignedMembers = (project.members || [])
      .filter(m => assigneeEmails.includes(String(m.email || "").trim().toLowerCase()))
      .map(m => ({ ...m, email: String(m.email || "").trim().toLowerCase() }));
    if (!assignedMembers.length) {
      showTaskError(error, "The selected member could not be matched. Refresh the page and try again.");
      return;
    }

    // Severity and CVE of the source row.
    let sourceRow = {};
    try { sourceRow = JSON.parse(modal.dataset.sourceRow || "{}"); } catch (_) {}

    // New task document. Firestore generates its id (no "id" field is stored).
    // All assignees share one draft (revisedRequirement + mitigationExplanation) and one
    // discussion thread instead of separate answers.
    const newTask = {
      title,
      description,

      // Exact original text, used later to swap in the approved revision when exporting.
      originalRequirementText: sourceRow["Requirement"] || "",
      projectId:    project.id,
      projectName:  project.name,
      assignedTo:   assignedMembers,
      assignedEmails: assignedMembers.map(m => String(m.email).toLowerCase()),
      createdBy:    project.leaderEmail || "",
      priority,

      // Status flow: Assigned -> In Progress -> For Review -> Done.
      status: "Assigned",
      deadline,
      severity:     sourceRow["Predicted Severity"] || null,
      cveId:        sourceRow["Top CVE"] || null,

      // Shared draft edited by all assignees.
      revisedRequirement: "",
      mitigationExplanation: "",
      lastEditedBy: "",
      lastEditedByName: "",
      lastEditedAt: null,

      // Team discussion thread.
      discussion: []
    };

    try {
      await saveTask(newTask);
    } catch (saveError) {
      console.error("Failed to save task:", saveError);
      showTaskError(error, "Failed to save the task. Please try again.");
      return;
    }

    success.textContent = `✅ Task assigned to ${assignedMembers.map(m => m.name || m.email).join(", ")}.`;
    success.hidden = false;

    setTimeout(() => {
      closeTaskModal();
    }, 1200);
  }

  // Show a validation error in the modal.
  function showTaskError(el, msg) {
    el.textContent = msg;
    el.hidden = false;
  }

  // --------------------------------------------------------------------------
  // Firestore task storage
  // --------------------------------------------------------------------------
  // Save a new task with created/updated timestamps.
  async function saveTask(task) {
    await addDoc(collection(db, "tasks"), {
      ...task,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
  }

  // --------------------------------------------------------------------------
  // Column info icons, drawer and helpers
  // --------------------------------------------------------------------------
  // Explain each results column through the "i" icons in the table header.
  function initColumnInfoTooltips() {
    const columnHelp = {
      colInfoRequirement: "The exact requirement text extracted from your uploaded document.",
      colInfoPosture: "Risk-indicating means the wording introduces a weakness; Protective control reduces risk; Neutral describes ordinary functionality.",
      colInfoRisk: "Overall risk calculated from Impact × Likelihood. Protective and ordinary neutral requirements remain Low unless their wording introduces a weakness.",
      colInfoSeverity: "How severe the weakness is. Protective controls and neutral functionality stay Low even when a CVE is shown only as context.",
      colInfoAssessment: "Impact estimates potential damage; Likelihood estimates exploitation probability using CVE exploitability and requirement wording.",
      colInfoCve: "The closest NVD reference found by semantic and CWE-aware matching. Similarity is not proof that the project contains the vulnerability.",
      colInfoInterpretation: "Explains whether the CVE is potential vulnerability evidence, contextual awareness only, or not applicable because the requirement is a protective control."
    };

    Object.entries(columnHelp).forEach(([id, text]) => {
      attachInfoTooltip(document.getElementById(id), `<strong>${escapeHtml(document.getElementById(id)?.closest("th")?.childNodes[0]?.textContent?.trim() || "")}</strong><div style="margin-top:6px;">${escapeHtml(text)}</div>`);
    });
  }

  // Open/close the mobile navigation drawer.
  function initDrawer() {
    const btnMenu = document.getElementById("btnMenu");
    const btnCloseDrawer = document.getElementById("btnCloseDrawer");
    const drawer = document.getElementById("drawer");
    const backdrop = document.getElementById("backdrop");

    btnMenu?.addEventListener("click", () => {
      drawer.classList.add("open");
      drawer.setAttribute("aria-hidden", "false");
      backdrop.hidden = false;
    });

    btnCloseDrawer?.addEventListener("click", () => {
      drawer.classList.remove("open");
      drawer.setAttribute("aria-hidden", "true");
      backdrop.hidden = true;
    });

    backdrop?.addEventListener("click", () => {
      drawer.classList.remove("open");
      drawer.setAttribute("aria-hidden", "true");
      backdrop.hidden = true;
    });
  }

  // Escape text before inserting it into HTML (prevents XSS).
  function localDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text ?? "";
    return div.innerHTML;
  }
});
