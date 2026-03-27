# Deploy GTD API Server to Google Cloud Run

## Context

The GTD api-server is a Node.js/Express/TypeScript app currently on Heroku (via GitHub Actions). Migrating to Google Cloud Run (free tier) for better scalability and no idle cost. MongoDB stays on Atlas (already configured). Cloud Run is chosen because it has the most generous always-free tier (2M req/month), scales to zero, and the app already reads `PORT` from env which Cloud Run sets automatically.

## Current State

- `api-server/.github/workflows/heroku-deploy.yml` — existing deploy workflow (to be replaced)
- `api-server/src/index.ts` — reads `process.env.PORT`, defaults to 4000 ✓
- `api-server/.env.production` — has all required env vars (MongoDB Atlas, Google OAuth)
- No Dockerfile exists yet

## Files to Create/Modify

1. **`api-server/Dockerfile`** (new)
2. **`api-server/.dockerignore`** (new)
3. **`api-server/.github/workflows/gcp-deploy.yml`** (new, replaces heroku-deploy.yml)

---

## One-Time GCP Setup (manual, in GCP Console or gcloud CLI)

```bash
# 1. Create a GCP project (or use existing)
gcloud projects create gtd-app --name="GTD App"
gcloud config set project gtd-app

# 2. Enable required APIs
gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com

# 3. Create Artifact Registry repo (stores Docker images)
gcloud artifacts repositories create gtd-repo \
  --repository-format=docker \
  --location=us-central1

# 4. Create a service account for GitHub Actions to use
gcloud iam service-accounts create github-deploy \
  --display-name="GitHub Actions Deploy"

# 5. Grant it Cloud Run and Artifact Registry permissions
gcloud projects add-iam-policy-binding gtd-app \
  --member="serviceAccount:github-deploy@gtd-app.iam.gserviceaccount.com" \
  --role="roles/run.admin"
gcloud projects add-iam-policy-binding gtd-app \
  --member="serviceAccount:github-deploy@gtd-app.iam.gserviceaccount.com" \
  --role="roles/artifactregistry.writer"
gcloud iam service-accounts add-iam-policy-binding \
  PROJECT_NUMBER-compute@developer.gserviceaccount.com \
  --member="serviceAccount:github-deploy@gtd-app.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountUser"

# 6. Create and download service account key → add as GitHub secret GCP_SA_KEY
gcloud iam service-accounts keys create key.json \
  --iam-account=github-deploy@gtd-app.iam.gserviceaccount.com
```

**GitHub Secrets to add** (repo Settings → Secrets):
- `GCP_SA_KEY` — contents of key.json
- `GCP_PROJECT_ID` — e.g. `gtd-app`
- `MONGO_DB_URL` — Atlas connection string
- `MONGO_DB_NAME` — `gtd_prod`
- `GOOGLE_OAUTH_APP_CLIENT_ID`
- `GOOGLE_OAUTH_APP_CLIENT_SECRET`
- `JWT_SECRET`

---

## Dockerfile (`api-server/Dockerfile`)

```dockerfile
# Stage 1: Build
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# Stage 2: Run
FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=builder /app/build ./build
EXPOSE 8080
CMD ["node", "build/index.js"]
```

Note: Cloud Run defaults to port 8080 and sets `PORT=8080` automatically. The app already reads `process.env.PORT`, so no code change needed.

---

## .dockerignore (`api-server/.dockerignore`)

```
node_modules
build
.env
.env.*
*.md
.github
src
```

---

## GitHub Actions Workflow (`api-server/.github/workflows/gcp-deploy.yml`)

```yaml
name: Deploy to Cloud Run

on:
  push:
    branches:
      - main

env:
  PROJECT_ID: ${{ vars.GCP_PROJECT_ID }}
  REGION: us-central1
  SERVICE: gtd-api
  IMAGE: us-central1-docker.pkg.dev/${{ vars.GCP_PROJECT_ID }}/gtd-repo/api-server

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - id: auth
        uses: google-github-actions/auth@v2
        with:
          credentials_json: ${{ secrets.GCP_SA_KEY }}

      - uses: google-github-actions/setup-gcloud@v2

      - name: Configure Docker
        run: gcloud auth configure-docker us-central1-docker.pkg.dev

      - name: Build and push image
        run: |
          docker build -t $IMAGE:$GITHUB_SHA .
          docker push $IMAGE:$GITHUB_SHA

      - name: Deploy to Cloud Run
        run: |
          gcloud run deploy $SERVICE \
            --image=$IMAGE:$GITHUB_SHA \
            --region=$REGION \
            --platform=managed \
            --allow-unauthenticated \
            --set-env-vars="NODE_ENV=production,MONGO_DB_NAME=${{ vars.MONGO_DB_NAME }},MONGO_DB_URL=${{ secrets.MONGO_DB_URL }},GOOGLE_OAUTH_APP_CLIENT_ID=${{ secrets.GOOGLE_OAUTH_APP_CLIENT_ID }},GOOGLE_OAUTH_APP_CLIENT_SECRET=${{ secrets.GOOGLE_OAUTH_APP_CLIENT_SECRET }},GOOGLE_REDIRECT_URI=https://gtd-api-HASH-uc.a.run.app/auth/google/callback,JWT_SECRET=${{ secrets.JWT_SECRET }}"
```

---

## Post-Deploy Step: Update Google OAuth

After first deploy, get the Cloud Run service URL:
```bash
gcloud run services describe gtd-api --region=us-central1 --format='value(status.url)'
```

Then update:
1. `GOOGLE_REDIRECT_URI` in GitHub secret → `https://<your-service-url>/auth/google/callback`
2. Add the same URI to **Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client → Authorized redirect URIs**
3. Redeploy to pick up the new env var

---

## Verification

1. After deploy: `curl https://<service-url>/auth/check` → should return 401 (unauthenticated, not 500)
2. Open browser → `https://<service-url>/auth/google` → should redirect to Google login
3. Complete login → JWT cookie set → `/auth/check` returns 200
4. Check Cloud Run logs: `gcloud run services logs read gtd-api --region=us-central1`
