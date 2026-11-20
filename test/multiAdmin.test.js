import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';

process.env.LIVEKIT_URL = 'wss://test.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'devkey';
process.env.LIVEKIT_API_SECRET = 'devsecret_1234567890_1234567890_12';
process.env.HOST_PASSCODE = 'test-pass-999';
process.env.API_TOKEN_SECRET = 'test-api-secret-value';

import { createApp } from '../src/app.js';

describe('Multi-admin registration, login, and schedule/session isolation', () => {
  let server, baseUrl, tokenA, tokenB;

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

  it('registers two distinct admins and isolates their schedules and sessions', async () => {
    const rA = await fetch(`${baseUrl}/api/admins/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Alice Kigali', email: 'alice@example.com', password: 'password123' })
    });
    expect(rA.status).toBe(201);
    tokenA = (await rA.json()).adminToken;

    const rB = await fetch(`${baseUrl}/api/admins/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Bob Nairobi', email: 'bob@example.com', password: 'password456' })
    });
    expect(rB.status).toBe(201);
    tokenB = (await rB.json()).adminToken;

    // Alice schedules a session
    const sA = await fetch(`${baseUrl}/api/schedules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ title: 'Alice Keynote', startAt: '2026-12-05T09:00:00.000Z', recurrence: 'weekly' })
    });
    expect(sA.status).toBe(201);
    const schA = await sA.json();

    // Bob should NOT see Alice's schedule
    const listB = await fetch(`${baseUrl}/api/schedules`, {
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    expect(await listB.json()).toEqual([]);

    // Bob cannot delete Alice's schedule
    const delB = await fetch(`${baseUrl}/api/schedules/${schA.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${tokenB}` }
    });
    expect(delB.status).toBe(404);

    // Alice starts a live session; Bob cannot connect as admin to Alice's room
    const sessA = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ name: 'Alice Live Room' })
    });
    const { code } = await sessA.json();

    const authB = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tokenB}` },
      body: JSON.stringify({ role: 'admin', code, name: 'Bob' })
    });
    expect(authB.status).toBe(403);
  });
});
