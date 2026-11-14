// teamleader.js - Risk Assessment page (teamleader.html), leader only.
// The leader uploads a PDF/TXT and/or pastes requirements. The page checks that the
// user leads the selected project, sends the input to the backend /analyze endpoint,
// saves the results to Firestore (project_results) and marks the project "Analyzed",
// then opens the Results page.

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getFirestore, doc, getDoc, writeBatch, serverTimestamp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
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
const db  = getFirestore(app);
const auth = getAuth(app);

// Every logout link signs out and clears cached session data.
setupLogout();

// Only leaders may open the Risk Assessment page.
requireRole(auth, db, ["leader"]);

// ----------------------------------------------------------------------------
// Page setup
// ----------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
  initDrawer();
  loadCurrentProjectName();
  initInputs();
  initAnalyzeButton();
});

// File chosen in the upload box.
let selectedFile = null;

// Show the active project's name in the sub-bar.
function loadCurrentProjectName() {
  const currentProjectTab = document.getElementById("currentProjectTab");
  const currentProject = getCurrentProject();

  if (currentProject && currentProjectTab) {
    currentProjectTab.textContent = currentProject.name;
  }
}

// Wire the file picker, the text box and their Clear buttons.
function initInputs() {
  const reqFile = document.getElementById("reqFile");
  const fileMeta = document.getElementById("fileMeta");
  const fileHint = document.getElementById("fileHint");
  const btnClearFile = document.getElementById("btnClearFile");

  const reqText = document.getElementById("reqText");
  const textMeta = document.getElementById("textMeta");
  const btnClearText = document.getElementById("btnClearText");

  reqFile?.addEventListener("change", () => {
    selectedFile = reqFile.files[0] || null;

    if (selectedFile) {
      fileMeta.textContent = selectedFile.name;
      fileHint.textContent = "File selected";
    } else {
      fileMeta.textContent = "No file selected";
      fileHint.textContent = "Drag & drop or click to select";
    }
  });

  btnClearFile?.addEventListener("click", () => {
    selectedFile = null;

    if (reqFile) reqFile.value = "";
    if (fileMeta) fileMeta.textContent = "No file selected";
    if (fileHint) fileHint.textContent = "Drag & drop or click to select";
  });

  reqText?.addEventListener("input", () => {
    if (textMeta) {
      textMeta.textContent = `${reqText.value.length} characters`;
    }
  });

  btnClearText?.addEventListener("click", () => {
    if (reqText) reqText.value = "";
    if (textMeta) textMeta.textContent = "0 characters";
  });
}

// Wire the "Use Sample" and "Start Analysis" buttons.
function initAnalyzeButton() {
  const btnAnalyze = document.getElementById("btnAnalyze");
  const btnUseSample = document.getElementById("btnUseSample");
  const reqText = document.getElementById("reqText");
  const textMeta = document.getElementById("textMeta");
  const fileError = document.getElementById("fileError");

  btnUseSample?.addEventListener("click", () => {
    // Fill the text box with three example requirements.
    const sampleText =
      "The system shall allow users to create accounts using email and password.\n" +
      "The system shall store user login credentials securely.\n" +
      "The system shall allow users to upload requirement documents for analysis.";

    if (reqText) {
      reqText.value = sampleText;
    }

    if (textMeta) {
      textMeta.textContent = `${sampleText.length} characters`;
    }
  });

  // Start Analysis: a project and some input are required; send file and/or text.
  btnAnalyze?.addEventListener("click", async () => {
    const currentProject = getCurrentProject();

    if (!currentProject) {
      showError(fileError, "Please create or select a project first.");
      return;
    }

    const textValue = reqText ? reqText.value.trim() : "";

    if (!selectedFile && !textValue) {
      showError(fileError, "Please upload a file or paste requirements text.");
      return;
    }

    hideError(fileError);

    const formData = new FormData();

    if (selectedFile) {
      formData.append("file", selectedFile);
    }

    if (textValue) {
      formData.append("text", textValue);
    }

    await runAnalysis(formData, currentProject);
  });
}

// ----------------------------------------------------------------------------
// Run the analysis and save the results
// ----------------------------------------------------------------------------
async function runAnalysis(formData, currentProject) {
  const btnAnalyze = document.getElementById("btnAnalyze");
  const fileError = document.getElementById("fileError");
  if (btnAnalyze) { btnAnalyze.disabled = true; btnAnalyze.textContent = "Analyzing..."; }
  hideError(fileError);

  try {
    // Check that the signed-in user leads the selected project.
    const projectId = currentProject.id || currentProject.projectId || currentProject.documentId;
    if (!projectId) throw new Error("Selected project is missing its Firestore document ID.");
    const user = await new Promise((resolve, reject) => {
      const unsubscribe = auth.onAuthStateChanged(user => { unsubscribe(); resolve(user); }, reject);
    });
    if (!user) throw new Error("Please sign in again before running the analysis.");
    const projectRef = doc(db, "projects", projectId);
    const projectSnapshot = await getDoc(projectRef);
    if (!projectSnapshot.exists() || projectSnapshot.data().leaderEmail?.toLowerCase() !== user.email?.toLowerCase()) {
      throw new Error("You are not the leader of the selected project. Open it again from Projects.");
    }

    // Send the file and/or text to the backend.
    // The backend checks the ID token and that this user leads the project.
    formData.append("project_id", projectId);
    const idToken = await user.getIdToken();
    const response = await fetch(`${API_BASE}/analyze`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${idToken}` },
      body: formData
    });

    // Show the backend's validation message (e.g. not English, not an SRS) as-is.
    if (!response.ok) {
      let payload = {};
      try {
        payload = await response.json();
      } catch {
      }
      const analysisError = new Error(
        payload.error || payload.detail || `Analysis failed (HTTP ${response.status}).`
      );
      analysisError.isAnalysisValidationError = true;
      throw analysisError;
    }

    const results = await response.json();
    if (!Array.isArray(results) || !results.length) throw new Error("The analysis returned no results to save.");

    // Save the results and the project status in one batch so they never get out of sync.
    const batch = writeBatch(db);
    batch.set(doc(db, "project_results", projectId), {
      projectId,
      results,
      analyzedAt: serverTimestamp()
    });
    // A new analysis replaces the old requirements, so the previous approved list
    // (task-approved fixes and auto-approved clean rows) no longer applies. Clear it
    // in the same batch; the Results page re-adds clean rows for the new document.
    batch.update(projectRef, {
      status: "Analyzed",
      analyzedAt: serverTimestamp(),
      approvedRequirements: [],
      updatedAt: serverTimestamp()
    });
    await batch.commit();

    // Local copies used by older screens; Firestore is the shared source of truth.
    sessionStorage.setItem("metras_results", JSON.stringify(results));

    const allProjectResults = getAllProjectResults();
    allProjectResults[projectId] = results;
    localStorage.setItem("metras_project_results", JSON.stringify(allProjectResults));

    // Update the cached project so the Results page shows "Analyzed" immediately.
    currentProject.status = "Analyzed";
    currentProject.approvedRequirements = [];
    currentProject.id = projectId;
    localStorage.setItem("metras_current_project", JSON.stringify(currentProject));

    window.location.href = "results.html";

  } catch (error) {
    console.error(error);

    // Validation errors are shown as-is; anything else is usually a Firestore permission problem.
    if (error.isAnalysisValidationError) {
      showError(fileError, error.message);
    } else {
      showError(fileError, `Could not complete and save the analysis: ${error.message}. Check Firestore permissions if the analysis appeared to finish.`);
    }
    fileError?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (btnAnalyze) { btnAnalyze.disabled = false; btnAnalyze.textContent = "Start Analysis"; }
  }
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
// The active project cached by the Projects page.
function getCurrentProject() {
  try {
    return JSON.parse(localStorage.getItem("metras_current_project"));
  } catch {
    return null;
  }
}

// Locally cached results of all projects.
function getAllProjectResults() {
  try {
    return JSON.parse(localStorage.getItem("metras_project_results")) || {};
  } catch {
    return {};
  }
}

// Show / hide an error message.
function showError(element, message) {
  if (!element) return;

  element.textContent = message;
  element.hidden = false;
}

function hideError(element) {
  if (!element) return;

  element.textContent = "";
  element.hidden = true;
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
