import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import { createApp } from './app.js';
import { setupWebSocketServer } from './wsServer.js';

import { avatarStore } from './avatarStore.js';
import { hydrateSessionsFromDb } from './sessionStore.js';

const port = process.env.PORT || 3001;
const app = createApp();
const server = http.createServer(app);

setupWebSocketServer(server);

function handleShutdown() {
  avatarStore.clearAll();
  process.exit(0);
}
process.on('SIGINT', handleShutdown);
process.on('SIGTERM', handleShutdown);

hydrateSessionsFromDb().then((n) => { if (n > 0) console.log(`[eventmic-server] Restored ${n} live session(s)`); });

server.listen(port, () => {
  console.log(`[eventmic-server] Listening on port ${port}`);
  console.log(`[eventmic-server] LiveKit endpoint: ${process.env.LIVEKIT_URL || 'not configured'}`);
});
