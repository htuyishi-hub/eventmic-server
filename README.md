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

---

## Temporary Profile Photos (Avatars)

Avatars are kept strictly in-memory (`Map<sessionCode, Map<identity, AvatarData>>`) and never written to disk or database.

- **Upload (`POST /api/avatar`)**: Max 150 KB, magic-byte validated (JPEG, PNG, WebP), re-encoded with `sharp` to 256x256 WebP (~80 quality, metadata stripped). Rate limited to 5 uploads/min per identity. 50 MB session total cap.
- **Fetch (`GET /api/avatar/:code/:identity`)**: Admin & Principals can fetch any avatar; Attendee can only fetch the current floor speaker's avatar or their own; otherwise 403 `FORBIDDEN`. Serves `Cache-Control: private, max-age=300` and ETag matching avatar version (304 supported).
- **Delete (`DELETE /api/avatar`, `DELETE /api/avatar/:identity`)**: User can delete their own photo; Admin can delete any participant photo.
- **Lifecycle Deletion**: All session avatars purged on session end, on participant removal/block, on server SIGINT/SIGTERM shutdown, and after 10 minutes of participant disconnection if they do not reconnect.
- **Admin Settings (`photos: 'on' | 'speaker_only' | 'off'`)**: Default `speaker_only`. When `off`, uploads are blocked with 403 `PHOTOS_DISABLED`.
- **WebSocket State**: Broadcast frames contain only `{ hasAvatar: boolean, avatarVersion: number }`, never raw image bytes.

