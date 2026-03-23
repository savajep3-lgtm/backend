# Deploy Guide: Local vs Production

This document records exactly what changes were made for production deployment and how to switch back to local development safely.

## 1) What was added/changed

- `backend/server.js`
  - Added optional MySQL SSL support for external DB providers.
  - Added DB connection timeout env.
  - No breaking changes for local Docker usage.
- `backend/.env.example`
  - Added new env vars:
    - `DB_SSL`
    - `DB_SSL_REJECT_UNAUTHORIZED`
    - `DB_CONNECT_TIMEOUT`
- `render.yaml`
  - Render blueprint for backend deployment.
- `frontend/vercel.json`
  - Vercel static config for Vite + SPA rewrites.
- `frontend/.env.production.example`
  - Production frontend API base URL example.

## 2) Recommended architecture

- Frontend: Vercel
- Backend API: Render
- Database: AlwaysData (MySQL)

## 3) Environment variables

### Backend (Render)

Set these env vars in Render service settings:

- `NODE_ENV=production`
- `PORT=10000` (Render default internal port)
- `JWT_SECRET=<strong-random-secret>`
- `JWT_EXPIRES_IN=12h`
- `ADMIN_USER=admin`
- `ADMIN_PASSWORD=<secure-password>`
- `N8N_RUNTIME_TOKEN=<secure-runtime-token>`
- `DB_HOST=<alwaysdata-mysql-host>`
- `DB_PORT=3306`
- `DB_USER=<alwaysdata-db-user>`
- `DB_PASSWORD=<alwaysdata-db-password>`
- `DB_NAME=prompt_manager`
- `DB_SSL=true`
- `DB_SSL_REJECT_UNAUTHORIZED=false`
- `DB_CONNECT_TIMEOUT=10000`

### Frontend (Vercel)

- `VITE_API_BASE_URL=https://<your-render-backend>.onrender.com/api`

## 4) Deploy backend to Render

1. Push repository to GitHub.
2. In Render, create a **Web Service** from repo.
3. Root directory: `promt/backend` (if setting manually), or use `promt/render.yaml` blueprint.
4. Build command: `npm install`
5. Start command: `npm start`
6. Add env vars from section 3.
7. After deploy, verify:
   - `https://<backend>/api/health` returns `{"success":true,"status":"ok"}`.

## 5) Deploy frontend to Vercel

1. Import repo into Vercel.
2. Root directory: `promt/frontend`.
3. Framework preset: Vite.
4. Add env var:
   - `VITE_API_BASE_URL=https://<your-render-backend>.onrender.com/api`
5. Deploy.

## 6) n8n production configuration

Use stable production backend URL in n8n Variables:

- `PROMPT_RUNTIME_CHAT_URL=https://<your-render-backend>.onrender.com/api/runtime/chat`
- `N8N_RUNTIME_TOKEN=<same-token-as-render>`

In the dynamic workflow `HTTP Request` node, keep:

- URL: `{{ $vars.PROMPT_RUNTIME_CHAT_URL }}`
- Header JSON:
  `{{ JSON.stringify({"Content-Type":"application/json","x-n8n-token": $vars.N8N_RUNTIME_TOKEN}) }}`

## 7) How to continue local development later

When you return to local work:

1. Run local stack from `promt/`:
   - `docker compose up --build -d`
2. Frontend local env:
   - `VITE_API_BASE_URL=http://localhost:3001/api`
3. Keep backend local DB env:
   - `DB_HOST=localhost`
   - `DB_PORT=3307`
   - `DB_SSL=false`
4. n8n local variables:
   - `PROMPT_RUNTIME_CHAT_URL=http://host.docker.internal:3001/api/runtime/chat` (if n8n in Docker)
   - `N8N_RUNTIME_TOKEN=change-me-runtime-token` (or your local secure token)

## 8) Local vs production quick checklist

- Local
  - Docker Compose services running
  - API URL points to localhost
  - DB SSL disabled
- Production
  - Render API healthy
  - Vercel points to Render API
  - AlwaysData credentials loaded
  - n8n runtime URL/token point to Render
