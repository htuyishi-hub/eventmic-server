# EventMic Server

Backend signaling, room token generation, and floor management service for **EventMic** powered by LiveKit Cloud and Express.

> [!IMPORTANT]
> **Deployment Architecture**: This server maintains stateful WebSocket connections for presence, Connect-on-Speak signaling, batched queue updates, and server-enforced turn caps. It requires a persistent host (e.g. Render, Railway, Fly.io), NOT a serverless environment like Vercel Serverless Functions.

---

## Prerequisites & Setup

1. **Create LiveKit Cloud Project**:
   - Register at [cloud.livekit.io](https://cloud.livekit.io) and create a project.
   - Go to **Project Settings &rarr; Keys** to generate an **API Key** and **API Secret**.
   - Note your project WebSocket URL (`wss://<project-subdomain>.livekit.cloud`).

2. **Configure Environment Variables**:
   ```bash
   cp .env.example .env
   ```
   Fill in your LiveKit credentials in `.env`:
   ```env
   LIVEKIT_URL=wss://your-project.livekit.cloud
   LIVEKIT_API_KEY=your-api-key
   LIVEKIT_API_SECRET=your-api-secret
   HOST_PASSCODE=1234
   PORT=3001
   ```
   > [!WARNING]
   > Never commit `.env` or reveal `LIVEKIT_API_SECRET`. The `.env` file is git-ignored.

3. **Install Dependencies & Run**:
   ```bash
   # Install dependencies
   npm install

   # Start in development mode with auto-reload
   npm run dev

   # Run automated integration tests
   npm test
   ```

---

## API Endpoints

All host endpoints require header `x-host-passcode` matching `HOST_PASSCODE` (compared using `crypto.timingSafeEqual`).

- `POST /api/sessions`: Creates an in-memory session and returns `{ code, name, createdAt }` (Host, rate limited 10/min).
- `GET /api/sessions/:code`: Public session status check.
- `POST /api/token`: Generates short-lived LiveKit JWT token for host (6h) or attendee (3h, max 200 participants, rate limited 60/min).
- `POST /api/floor/grant`: Revokes any active speaker, grants target attendee microphone permission, and clears queue state (Host).
- `POST /api/floor/revoke`: Revokes microphone permission and mutes participant track (Host).
- `POST /api/floor/mute`: Server-side track mute/unmute (Host).
- `POST /api/sessions/:code/end`: Marks session ended, deletes LiveKit room, and returns duration/speaker stats (Host).
- `GET /api/health`: Health check.
