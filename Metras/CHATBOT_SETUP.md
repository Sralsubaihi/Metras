# METRAS AI Assistant setup

The chatbot uses a hybrid design: Firebase remains the source of truth for project access, project results, authorized tasks, and private conversation history; the local NVD dataset supplies CVE context; OpenAI generates the grounded English response. If OpenAI is unavailable, a limited local response is returned.

## Access behavior

- Leaders can select projects they lead and the backend may use every task in that project.
- Members can select only projects where their email is in `memberEmails`.
- Members can see the selected project's analysis results, while the backend sends only tasks assigned to their email.
- Each conversation belongs to one Firebase Authentication UID and one project. The backend verifies both on every request.
- Suggested questions are optional; users can type any project-related question.

## Backend secrets

Copy `Backend/.env.example` to `Backend/.env`, then set:

```env
OPENAI_API_KEY=your_openai_platform_api_key
OPENAI_MODEL=gpt-6-astra
FIREBASE_SERVICE_ACCOUNT_PATH=C:/secure/metras-firebase-admin.json
```

The OpenAI key must be created by a team member who owns or has access to the team's OpenAI Platform project. A Firebase project owner must download the Admin SDK service-account JSON. Never place either secret in Firestore, frontend JavaScript, screenshots, or GitHub.

## Run locally

From `Backend`:

```bash
python -m pip install -r requirements.txt
python -m uvicorn main:app --reload
```

From `Frontend`:

```bash
python -m http.server 5500
```

Open `http://localhost:5500/pages/login.html`.

## Firestore deployment

`firestore.chatbot.rules` is a merge-ready reference. Merge its chatbot conditions with the team's existing Firestore rules before deployment; do not replace existing create/update rules for projects and tasks without reviewing them. Ensure every project maintains normalized lowercase `leaderEmail` and `memberEmails`, and every task maintains `projectId` plus `assignedEmails` (legacy `assignedTo.email` is also supported).
