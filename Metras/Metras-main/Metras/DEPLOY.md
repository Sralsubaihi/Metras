# Hosting guide: Firebase Hosting (frontend) + Google Cloud Run (backend)

Frontend -> Firebase Hosting, free (Spark plan).
Backend  -> Google Cloud Run, free within the monthly free tier when it scales to zero.
          A credit card is required to enable billing, but light use stays at $0.
Deploy the BACKEND FIRST, because the frontend needs its URL.

## 0. One-time setup
- Install Node.js, the Google Cloud CLI (https://cloud.google.com/sdk/docs/install)
- npm i -g firebase-tools
- gcloud auth login ; firebase login
- gcloud config set project metrasdatabase
- Enable billing on the project (Firebase console -> Upgrade -> Blaze, or Cloud Console -> Billing).
  Then create a budget alert (Billing -> Budgets & alerts) for e.g. $1 so nothing surprises you.

## 1. Backend on Cloud Run
```
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com

# OpenAI key as a secret
printf "YOUR_OPENAI_KEY" | gcloud secrets create openai-key --data-file=-

PROJECT_NUMBER=$(gcloud projects describe metrasdatabase --format='value(projectNumber)')
SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
gcloud secrets add-iam-policy-binding openai-key --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor"
gcloud projects add-iam-policy-binding metrasdatabase --member="serviceAccount:$SA" --role="roles/datastore.user"

cd Metras/Backend
gcloud run deploy metras-api --source . --region europe-west1 \
  --memory 2Gi --cpu 2 --cpu-boost \
  --min-instances 0 --max-instances 1 --timeout 300 \
  --allow-unauthenticated \
  --set-env-vars GOOGLE_CLOUD_PROJECT=metrasdatabase,OPENAI_MODEL=YOUR_MODEL \
  --set-secrets OPENAI_API_KEY=openai-key:latest
```
No Firebase key file is needed: Cloud Run's service account is used automatically.
Copy the printed Service URL and test: <URL>/health
(The first request after idle takes 1-2 minutes: the server trains the classifier and builds the index at startup.)

## 2. Frontend on Firebase Hosting
1. Edit Frontend/js/config.js and set API_BASE to the Cloud Run URL (no trailing slash).
2. From the Metras/ folder (where firebase.json is):
   firebase deploy --only hosting
3. Open https://metrasdatabase.web.app

## Notes
- --max-instances 1 caps usage so you cannot run up a large bill.
- Before a demo, open <URL>/health once to wake the backend.
- For local runs set API_BASE back to http://localhost:8000.
