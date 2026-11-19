import dotenv from 'dotenv';
dotenv.config();

import http from 'http';
import { createApp } from './app.js';
import { setupWebSocketServer } from './wsServer.js';

const port = process.env.PORT || 3001;
const app = createApp();
const server = http.createServer(app);

setupWebSocketServer(server);

server.listen(port, () => {
  console.log(`[eventmic-server] Listening on port ${port}`);
  console.log(`[eventmic-server] LiveKit endpoint: ${process.env.LIVEKIT_URL || 'not configured'}`);
});
