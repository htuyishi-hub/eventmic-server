import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'http';

process.env.LIVEKIT_URL = 'wss://test.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'devkey';
process.env.LIVEKIT_API_SECRET = 'devsecret_1234567890_1234567890_12';
process.env.HOST_PASSCODE = 'test-pass-999';
process.env.API_TOKEN_SECRET = 'test-api-secret-value';

import { createApp } from '../src/app.js';


describe('Principal inviteToken passwordless auth & PIN fallback', () => {
  let server, baseUrl, code, adminToken, principal;

  beforeAll(async () => {
    const app = createApp();
    server = http.createServer(app);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    const sRes = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-host-passcode': 'test-pass-999' },
      body: JSON.stringify({ name: 'Invite Test' })
    });
    const s = await sRes.json();
    code = s.code;

    const aRes = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'admin', code, name: 'Admin', passcode: 'test-pass-999' })
    });
    adminToken = (await aRes.json()).apiToken;

    const pRes = await fetch(`${baseUrl}/api/sessions/${code}/principals`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ name: 'Honore Tuyishi' })
    });
    principal = await pRes.json();
  });

  afterAll(async () => {
    if (code) await fetch(`${baseUrl}/api/sessions/${code}/end`, { method: 'POST', headers: { Authorization: `Bearer ${adminToken}` } });
    server.closeAllConnections?.(); await new Promise((r) => server.close(r));
  });

  it('creates principal with both 6-digit pin and inviteToken', () => {
    expect(principal.pin).toMatch(/^\d{6}$/);
    expect(typeof principal.inviteToken).toBe('string');
    expect(principal.inviteToken.length).toBeGreaterThanOrEqual(12);
  });

  it('authenticates principal via inviteToken with no PIN required', async () => {
    const res = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'principal', code, inviteToken: principal.inviteToken })
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.role).toBe('principal');
    expect(data.name).toBe('Honore Tuyishi');
    expect(data.apiToken).toBeTruthy();
  });

  it('still authenticates principal via name + 6-digit PIN', async () => {
    const res = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'principal', code, name: 'Honore Tuyishi', pin: principal.pin })
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.name).toBe('Honore Tuyishi');
  });

  it('rejects invalid or revoked inviteToken', async () => {
    const res = await fetch(`${baseUrl}/api/auth`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'principal', code, inviteToken: 'bad-token-123' })
    });
    expect(res.status).toBe(401);
  });
});
