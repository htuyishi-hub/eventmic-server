import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';

process.env.LIVEKIT_URL = 'wss://test.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'devkey';
process.env.LIVEKIT_API_SECRET = 'devsecret_1234567890_1234567890_12';
process.env.HOST_PASSCODE = 'test-pass-999';
process.env.API_TOKEN_SECRET = 'test-api-secret-value';

import { createApp } from '../src/app.js';

describe('Calendar & recurring scheduled sessions API', () => {
  let server, baseUrl;
  const headers = { 'Content-Type': 'application/json', 'x-host-passcode': 'test-pass-999' };

  beforeAll(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  });

  it('creates a weekly recurring session, starts it with reserved code, and advances to next week', async () => {
    const startAt = '2026-12-01T10:00:00.000Z';
    const cRes = await fetch(`${baseUrl}/api/schedules`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'Weekly Town Hall', startAt, durationMinutes: 60, recurrence: 'weekly', settings: { fairMode: 'on' } })
    });
    expect(cRes.status).toBe(201);
    const created = await cRes.json();
    expect(created.code).toHaveLength(6);
    expect(created.recurrence).toBe('weekly');

    const sRes = await fetch(`${baseUrl}/api/schedules/${created.id}/start`, { method: 'POST', headers });
    expect(sRes.status).toBe(201);
    const started = await sRes.json();
    expect(started.code).toBe(created.code);
    expect(started.settings.fairMode).toBe('on');
    expect(started.nextOccurrence.startAt).toBe('2026-12-08T10:00:00.000Z');

    const dRes = await fetch(`${baseUrl}/api/schedules/${created.id}`, { method: 'DELETE', headers });
    expect(dRes.status).toBe(200);
  });
});
