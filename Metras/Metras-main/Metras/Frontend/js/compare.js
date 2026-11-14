// compare.js - Before/after comparison dashboard (compare.html?projectId=...), leader only.
// Compares the original analysis with the approved fixes: totals, resolved vs
// unresolved, estimated risk reduction, new risks found by the re-check, an overall
// security score, and Chart.js charts by severity, impact, likelihood, task status
// and time.

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import { getFirestore, doc, getDoc, collection, query, where, getDocs } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
import { attachInfoTooltip } from "./info-tooltip.js";
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

// Severity weights for the risk score, and the display order of each level.
const SEVERITY_WEIGHT = { "Critical": 4, "High": 3, "Medium": 2, "Low": 1 };
const SEVERITY_ORDER = ["Critical", "High", "Medium", "Low"];
const IMPACT_ORDER = ["High", "Medium", "Low"];
const LIKELIHOOD_ORDER = ["High", "Medium", "Low"];


// ----------------------------------------------------------------------------
// Page setup: drawer, back link, logout and the explanation tooltips
// ----------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  initDrawer();
  document.getElementById("backToProjectTasks")?.setAttribute("href", `project-tasks.html?projectId=${encodeURIComponent(projectId || "")}`);
  attachInfoTooltip(document.getElementById("resolvedInfoIcon"), `
    <strong>"Fix approved" doesn't mean "verified clean"</strong>
    <div style="margin-top:6px;">
      This counts requirements that have an approved fix from the task workflow. It does not by itself mean
      the fix is risk-free — check "New risks detected" below for that.
    </div>
  `);

  attachInfoTooltip(document.getElementById("riskInfoIcon"), `
    <strong>How this is estimated</strong>
    <div style="margin-top:6px;">
      Each requirement's severity (Critical=4, High=3, Medium=2, Low=1) is summed to get a total risk score.
      Requirements with an approved fix are assumed to no longer carry their original risk.
    </div>
  `);

  attachInfoTooltip(document.getElementById("newRiskInfoIcon"), `
    <strong>What "new risks" means</strong>
    <div style="margin-top:6px;">
      When the leader approves a task, METRAS automatically re-runs the same AI analysis on the team's
      revised wording. If that revised text still semantically matches a real CVE at Critical or High
      severity, it's flagged here — meaning the fix may not have fully resolved the issue, or could have
      introduced a related one.
    </div>
  `);

  attachInfoTooltip(document.getElementById("newRiskChartInfoIcon"), `
    <strong>How a fix is classified</strong>
    <div style="margin-top:6px;">
      When a task is approved, its revised wording is re-analyzed. A fix is flagged
      <em>New risk detected</em> only if it still matches a real CVE <strong>and</strong> its severity is
      <strong>Critical or High</strong>.
    </div>
    <div style="margin-top:6px;">
      Every other checked fix is counted as <em>No new Critical/High risk</em>. That includes fixes that
      still score Medium or Low, so it does not mean the fix has no risk at all.
      <em>Not checked yet</em> means no result was stored (for example, the backend was offline).
    </div>
  `);

  attachInfoTooltip(document.getElementById("scoreInfoIcon"), `
    <strong>How the score is calculated</strong>
    <div style="margin-top:6px;">
      Average of up to three percentages: the share of requirements with an approved fix, the estimated
      risk reduction, and — once at least one fix has been checked — the share of checked fixes with no
      new risk detected. It's a simple blended indicator, not a formal security rating.
    </div>
  `);
});

// ----------------------------------------------------------------------------
// Auth guard: load the comparison
// ----------------------------------------------------------------------------
requireRole(auth, db, ["leader"]).then(async ({ user }) => {
  if (!projectId) {
    showEmpty("No project was selected.");
    return;
  }
  await loadComparison(user.email.toLowerCase());
});

// ----------------------------------------------------------------------------
// Calculations
// ----------------------------------------------------------------------------
// Load the project, results, approvals and tasks; compute all figures; render.
async function loadComparison(userEmail) {
  try {
    const projectSnap = await getDoc(doc(db, "projects", projectId));
    if (!projectSnap.exists()) {
      showEmpty("This project does not exist.");
      return;
    }
    const project = projectSnap.data();
    if ((project.leaderEmail || "").toLowerCase() !== userEmail) {
      showEmpty("You do not have permission to view this project's comparison.");
      return;
    }

    document.getElementById("compareProjectName").textContent = project.name || "Unnamed Project";

    const resultSnap = await getDoc(doc(db, "project_results", projectId));
    const originalRows = resultSnap.exists() && Array.isArray(resultSnap.data().results) ? resultSnap.data().results : [];
    const approved = Array.isArray(project.approvedRequirements) ? project.approvedRequirements : [];

    if (!originalRows.length) {
      showEmpty("No analyzed requirements yet. Run an analysis first, then come back here.");
      return;
    }

    // Remove duplicates (same rule as the Results table and the document export).
    const seenGroups = new Set();
    const uniqueRows = originalRows.filter(r => {
      if (!r["Is Duplicate"]) return true;
      const group = r["Duplicate Group"];
      if (!seenGroups.has(group)) { seenGroups.add(group); return true; }
      return false;
    });

    // Latest approved revision per original requirement (same rule as the document export).
    const approvedByOriginalText = new Map();
    approved.forEach(entry => {
      const key = (entry.originalRequirementText || "").trim();
      if (!key) return;
      const existing = approvedByOriginalText.get(key);
      if (!existing || new Date(entry.approvedAt || 0) > new Date(existing.approvedAt || 0)) {
        approvedByOriginalText.set(key, entry);
      }
    });

    // Counters per level, split into resolved / unresolved.
    let resolvedCount = 0;
    const bySeverity = {};
    SEVERITY_ORDER.forEach(level => { bySeverity[level] = { resolved: 0, unresolved: 0 }; });
    const byImpact = {};
    IMPACT_ORDER.forEach(level => { byImpact[level] = { resolved: 0, unresolved: 0 }; });
    const byLikelihood = {};
    LIKELIHOOD_ORDER.forEach(level => { byLikelihood[level] = { resolved: 0, unresolved: 0 }; });

    // Risk score = sum of severity weights; resolved requirements no longer count.
    let riskBefore = 0;
    let riskAfter = 0;

    uniqueRows.forEach(row => {
      const originalText = (row.Requirement || row.requirement || "").trim();
      const isResolved = approvedByOriginalText.has(originalText);

      const severity = SEVERITY_ORDER.includes(row["Predicted Severity"]) ? row["Predicted Severity"] : "Low";
      const impact = IMPACT_ORDER.includes(row["Predicted Impact"]) ? row["Predicted Impact"] : "Low";
      const likelihood = LIKELIHOOD_ORDER.includes(row["Predicted Likelihood"]) ? row["Predicted Likelihood"] : "Low";
      const weight = SEVERITY_WEIGHT[severity] || 1;

      riskBefore += weight;
      if (!isResolved) riskAfter += weight;

      const bucket = isResolved ? "resolved" : "unresolved";
      bySeverity[severity][bucket]++;
      byImpact[impact][bucket]++;
      byLikelihood[likelihood][bucket]++;

      if (isResolved) resolvedCount++;
    });

    // Percentages.
    const total = uniqueRows.length;
    const unresolvedCount = total - resolvedCount;
    const riskReductionPct = riskBefore > 0 ? Math.round(((riskBefore - riskAfter) / riskBefore) * 100) : 0;
    const resolutionPct = total > 0 ? Math.round((resolvedCount / total) * 100) : 0;

    // New-risk check: entries approved before this feature have no result and count as
    // "not checked" rather than clean.
    const checkedEntries = approved.filter(entry => entry.newSeverity !== undefined && entry.newSeverity !== null);
    const flaggedEntries = approved.filter(entry => entry.newRiskFlagged);
    const cleanCount = checkedEntries.length - flaggedEntries.length;
    const cleanFixPct = checkedEntries.length > 0 ? Math.round((cleanCount / checkedEntries.length) * 100) : null;

    // Overall score = average of resolution %, risk reduction % and - once something was
    // checked - clean-fix %, so an untouched project is not inflated.
    const scoreComponents = [resolutionPct, riskReductionPct];
    if (cleanFixPct !== null) scoreComponents.push(cleanFixPct);
    const overallScore = Math.round(scoreComponents.reduce((a, b) => a + b, 0) / scoreComponents.length);

    // Timeline: cumulative number of approved fixes per date.
    const sortedApprovals = [...approved]
      .filter(entry => entry.approvedAt)
      .sort((a, b) => new Date(a.approvedAt) - new Date(b.approvedAt));
    const timelinePoints = [];
    let runningCount = 0;
    sortedApprovals.forEach(entry => {
      runningCount++;
      const dateLabel = new Date(entry.approvedAt).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
      timelinePoints.push({ label: dateLabel, value: runningCount });
    });

    // Live task status counts.
    const tasksSnap = await getDocs(query(collection(db, "tasks"), where("projectId", "==", projectId)));
    const statusCounts = { "Assigned": 0, "In Progress": 0, "For Review": 0, "Done": 0 };
    tasksSnap.forEach(taskDoc => {
      const status = taskDoc.data().status;
      if (status in statusCounts) statusCounts[status]++;
    });

    const latestData = {
      total, resolvedCount, unresolvedCount, riskReductionPct, resolutionPct,
      bySeverity, byImpact, byLikelihood, statusCounts,
      newRisksCount: flaggedEntries.length,
      cleanCount, checkedCount: checkedEntries.length,
      flaggedEntries, timelinePoints, overallScore
    };

    renderDashboard(latestData);

  } catch (error) {
    console.error("Failed to load comparison:", error);
    showEmpty("Unable to load the comparison. Please refresh.");
  }
}

// ----------------------------------------------------------------------------
// Rendering
// ----------------------------------------------------------------------------
// Fill the stat cards and draw every chart.
function renderDashboard(data) {
  document.getElementById("compareEmpty").hidden = true;
  document.getElementById("compareContent").hidden = false;

  document.getElementById("statTotal").textContent = data.total;
  document.getElementById("statResolved").textContent = data.resolvedCount;
  document.getElementById("statUnresolved").textContent = data.unresolvedCount;
  document.getElementById("statRiskReduction").textContent = `${data.riskReductionPct}%`;
  document.getElementById("statNewRisks").textContent = data.newRisksCount;

  renderSecurityGauge(data.overallScore);
  renderResolutionTimeline(data.timelinePoints);

  renderComparisonBar("severityBar", "severityLegend", SEVERITY_ORDER, data.bySeverity);
  renderComparisonBar("impactBar", "impactLegend", IMPACT_ORDER, data.byImpact);
  renderComparisonBar("likelihoodBar", "likelihoodLegend", LIKELIHOOD_ORDER, data.byLikelihood);

  const statusColors = { "Assigned": "#a5a8b8", "In Progress": "#ffbd66", "For Review": "#8b94e8", "Done": "#6ee7a8" };
  const statusLabels = Object.keys(data.statusCounts);
  const statusValues = statusLabels.map(l => data.statusCounts[l]);
  renderLegend("taskStatusLegend", statusLabels.map(l => ({ color: statusColors[l], label: `${l} ${data.statusCounts[l]}` })));
  destroyChart("taskStatusDonut");
  chartInstances.taskStatusDonut = new Chart(document.getElementById("taskStatusDonut"), {
    type: "doughnut",
    data: {
      labels: statusLabels,
      datasets: [{ data: statusValues, backgroundColor: statusLabels.map(l => statusColors[l]), borderWidth: 0 }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
  });

  renderNewRiskChart(data);
  renderFlaggedList(data.flaggedEntries);
}

// Chart.js instances by canvas id. Old charts are destroyed before redrawing
// because Chart.js cannot reuse a canvas that still holds a chart.
const chartInstances = {};
function destroyChart(canvasId) {
  chartInstances[canvasId]?.destroy();
}

// Half-doughnut gauge: green 70%+, orange 40-69%, red below 40%.
function renderSecurityGauge(score) {
  document.getElementById("securityScoreValue").textContent = `${score}%`;
  const color = score >= 70 ? "#6ee7a8" : score >= 40 ? "#ffbd66" : "#ff8a96";

  destroyChart("securityGauge");
  chartInstances.securityGauge = new Chart(document.getElementById("securityGauge"), {
    type: "doughnut",
    data: {
      labels: ["Score", "Remaining"],
      datasets: [{ data: [score, 100 - score], backgroundColor: [color, "rgba(255,255,255,.08)"], borderWidth: 0 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      circumference: 180, rotation: 270,
      cutout: "75%",
      plugins: { legend: { display: false }, tooltip: { enabled: false } }
    }
  });
}

// Line chart of cumulative approved fixes (placeholder when there are none).
function renderResolutionTimeline(points) {
  destroyChart("resolutionTimeline");

  if (!points.length) {
    chartInstances.resolutionTimeline = new Chart(document.getElementById("resolutionTimeline"), {
      type: "line",
      data: { labels: ["No approvals yet"], datasets: [{ data: [0], borderColor: "#5861b5", tension: 0.3 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
    return;
  }

  chartInstances.resolutionTimeline = new Chart(document.getElementById("resolutionTimeline"), {
    type: "line",
    data: {
      labels: points.map(p => p.label),
      datasets: [{
        label: "Cumulative approved fixes",
        data: points.map(p => p.value),
        borderColor: "#8b94e8",
        backgroundColor: "rgba(139,148,232,.15)",
        fill: true,
        tension: 0.3,
        pointBackgroundColor: "#8b94e8",
        pointRadius: 4
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true, ticks: { stepSize: 1, color: "#a5a8b8" }, grid: { color: "rgba(255,255,255,.06)" } },
        x: { ticks: { color: "#a5a8b8" }, grid: { display: false } }
      },
      plugins: { legend: { display: false } }
    }
  });
}

// Grouped bars per level: has approved fix vs no fix yet.
function renderComparisonBar(canvasId, legendId, labels, breakdown) {
  renderLegend(legendId, [
    { color: "#6ee7a8", label: "Has approved fix" },
    { color: "#ff8a96", label: "No fix yet" }
  ]);

  destroyChart(canvasId);
  chartInstances[canvasId] = new Chart(document.getElementById(canvasId), {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "Has approved fix", data: labels.map(level => breakdown[level].resolved), backgroundColor: "#6ee7a8", borderRadius: 4 },
        { label: "No fix yet", data: labels.map(level => breakdown[level].unresolved), backgroundColor: "#ff8a96", borderRadius: 4 }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      scales: {
        y: { beginAtZero: true, ticks: { stepSize: 1, color: "#a5a8b8" }, grid: { color: "rgba(255,255,255,.06)" } },
        x: { ticks: { color: "#a5a8b8" }, grid: { display: false } }
      },
      plugins: { legend: { display: false } }
    }
  });
}

// Doughnut of approved fixes: no new Critical/High risk, new risk detected, not checked yet.
function renderNewRiskChart(data) {
  const uncheckedCount = Math.max(0, data.resolvedCount - data.checkedCount);
  const segments = [
    { label: "No new Critical/High risk", value: data.cleanCount, color: "#6ee7a8" },
    { label: "New risk detected", value: data.newRisksCount, color: "#ff8a96" }
  ];
  if (uncheckedCount > 0) {
    segments.push({ label: "Not checked yet", value: uncheckedCount, color: "#a5a8b8" });
  }

  destroyChart("newRiskDonut");

  if (data.checkedCount === 0) {
    renderLegend("newRiskLegend", [{ color: "#a5a8b8", label: "No approved fixes have been checked yet" }]);
    chartInstances.newRiskDonut = new Chart(document.getElementById("newRiskDonut"), {
      type: "doughnut",
      data: { labels: ["No data"], datasets: [{ data: [1], backgroundColor: ["#3a3f55"], borderWidth: 0 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
    });
    return;
  }

  renderLegend("newRiskLegend", segments.map(s => ({ color: s.color, label: `${s.label} ${s.value}` })));
  chartInstances.newRiskDonut = new Chart(document.getElementById("newRiskDonut"), {
    type: "doughnut",
    data: {
      labels: segments.map(s => s.label),
      datasets: [{ data: segments.map(s => s.value), backgroundColor: segments.map(s => s.color), borderWidth: 0 }]
    },
    options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } } }
  });
}

// Detail cards for fixes that still match a Critical/High CVE.
function renderFlaggedList(flaggedEntries) {
  const container = document.getElementById("flaggedList");
  if (!container) return;

  if (!flaggedEntries.length) {
    container.innerHTML = '<p class="field-help">No new risks detected in the approved fixes so far — nice work.</p>';
    return;
  }

  // Most severe first.
  const severityRank = { "Critical": 0, "High": 1, "Medium": 2, "Low": 3 };
  const sorted = [...flaggedEntries].sort((a, b) =>
    (severityRank[a.newSeverity] ?? 9) - (severityRank[b.newSeverity] ?? 9)
  );

  container.innerHTML = sorted.map((entry, index) => `
    <div class="flagged-item" data-task-id="${escapeAttr(entry.taskId || "")}" style="background:rgba(255,138,150,.06);border:1px solid rgba(255,138,150,.25);border-radius:14px;padding:16px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:10px;">
        <p style="margin:0;font-size:13px;font-weight:800;color:#ff8a96;">⚠ ${escapeHtml(entry.taskTitle || "Approved fix")}</p>
        <span class="chip chip-${(entry.newSeverity || "high").toLowerCase()}">${escapeHtml(entry.newSeverity || "High")}</span>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:10px;">
        <div>
          <p style="margin:0 0 3px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);">Original requirement</p>
          <p style="margin:0;font-size:12px;white-space:pre-wrap;">${escapeHtml(entry.originalRequirementText || "—")}</p>
        </div>
        <div>
          <p style="margin:0 0 3px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);">Approved revision</p>
          <p style="margin:0;font-size:12px;white-space:pre-wrap;">${escapeHtml(entry.requirementText || "—")}</p>
        </div>
      </div>

      <div style="margin-bottom:10px;">
        <p style="margin:0 0 3px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);">Team's mitigation explanation</p>
        <p style="margin:0;font-size:12px;white-space:pre-wrap;">${escapeHtml(entry.mitigationExplanation || "—")}</p>
      </div>

      <div style="margin-bottom:10px;">
        <p style="margin:0 0 3px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);">Still matches</p>
        <p style="margin:0;font-size:12px;">
          <strong>${escapeHtml(entry.newTopCve || "a CVE")}</strong> — similarity ${entry.newSimilarity != null ? Number(entry.newSimilarity).toFixed(2) : "—"}
        </p>
        ${entry.newCveDescription ? `<p style="margin:4px 0 0;font-size:11px;color:var(--muted);">${escapeHtml(entry.newCveDescription)}</p>` : ""}
      </div>

      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;font-size:11px;color:var(--muted);">
        <span>Approved by ${escapeHtml(entry.contributedBy || "team")} on ${escapeHtml(entry.approvedAt ? new Date(entry.approvedAt).toLocaleDateString("en-GB") : "—")}</span>
      </div>
    </div>
  `).join("");

}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
// Coloured legend under a chart.
function renderLegend(containerId, items) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = items.map(item => `
    <span style="display:flex;align-items:center;gap:6px;">
      <span style="width:10px;height:10px;border-radius:3px;background:${item.color};display:inline-block;"></span>${escapeHtml(item.label)}
    </span>
  `).join("");
}

// Show a message instead of the dashboard.
function showEmpty(message) {
  document.getElementById("compareContent").hidden = true;
  const empty = document.getElementById("compareEmpty");
  empty.textContent = message;
  empty.hidden = false;
}

// Escape text before inserting it into HTML (prevents XSS).
function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text ?? "";
  return div.innerHTML;
}
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
