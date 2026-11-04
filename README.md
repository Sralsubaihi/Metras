# METRAS

METRAS is an AI-powered requirements security analysis platform. It analyses
software requirements before implementation, connects security findings to CVE
data, classifies risk, and supports a collaborative task workflow for leaders
and team members.

## Main features

- PDF, TXT, and pasted-requirement analysis
- CVE-aware risk classification and mitigation guidance
- Leader and team-member project workflows
- Shared task workspace, review, rework, and deadline audit history
- Before/after requirement comparison and security dashboards
- Project-aware AI assistant
- Responsive frontend for desktop, tablet, and mobile

## Technology

- Frontend: HTML, CSS, JavaScript, Firebase Auth and Firestore
- Backend: Python, FastAPI, scikit-learn, Sentence Transformers, FAISS
- Data: NVD CVE data and labelled software requirements

## Run locally

1. Create `Backend/.env`:

   ```env
   OPENAI_API_KEY=your_key
   OPENAI_MODEL=your_model
   FIREBASE_SERVICE_ACCOUNT_PATH=path_to_your_service_account_json
   ```

2. Start the backend:

   ```bash
   cd Backend
   pip install -r requirements.txt
   uvicorn main:app --reload
   ```

3. In another terminal, start the frontend:

   ```bash
   cd Frontend
   python -m http.server 5500
   ```

4. Open `http://localhost:5500/pages/login.html`.

See [PROJECT_FILES_GUIDE.md](PROJECT_FILES_GUIDE.md) for the detailed project
structure and workflow.

## Security

Secrets and service-account credentials are intentionally excluded from Git.
Do not commit `Backend/.env` or Firebase service-account JSON files.

