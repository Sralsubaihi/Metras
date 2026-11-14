# METRAS — Project Files Guide

METRAS is an AI-powered platform that analyses software requirements for security
risk, links risky requirements to real CVEs, scores them, and then manages the fixing
work as tasks between a team leader and team members.

```
2026_GP1_9-main/
├── Backend/          Python FastAPI service: AI analysis, CVE matching, chatbot
├── Frontend/
│   ├── pages/        One HTML file per screen
│   ├── js/           One script per page (+ one shared helper)
│   ├── css/          One shared stylesheet
│   └── assets/       Logo
├── firestore.chatbot.rules   Reference Firestore security rules
├── THRESHOLDS.md             How every threshold was chosen
└── PROJECT_FILES_GUIDE.md    This file
```

**Roles:** *Admin* manages users · *Leader* creates projects, runs the analysis, creates
and reviews tasks · *Team member* works on assigned tasks. Each page allows only its
roles (see `js/session.js`); the backend checks the role again on every protected call.

**Main flow:** Login → Projects → Create Project → Risk Assessment (upload SRS) →
Results (create tasks) → Task Board (members work, leader reviews) → Compare
(before/after) · AI Assistant available throughout.

**Firestore collections:** `users` (name, email, role, isActive) · `projects` (members,
memberEmails, leaderEmail, status, approvedRequirements) · `project_results` (analysis
rows per project) · `tasks` (assignees, status, shared draft, discussion) ·
`chatbotSessions/{id}/messages` (private conversations).

---

## Root files

| File | Main function | Activities |
|---|---|---|
| `README_UPDATED_FEATURES.md` | Notes on the task collaboration features | Describes multi-member tasks, leader review, approved requirements and the requirements document export, plus how to start the backend and frontend locally. Some details describe an older per-member submission design; the current code uses one shared draft per task. |
| `CHATBOT_SETUP.md` | Setup guide for the AI Assistant | Explains the hybrid design (Firebase + local NVD + OpenAI), the access rules for leaders and members, the `.env` secrets and how to run everything locally. |
| `firestore.chatbot.rules` | Reference Firestore security rules | Defines who may read projects, results and tasks, and keeps chatbot conversations private to their owner. Meant to be merged into the deployed rules. |
| `.gitignore` | Keeps secrets and caches out of Git | Ignores `Backend/.env`, Firebase service-account JSON files and Python caches. |
| `THRESHOLDS.md` | Explains every threshold | Source (standard, derived or tuned) and reasoning for each value. |
| `PROJECT_FILES_GUIDE.md` | This guide | — |

---

## Backend (`Backend/`)

| File | Main function | Activities |
|---|---|---|
| `main.py` | **The whole backend**: a FastAPI service on `http://localhost:8000` | See the section breakdown below. |
| `requirements.txt` | Python dependencies | FastAPI/uvicorn (API), scikit-learn (classifier), sentence-transformers + faiss-cpu (semantic CVE search), PyPDF2 (PDF reading), langdetect (language check), openai (chatbot), firebase-admin (token checks and Firestore), pandas/numpy/openpyxl, python-dotenv, python-multipart. |
| `.env` | Secret settings, never shared publicly | `OPENAI_API_KEY`, `OPENAI_MODEL`, `FIREBASE_SERVICE_ACCOUNT_PATH`. |
| `software_requirements_extended.csv` | Training data for the security classifier | Labelled requirements; `Type = SE` marks security requirements. Used at startup to train the TF-IDF + logistic regression classifier. |
| `nvdcve-2.0-modified.json` | Local CVE knowledge base (NVD 2.0 feed, about 3,500 CVEs) | Source of CVE descriptions, CVSS scores, CIA impact, exploitability and CWE ids. |
| `cve_embeddings.npy` | Cache of the CVE description embeddings | Saves recomputing about 3,500 embeddings each time the server starts. |
| `cve_embeddings.npy.json` | Cache fingerprint | Records the model name, NVD file size/date and CVE count. The cache is rebuilt automatically if any of these change. |
| `Software Requirements Risk Predection.csv.xlsx` | Older dataset (not used by the current code) | Used by an earlier version that predicted severity with ML instead of formulas. |

### `main.py` — sections

| # | Section | What it does |
|---|---|---|
| 1 | Imports | Libraries for the API, ML, embeddings, PDF reading, OpenAI and Firebase. |
| 2 | Application setup | Loads `.env`, creates the FastAPI app and enables CORS for the local frontend. |
| 3 | Configuration and thresholds | Every tunable value in one place: file paths, upload limits, similarity/duplicate/classifier thresholds, re-ranking bonuses and line filters. |
| 4 | Input validation and requirement extraction | Detects CVs and assignment briefs, checks the document is English, splits text into requirement lines, filters non-requirements, scores how requirement-like each line is (`requirement_likeness`), rates quality (`assess_requirement_quality`) and assigns a type (Security, Performance, Usability, …). |
| 5 | Security posture classification | Regex rules for 13 weakness families plus safeguard and prohibition wording. They label each requirement *Risk-indicating*, *Protective control* or *Neutral*, and record the related CWE ids or attack surfaces. |
| 6 | Risk scoring formulas | `formula_severity` (CVSS bands + keyword floor), `formula_impact` (CIA average + weakness baseline), `formula_likelihood` (exploitability × keyword weight), `formula_risk_matrix` (Impact × Likelihood). |
| 7 | NVD data helpers | Reads English descriptions, CVSS scores and CWE ids, skips rejected CVEs, and builds or loads the embedding cache. |
| 8 | Startup | Trains the security classifier and prints its test report, then loads the NVD feed, embeds CVE descriptions (MiniLM) and builds the FAISS index. |
| 9 | CVE matching and duplicate detection | Builds the search vector, fetches 25 FAISS candidates, re-ranks them by CWE and concept overlap, applies the similarity gates and match confidence, and groups near-duplicate requirements. |
| 10 | Full analysis pipeline | `analyze_requirement` combines everything into one result row per requirement. |
| 11 | Firebase authentication | Initialises Firebase Admin, verifies ID tokens, checks the account is active and its role is allowed (`require_active_user`), and works out the user's role on a project. |
| 12 | API endpoints | `POST /analyze` (full document analysis; active leader of the project only), `POST /reanalyze-requirement` (leader re-checks an approved fix), `GET /health`. |
| 13 | AI Assistant | Loads authorised results, tasks and chat history from Firestore and finds relevant CVEs. It asks OpenAI for a grounded answer, or falls back to a rule-based answer (`POST /chat`). |

---

## Frontend pages (`Frontend/pages/`) and their scripts (`Frontend/js/`)

Every page uses `css/styles.css`. Most pages have a top bar, a mobile drawer menu and
a footer. Each script starts Firebase (Auth + Firestore) itself and redirects to
`login.html` when nobody is signed in.

### Public and account pages

| Page / script | Main function | Activities |
|---|---|---|
| `index.html` + `index.js` | Public landing page | Presents METRAS (hero, capabilities, workflow, call to action). The script handles the mobile menu, scroll-reveal animations, the navbar shadow and the hero tilt effect. |
| `login.html` + `login.js` | Sign in | Firebase email/password sign-in. Checks the user exists in `users` and is active, then redirects by role (admin → admin dashboard, others → projects). Shows friendly error messages. |
| `signup.html` + `signup.js` | Activate an account | Only for emails an admin has already registered. Validates the password (min 6, must match), creates the Firebase Auth account and redirects by role. |
| `settings.html` + `settings.js` | Profile settings | Shows name, email and role, saves name changes, and points the Tasks link to the right page for the role. |

### Admin

| Page / script | Main function | Activities |
|---|---|---|
| `admin-dashboard.html` + `admin.js` | User management | Admin-only page guard. Adds users (name, email, role, company) to Firestore after checking the email format and rejecting emails that are already registered; lists, enables/disables and deletes users. |

### Leader: projects and analysis

| Page / script | Main function | Activities |
|---|---|---|
| `projects.html` + `projects.js` | Project list | Live list of the user's projects (led or member of). The project popup shows details and *View Results*. The owner can edit name/description/members or delete the project. Remembers the selected project for the next pages. Admins are redirected. |
| `createProject.html` + `createProject.js` | Create a project | Loads active team members, adds/removes member chips and saves the project as "Draft" in Firestore, then opens the Risk Assessment page. |
| `teamleader.html` + `teamleader.js` | Risk Assessment (upload) | Upload a PDF/TXT and/or paste requirements (with a sample option). Checks the user leads the project, calls `POST /analyze`, saves the results to `project_results`, marks the project "Analyzed" and opens Results. |
| `results.html` + `results.js` | Analysis results | Table of requirements with posture, risk level, severity, impact/likelihood, matched CVE, similarity and interpretation; the *i* icons explain each column. Hides duplicates, auto-approves clean requirements, migrates old local-only results, and opens the **Create Task** modal (suggested title, description with CVE, priority from severity, 7-day deadline, multiple assignees). |

### Tasks

| Page / script | Main function | Activities |
|---|---|---|
| `leader-tasks.html` + `leader-tasks.js` | Leader Task Board | Live project cards with task counters (total, for review, done, overdue); opens a project's tasks. |
| `project-tasks.html` + `project-tasks.js` | Leader's tasks for one project | Live task table with status filters and deadline colours. **Review** submissions: approve, which runs the new-risk check via `/reanalyze-requirement` and adds the fix to *approved requirements*, or request changes. **Request rework** on approved tasks, with optional reassignment. Shows the approved requirements list and **downloads the updated requirements document (.doc)**. Links to Compare. |
| `task-board.html` + `task-board.js` | Member My Tasks | Live cards for the member's projects, highlighting projects where the leader requested changes. |
| `member-project-tasks.html` + `member-project-tasks.js` | Member's tasks for one project | Live table of the member's tasks with filters and deadline colours: *Start Working*, *Continue Working / Make Changes*, or a read-only *View*. Links the AI assistant to the project. |
| `task-work.html` + `task-work.js` | Shared task workspace | All assignees edit one shared draft (revised requirement + mitigation). Live updates never overwrite text being typed; a banner offers to load a teammate's newer draft. Shows leader feedback and the team notes thread, saves progress and submits for review. |

### Analysis and assistant

| Page / script | Main function | Activities |
|---|---|---|
| `compare.html` + `compare.js` | Before/after dashboard (leader) | Total / fixed / unfixed counts, estimated risk reduction, new risks found by the re-check, overall security score gauge, and Chart.js charts (by severity, impact, likelihood, task status, resolution timeline). Lists fixes that still look risky. |
| `chatbot.html` + `chatbot.js` | AI Assistant | Pick a project; conversations are saved per user and project. Questions go to `POST /chat` with the user's ID token; answers are grounded in the project's results, the user's authorised tasks and local CVE data. Includes suggested questions. |

### Shared and other files

| File | Main function | Activities |
|---|---|---|
| `js/session.js` | Shared sign-out and role guard | `requireRole(auth, db, roles)` lets only active users with an allowed role stay on a page (others are signed out or sent to their home page). `setupLogout()` makes every Logout link sign out of Firebase, clear cached session data and go to the login page. |
| `js/info-tooltip.js` | Shared *i* icon popover | `attachInfoTooltip(icon, html)` for column explanations; `DEADLINE_LEGEND_HTML` holds the deadline colour legend used by both task pages. |
| `js/project-details.js` | **Legacy, not used** | Belonged to the removed Project Manager role (assign a leader, submit a file). No page loads it; kept for reference. |
| `css/styles.css` | All styling | Dark-theme design tokens, layout, forms, buttons, drawer, tables, chips (risk colours), modals, page-specific styles and responsive rules. |
| `assets/logo.png` | METRAS logo | Shown in the top bar of every page. |
| `pages/workspace.code-workspace` | Empty VS Code workspace file | Editor setting only; not part of the app. |

---

## How to run

```bash
# Backend
cd Backend
pip install -r requirements.txt
uvicorn main:app --reload          # http://localhost:8000

# Frontend (separate terminal)
cd Frontend
python -m http.server 5500         # open http://localhost:5500/pages/login.html
```
