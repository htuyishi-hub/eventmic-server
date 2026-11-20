# EventMic Server — Deployment Guide

This guide describes how to deploy `eventmic-server` to production platforms like **Render** or **Railway**.

---

## 1. Architectural Overview & Constraints

- **Runtime**: Node.js 18+ / 20+ ESM (`"type": "module"`).
- **Persistent Connection Requirements**: `eventmic-server` hosts both REST endpoints and stateful WebSocket connections (`/ws`).
  - **Do NOT deploy to Serverless/Edge functions** (e.g. AWS Lambda, Vercel Serverless Functions). WebSockets require a persistent, long-running Node.js process.
- **In-Memory State**: Active sessions, floor state, speaker queues, and connected socket clients are currently maintained in server memory.
  > [!WARNING]
  > **Render Free Tier Sleep Warning**: Free web services on Render spin down after 15 minutes of inactivity. When spinning up (takes 30–50s), **all in-memory sessions are reset**. For real-world events or continuous testing, use Render's "Starter" tier (or Railway) with persistent uptime.

---

## 2. Environment Variables Checklist

Configure these environment variables in your Render/Railway dashboard:

| Variable | Required | Default | Notes / Description |
| :--- | :---: | :---: | :--- |
| `NODE_ENV` | **Yes** | `development` | Set to `production` to activate production safeguards. |
| `PORT` | No | `3001` | Set automatically by Render (`10000`) or Railway. |
| `LIVEKIT_URL` | **Yes** | — | LiveKit Cloud WebSocket URL (`wss://<project>.livekit.cloud`). |
| `LIVEKIT_API_KEY` | **Yes** | — | LiveKit API Key from your LiveKit project settings. |
| `LIVEKIT_API_SECRET` | **Yes** | — | LiveKit API Secret. |
| `HOST_PASSCODE` | **Yes** | — | Admin passcode for `/admin` session management. **Server will refuse to start if set to `1234` in production.** |
| `API_TOKEN_SECRET` | No | `LIVEKIT_API_SECRET` | Dedicated HMAC secret for signing client session tokens. In production, falls back to `LIVEKIT_API_SECRET` if not specified; default `'secret'` is rejected. |
| `ALLOWED_ORIGINS` | No | `*` (dev only) | Comma-separated list of web origins allowed for CORS and WebSockets (e.g. `https://my-eventmic.vercel.app`). Required in production. |
| `ALLOW_VERCEL_PREVIEWS` | No | `false` | Set to `true` to allow any `https://*.vercel.app` preview URL for CORS and WebSockets. |

> [!CAUTION]
> **Production Safeguards**: In `NODE_ENV=production`, the server will refuse to start if any of `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, or `HOST_PASSCODE` is missing, or if `HOST_PASSCODE` is set to `1234`.

---

## 3. Deployment on Render

1. Log in to [Render Dashboard](https://dashboard.render.com).
2. Click **New +** -> **Web Service**.
3. Connect your repository: `htuyishi-hub/eventmic-server` (or point to the `eventmic-server` root directory).
4. Configure the service settings:
   - **Name**: `eventmic-server`
   - **Runtime**: `Node`
   - **Build Command**: `npm ci --omit=dev` (or `npm install`)
   - **Start Command**: `node src/index.js` (or `npm start`)
   - **Plan Type**: Starter (recommended) or Free
5. Open **Environment Variables** and add all variables from the checklist above.
6. Open **Health Check Path** and set:
   `/api/health`
7. Click **Deploy Web Service**.

---

## 4. Deployment on Railway

1. Log in to [Railway](https://railway.app).
2. Click **New Project** -> **Deploy from GitHub repo**.
3. Select `htuyishi-hub/eventmic-server`.
4. In **Settings**:
   - **Build Command**: `npm ci --omit=dev`
   - **Start Command**: `node src/index.js`
   - **Healthcheck Path**: `/api/health`
5. In **Variables**, add all required environment variables listed above.
6. Generate a public domain under **Networking** -> **Generate Domain**.

---

## 5. Health Check Verification

Once deployed, verify the server is running properly by querying:

```bash
curl -i https://<YOUR_SERVER_URL>/api/health
```

Expected HTTP 200 response:
```json
{
  "ok": true,
  "version": "1.0.0",
  "uptimeSec": 42,
  "livekitConfigured": true,
  "socketEnabled": true,
  "sessions": 0
}
```

---

## 6. Smoke Testing the Deployment

Run the included automated smoke test suite locally against your deployed server URL:

```bash
# In eventmic-server directory:
node scripts/smoke.js https://<YOUR_SERVER_URL> <YOUR_ADMIN_PASSCODE>
```

This verifies all 9 critical production capabilities end-to-end:
1. `[PASS]` 1. Health check returns `ok: true`.
2. `[PASS]` 2. Admin creates session with passcode authentication.
3. `[PASS]` 3. Admin creates principal speaker and receives 6-digit PIN.
4. `[PASS]` 4. Principal authenticates with PIN and receives LiveKit + API tokens.
5. `[PASS]` 5. Attendee authenticates and receives tokens.
6. `[PASS]` 6. WebSockets connect and receive initial session state.
7. `[PASS]` 7. Wrong PIN returns `401 Unauthorized`.
8. `[PASS]` 8. 5 wrong PIN attempts trigger `429 Too Many Requests` lockout.
9. `[PASS]` 9. Admin ends session cleanly.

---

## 7. Deployment Sequence

When deploying both server and web:
1. **Deploy Server First**: Obtain the live server URL (e.g. `https://eventmic-server.onrender.com`).
2. **Verify Server**: Confirm `/api/health` returns `ok: true` and run `scripts/smoke.js`.
3. **Deploy Web App**: Deploy `eventmic-web` with `VITE_API_BASE` and `VITE_SOCKET_URL` set to the server domain.
4. **Update CORS Origins**: If your web domain is finalized, add it to `ALLOWED_ORIGINS` in your server environment variables.

---

## 8. Rollback Procedure

- **Dashboard Rollback**: In Render/Railway, go to the **Deploys** tab and click **Rollback** on the last working release.
- **Git Rollback**: If reverting code changes, checkout the known good commit or tag:
  - Last working 3-phone verified tag: `last-working-3phones` (commit `d3efffa`).
