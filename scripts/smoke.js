#!/usr/bin/env node
/**
 * EventMic Deployment Smoke Test Script
 * Usage: node scripts/smoke.js <SERVER_URL> <ADMIN_PASSCODE>
 * Example: node scripts/smoke.js https://eventmic-server.onrender.com MySecretPasscode
 */

import WebSocket from 'ws';

const [serverUrlRaw, adminPasscode] = process.argv.slice(2);

if (!serverUrlRaw || !adminPasscode) {
  console.error('Usage: node scripts/smoke.js <SERVER_URL> <ADMIN_PASSCODE>');
  process.exit(1);
}

const serverUrl = serverUrlRaw.trim().replace(/\/+$/, '');
const wsUrlBase = serverUrl.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:');

function fail(stepName, err) {
  console.error(`[FAIL] ${stepName}: ${err.message || err}`);
  process.exit(1);
}

async function run() {
  console.log(`\nStarting smoke test against ${serverUrl}...\n`);

  // Step 1: Health check
  try {
    const res = await fetch(`${serverUrl}/api/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (!data.ok) throw new Error('Health check payload "ok" is not true');
    console.log(`[PASS] 1. Health check OK (uptime: ${data.uptimeSec}s, version: ${data.version}, livekit: ${data.livekitConfigured})`);
  } catch (err) {
    fail('Step 1 (Health Check)', err);
  }

  let sessionCode = '';

  // Step 2: Create session
  try {
    const res = await fetch(`${serverUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        'x-host-passcode': adminPasscode,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'Smoke Test Session' })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (!data.code || data.code.length !== 6) throw new Error(`Invalid session code received: ${data.code}`);
    sessionCode = data.code;
    console.log(`[PASS] 2. Create session OK (code: ${sessionCode})`);
  } catch (err) {
    fail('Step 2 (Create Session)', err);
  }

  let principalId = '';
  let principalPin = '';

  // Step 3: Create principal and read PIN
  try {
    const res = await fetch(`${serverUrl}/api/sessions/${sessionCode}/principals`, {
      method: 'POST',
      headers: {
        'x-host-passcode': adminPasscode,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ name: 'Smoke Speaker' })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (!data.id || !/^\d{6}$/.test(data.pin)) throw new Error('Invalid principal ID or 6-digit PIN');
    principalId = data.id;
    principalPin = data.pin;
    console.log(`[PASS] 3. Create principal OK (id: ${principalId})`);
  } catch (err) {
    fail('Step 3 (Create Principal)', err);
  }

  let principalApiToken = '';

  // Step 4: Authenticate principal
  try {
    const res = await fetch(`${serverUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'principal',
        code: sessionCode,
        pin: principalPin,
        name: 'Smoke Speaker'
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (!data.apiToken || !data.token) throw new Error('Missing token or apiToken in auth response');
    principalApiToken = data.apiToken;
    console.log(`[PASS] 4. Authenticate principal OK`);
  } catch (err) {
    fail('Step 4 (Authenticate Principal)', err);
  }

  let attendeeApiToken = '';

  // Step 5: Get attendee token
  try {
    const res = await fetch(`${serverUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'attendee',
        code: sessionCode,
        name: 'Smoke Attendee'
      })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (!data.apiToken || !data.token) throw new Error('Missing token or apiToken in auth response');
    attendeeApiToken = data.apiToken;
    console.log(`[PASS] 5. Get attendee token OK`);
  } catch (err) {
    fail('Step 5 (Get Attendee Token)', err);
  }

  // Step 6: Open WebSocket connections as attendee & principal and confirm state message
  try {
    const waitForStateMessage = (wsUrl) => new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error('Timed out waiting for initial WebSocket message (5s)'));
      }, 5000);

      ws.on('open', () => {});
      ws.on('message', (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          clearTimeout(timer);
          ws.close();
          resolve(msg);
        } catch (e) {
          clearTimeout(timer);
          ws.close();
          reject(new Error('Failed to parse WebSocket JSON payload'));
        }
      });
      ws.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    const [attendeeMsg, principalMsg] = await Promise.all([
      waitForStateMessage(`${wsUrlBase}/ws?token=${attendeeApiToken}`),
      waitForStateMessage(`${wsUrlBase}/ws?token=${principalApiToken}`)
    ]);

    if (!attendeeMsg || !principalMsg) throw new Error('Did not receive state messages from both sockets');
    console.log(`[PASS] 6. WebSocket connections & initial state messages received OK`);
  } catch (err) {
    fail('Step 6 (WebSocket State Reception)', err);
  }

  const wrongPin = principalPin === '000000' ? '111111' : '000000';

  // Step 7: Wrong PIN returns 401
  try {
    const res = await fetch(`${serverUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        role: 'principal',
        code: sessionCode,
        pin: wrongPin,
        name: 'Attacker'
      })
    });
    if (res.status !== 401) throw new Error(`Expected HTTP 401 but received ${res.status}`);
    const data = await res.json();
    if (data.code !== 'UNAUTHORIZED') throw new Error(`Expected UNAUTHORIZED code, got: ${data.code}`);
    console.log(`[PASS] 7. Wrong PIN returns 401 Unauthorized OK`);
  } catch (err) {
    fail('Step 7 (Wrong PIN 401)', err);
  }

  // Step 8: Five wrong PINs return 429 lockout
  try {
    let lastStatus = 0;
    let lastData = null;

    // Send 4 more attempts to hit the 5-attempt limit
    for (let i = 0; i < 4; i++) {
      const res = await fetch(`${serverUrl}/api/auth`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          role: 'principal',
          code: sessionCode,
          pin: wrongPin,
          name: 'Attacker'
        })
      });
      lastStatus = res.status;
      lastData = await res.json();
    }

    if (lastStatus !== 429) {
      throw new Error(`Expected HTTP 429 lockout after 5 failed attempts, but received ${lastStatus}`);
    }
    if (lastData?.code !== 'PIN_LOCKED') {
      throw new Error(`Expected PIN_LOCKED code, got: ${lastData?.code}`);
    }
    console.log(`[PASS] 8. 5 wrong PIN attempts return 429 lockout OK`);
  } catch (err) {
    fail('Step 8 (PIN Lockout 429)', err);
  }

  // Step 9: End session
  try {
    const res = await fetch(`${serverUrl}/api/sessions/${sessionCode}/end`, {
      method: 'POST',
      headers: {
        'x-host-passcode': adminPasscode,
        'Content-Type': 'application/json'
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    console.log(`[PASS] 9. End session OK`);
  } catch (err) {
    fail('Step 9 (End Session)', err);
  }

  console.log('\n========================================');
  console.log('✅ ALL 9 SMOKE TEST STEPS PASSED SUCCESSFULLY');
  console.log('========================================\n');
  process.exit(0);
}

run().catch((err) => {
  console.error('[UNEXPECTED ERROR]', err);
  process.exit(1);
});
