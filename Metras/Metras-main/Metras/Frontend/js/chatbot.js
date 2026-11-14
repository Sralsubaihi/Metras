// chatbot.js - AI Assistant page (chatbot.html).
// The user picks one of their projects. Conversations are saved per user and project
// in Firestore (chatbotSessions/{id}/messages). Each question is sent with the user's
// Firebase ID token to the backend /chat endpoint, which answers from the project's
// saved results, the user's authorised tasks and the local CVE data.

import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-auth.js";
import { getFirestore, collection, addDoc, doc, getDocs, query, where, orderBy, onSnapshot, serverTimestamp, updateDoc } from "https://www.gstatic.com/firebasejs/9.22.0/firebase-firestore.js";
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

// Backend chat endpoint.
const CHAT_API = `${API_BASE}/chat`;

// Page state.
let currentUser = null, projects = [], selectedProject = null, selectedResults = [], selectedTasks = [], activeSessionId = null;
let currentRole = "team_member";
let unsubscribeSessions = null, unsubscribeMessages = null;

// Page elements.
const projectSelect = document.getElementById("projectSelect");
const projectStatus = document.getElementById("projectStatus");
const sessionList = document.getElementById("sessionList");
const chatMessages = document.getElementById("chatMessages");
const chatTitle = document.getElementById("chatTitle");
const chatSubtitle = document.getElementById("chatSubtitle");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const sendChatBtn = document.getElementById("sendChatBtn");
const newChatBtn = document.getElementById("newChatBtn");
const tasksSuggestion = document.getElementById("tasksSuggestion");


// ----------------------------------------------------------------------------
// Logout and drawer
// ----------------------------------------------------------------------------
initDrawer();

// ----------------------------------------------------------------------------
// Auth guard: role-based navigation, then the user's projects
// ----------------------------------------------------------------------------
requireRole(auth, db, ["leader", "team_member"]).then(async ({ user }) => {
  currentUser = user;
  await configureRoleNavigation();
  await loadAccessibleProjects();
});

// ----------------------------------------------------------------------------
// Project selection: load its context, then open the latest conversation
// ----------------------------------------------------------------------------
projectSelect.addEventListener("change", async () => {
  stopListeners();
  selectedProject = projects.find(project => project.id === projectSelect.value) || null;
  selectedResults = [];
  selectedTasks = [];
  activeSessionId = null;
  if (!selectedProject) { disableChat("Choose a project to begin"); return; }
  projectStatus.textContent = `Opening ${selectedProject.name}...`;
  try {
    await Promise.all([loadProjectResults(selectedProject.id), loadMemberTasks(selectedProject.id)]);
    projectStatus.textContent = `${selectedResults.length} saved risk result(s) · ${selectedTasks.length} assigned task(s)`;
  } catch (error) {
    console.error("Could not load project context:", error);
    projectStatus.textContent = "Could not read saved project results. Check Firestore permissions and select the project again.";
    return;
  }
  chatInput.disabled = true;
  sendChatBtn.disabled = true;
  chatInput.placeholder = "Opening your conversation...";
  await openLatestSessionOrCreate();
  listenToSessions();
});

// ----------------------------------------------------------------------------
// New conversation, send and suggested questions
// ----------------------------------------------------------------------------
newChatBtn.addEventListener("click", createPermanentSession);
chatForm.addEventListener("submit", async event => {
  event.preventDefault();
  const message = chatInput.value.trim();
  if (message && selectedProject && activeSessionId) await sendMessage(message);
});

// Suggested question buttons (#suggestions is found through its element id).
suggestions.querySelectorAll("button").forEach(button => button.addEventListener("click", () => sendMessage(button.textContent.trim())));


// ----------------------------------------------------------------------------
// Loading data
// ----------------------------------------------------------------------------
// Projects the user leads or belongs to; preselect ?projectId= when given.
async function loadAccessibleProjects() {
  projectSelect.innerHTML = '<option value="">Loading your projects...</option>';
  try {
    const email = String(currentUser.email || "").toLowerCase();
    const [ledSnapshot, memberSnapshot] = await Promise.all([
      getDocs(query(collection(db, "projects"), where("leaderEmail", "==", email))),
      getDocs(query(collection(db, "projects"), where("memberEmails", "array-contains", email)))
    ]);
    const accessible = new Map();
    [...ledSnapshot.docs, ...memberSnapshot.docs].forEach(item => accessible.set(item.id, { id: item.id, ...item.data() }));
    projects = [...accessible.values()].sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
    projectSelect.innerHTML = '<option value="">-- Select a project --</option>' + projects.map(project => `<option value="${escapeHtml(project.id)}">${escapeHtml(project.name || "Untitled project")}</option>`).join("");
    if (!projects.length) {
      projectSelect.innerHTML = '<option value="">No accessible projects</option>';
      projectStatus.textContent = "You are not currently assigned to a project.";
    } else {
      const requestedProjectId = new URLSearchParams(window.location.search).get("projectId");
      if (requestedProjectId && projects.some(project => project.id === requestedProjectId)) {
        projectSelect.value = requestedProjectId;
        projectSelect.dispatchEvent(new Event("change"));
      }
    }
  } catch (error) {
    console.error("Could not load projects:", error);
    projectSelect.innerHTML = '<option value="">Could not load projects</option>';
    projectStatus.textContent = "Firestore denied or failed to load the projects collection.";
  }
}

// Latest saved results of the project (the count is shown under the picker).
async function loadProjectResults(projectId) {
  const snapshot = await getDocs(query(collection(db, "project_results"), where("projectId", "==", projectId)));
  const documents = snapshot.docs.map(item => item.data()).sort((a, b) => timestampMillis(b.analyzedAt) - timestampMillis(a.analyzedAt));
  selectedResults = Array.isArray(documents[0]?.results) ? documents[0].results : [];
}

// Tasks the user may see: all for a leader, only assigned ones for a member.
async function loadMemberTasks(projectId) {
  if (currentRole === "leader") {
    const snapshot = await getDocs(query(collection(db, "tasks"), where("projectId", "==", projectId)));
    selectedTasks = snapshot.docs.map(item => ({ id: item.id, ...item.data() }));
    return;
  }
  const email = String(currentUser.email || "").toLowerCase();
  const [sharedSnapshot, legacySnapshot] = await Promise.all([
    getDocs(query(collection(db, "tasks"), where("assignedEmails", "array-contains", email))),
    getDocs(query(collection(db, "tasks"), where("assignedTo.email", "==", email)))
  ]);
  const byId = new Map();
  [...legacySnapshot.docs, ...sharedSnapshot.docs].forEach(item => byId.set(item.id, { id: item.id, ...item.data() }));
  selectedTasks = [...byId.values()].filter(task => task.projectId === projectId);
}

// ----------------------------------------------------------------------------
// Conversations
// ----------------------------------------------------------------------------
// Open the most recent conversation for this project, or create one.
async function openLatestSessionOrCreate() {
  const snapshot = await getDocs(query(collection(db, "chatbotSessions"), where("userId", "==", currentUser.uid)));
  const sessions = snapshot.docs
    .map(item => ({ id: item.id, ...item.data() }))
    .filter(session => session.projectId === selectedProject.id)
    .sort((a, b) => timestampMillis(b.updatedAt) - timestampMillis(a.updatedAt));
  if (sessions.length) openSession(sessions[0]);
  else await createPermanentSession();
}

// Live list of the user's conversations for this project (latest 30).
function listenToSessions() {
  if (unsubscribeSessions) unsubscribeSessions();
  sessionList.innerHTML = '<p class="chatbot-empty">Loading conversations...</p>';
  const sessionsQuery = query(collection(db, "chatbotSessions"), where("userId", "==", currentUser.uid));
  unsubscribeSessions = onSnapshot(sessionsQuery, snapshot => {
    const sessions = snapshot.docs
      .map(item => ({ id: item.id, ...item.data() }))
      .filter(session => session.projectId === selectedProject.id)
      .sort((a, b) => timestampMillis(b.updatedAt) - timestampMillis(a.updatedAt))
      .slice(0, 30);
    renderSessions(sessions);
  }, error => {
    console.error("Could not load chatbot sessions:", error);
    sessionList.innerHTML = '<p class="chatbot-empty">Unable to load conversations. Check Firestore rules/indexes.</p>';
  });
}

// Render the conversation list.
function renderSessions(sessions) {
  if (!sessions.length) { sessionList.innerHTML = '<p class="chatbot-empty">No conversations for this project yet.</p>'; return; }
  sessionList.innerHTML = "";
  sessions.forEach(session => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `chatbot-session ${session.id === activeSessionId ? "active" : ""}`;
    button.innerHTML = `<strong>${escapeHtml(session.title || "New conversation")}</strong><span>${escapeHtml(formatTimestamp(session.updatedAt))}</span>`;
    button.addEventListener("click", () => openSession(session));
    sessionList.appendChild(button);
  });
}

// Create a new saved conversation.
async function createPermanentSession() {
  if (!selectedProject || !currentUser) return;
  newChatBtn.disabled = true;
  try {
    const reference = await addDoc(collection(db, "chatbotSessions"), {
      userId: currentUser.uid, userEmail: currentUser.email, projectId: selectedProject.id,
      projectName: selectedProject.name || "Untitled project", title: "New conversation",
      createdAt: serverTimestamp(), updatedAt: serverTimestamp()
    });
    openSession({ id: reference.id, title: "New conversation" });
  } catch (error) {
    console.error("Could not create permanent conversation:", error);
    alert("Could not create the conversation in Firestore. Check your security rules.");
  } finally { newChatBtn.disabled = false; }
}

// Open a conversation and enable the input.
function openSession(session) {
  activeSessionId = session.id;
  chatTitle.textContent = session.title || "New conversation";
  chatSubtitle.textContent = selectedProject.name;
  chatInput.disabled = false;
  sendChatBtn.disabled = false;
  chatInput.placeholder = "Ask any question about this project, its risks, mitigations, or your tasks...";
  suggestions.hidden = false;
  newChatBtn.hidden = false;
  newChatBtn.disabled = false;
  listenToMessages(session.id);
  sessionList.querySelectorAll(".chatbot-session").forEach(button => button.classList.remove("active"));
  chatInput.focus();
}

// Live messages of the open conversation.
function listenToMessages(sessionId) {
  if (unsubscribeMessages) unsubscribeMessages();
  const messagesQuery = query(collection(db, "chatbotSessions", sessionId, "messages"), orderBy("createdAt", "asc"));
  unsubscribeMessages = onSnapshot(messagesQuery, snapshot => renderMessages(snapshot.docs.map(item => ({ id: item.id, ...item.data() }))), error => {
    console.error("Could not load messages:", error);
    chatMessages.innerHTML = '<p class="chatbot-error">Unable to load messages from Firestore.</p>';
  });
}

// Render the messages (escaped, line breaks kept).
function renderMessages(messages) {
  if (!messages.length) {
    chatMessages.innerHTML = '<div class="chatbot-welcome"><h3>Conversation saved</h3><p>Ask about the selected project or enter a full CVE ID.</p></div>';
    return;
  }
  chatMessages.innerHTML = messages.map(message => `<article class="chat-message ${message.role === "user" ? "user" : "assistant"}"><div class="chat-message-role">${message.role === "user" ? "You" : "METRAS"}</div><div class="chat-message-content">${escapeHtml(message.content || "").replace(/\n/g, "<br>")}</div><time>${escapeHtml(formatTimestamp(message.createdAt))}</time></article>`).join("");
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

// ----------------------------------------------------------------------------
// Sending a question
// ----------------------------------------------------------------------------
// Save the question, call the backend and save the answer (or an error message).
async function sendMessage(message) {
  if (!message || !activeSessionId || sendChatBtn.disabled) return;
  chatInput.value = "";
  sendChatBtn.disabled = true;
  chatInput.disabled = true;
  const messagesRef = collection(db, "chatbotSessions", activeSessionId, "messages");
  try {
    // Save the question and use it as the conversation title.
    await addDoc(messagesRef, { role: "user", content: message, createdAt: serverTimestamp() });
    await updateDoc(doc(db, "chatbotSessions", activeSessionId), { title: message.slice(0, 60), updatedAt: serverTimestamp() });
    showTyping();

    // Ask the backend, authenticated with the user's Firebase ID token.
    const idToken = await currentUser.getIdToken();
    const response = await fetch(CHAT_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${idToken}`
      },
      body: JSON.stringify({
        message,
        project_id: selectedProject.id,
        session_id: activeSessionId
      })
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.detail || payload.error || "Chat request failed");
    await addDoc(messagesRef, { role: "assistant", content: payload.answer, detectedCveIds: payload.detectedCveIds || [], sourceType: payload.sourceType || null, disclaimer: payload.disclaimer || null, createdAt: serverTimestamp() });
    await updateDoc(doc(db, "chatbotSessions", activeSessionId), { updatedAt: serverTimestamp() });
  } catch (error) {
    console.error("Chat failed:", error);
    await addDoc(messagesRef, { role: "assistant", content: `I could not generate a response. ${error.message || "Make sure the METRAS backend is running, then try again."}`, isError: true, createdAt: serverTimestamp() });
  } finally {
    removeTyping(); chatInput.disabled = false; sendChatBtn.disabled = false; chatInput.focus();
  }
}

// Typing indicator and the "no project selected" state.
function showTyping() {
  removeTyping();
  const typing = document.createElement("div");
  typing.id = "chatTyping"; typing.className = "chatbot-typing";
  typing.textContent = "METRAS is analyzing the saved project data...";
  chatMessages.appendChild(typing); chatMessages.scrollTop = chatMessages.scrollHeight;
}
function removeTyping() { document.getElementById("chatTyping")?.remove(); }
function disableChat(message) {
  newChatBtn.hidden = true; newChatBtn.disabled = true; chatInput.disabled = true; sendChatBtn.disabled = true; suggestions.hidden = true;
  projectStatus.textContent = "Choose a project to view its permanent conversations.";
  sessionList.innerHTML = '<p class="chatbot-empty">No project selected.</p>';
  chatTitle.textContent = "Select a project";
  chatMessages.innerHTML = `<div class="chatbot-welcome"><h3>${escapeHtml(message)}</h3></div>`;
}

// Leaders link to the Task Board, members to My Tasks; adjust the suggested question.
async function configureRoleNavigation() {
  try {
    const snapshot = await getDocs(
      query(
        collection(db, "users"),
        where(
          "email",
          "==",
          String(currentUser.email || "").toLowerCase()
        )
      )
    );

    currentRole = snapshot.empty
      ? "team_member"
      : snapshot.docs[0].data().role;

    const isLeader = currentRole === "leader";

    const destination = isLeader
      ? "leader-tasks.html"
      : "task-board.html";

    const topLabel = isLeader
      ? "TASK BOARD"
      : "MY TASKS";

    const drawerLabel = isLeader
      ? "Task Board"
      : "My Tasks";

    const topTasksLink =
      document.getElementById("chatbotTasksLink");

    const drawerTasksLink =
      document.getElementById("drawerTasks");

    if (topTasksLink) {
      topTasksLink.href = destination;
      topTasksLink.textContent = topLabel;
    }

    if (drawerTasksLink) {
      drawerTasksLink.href = destination;
      drawerTasksLink.textContent = drawerLabel;
    }

    if (tasksSuggestion) {
      tasksSuggestion.textContent = isLeader
        ? "Show all project tasks and deadlines"
        : "Show my assigned tasks and deadlines";
    }
  } catch (error) {
    console.error(
      "Could not determine navigation role:",
      error
    );
  }
}

// Open/close the mobile navigation drawer.
function initDrawer() {
  const drawer = document.getElementById("drawer");
  const backdrop = document.getElementById("backdrop");
  const close = () => {
    drawer?.classList.remove("open");
    drawer?.setAttribute("aria-hidden", "true");
    if (backdrop) backdrop.hidden = true;
  };
  document.getElementById("btnMenu")?.addEventListener("click", () => {
    drawer?.classList.add("open");
    drawer?.setAttribute("aria-hidden", "false");
    if (backdrop) backdrop.hidden = false;
  });
  document.getElementById("btnCloseDrawer")?.addEventListener("click", close);
  backdrop?.addEventListener("click", close);
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
// Stop the live listeners.
function stopListeners() {
  if (unsubscribeSessions) unsubscribeSessions();
  if (unsubscribeMessages) unsubscribeMessages();
  unsubscribeSessions = null; unsubscribeMessages = null;
}

// Firestore timestamp to milliseconds (for sorting).
function timestampMillis(value) {
  if (!value) return 0;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  return new Date(value).getTime() || 0;
}
function formatTimestamp(value) {
  if (!value) return "Saving...";
  const date = typeof value.toDate === "function" ? value.toDate() : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
}

// Escape text before inserting it into HTML (prevents XSS).
function escapeHtml(value) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}
