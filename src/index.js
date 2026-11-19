import dotenv from 'dotenv';
dotenv.config();

import { createApp } from './app.js';

const port = process.env.PORT || 3001;
const app = createApp();

app.listen(port, () => {
  console.log(`[eventmic-server] Listening on port ${port}`);
  console.log(`[eventmic-server] LiveKit endpoint: ${process.env.LIVEKIT_URL || 'not configured'}`);
});
