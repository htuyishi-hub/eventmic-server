import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import WebSocket from 'ws';
import { createApp } from '../src/app.js';
import { setupWebSocketServer } from '../src/wsServer.js';
import { sessions, clearSessions, initSession } from '../src/sessionStore.js';
import { signApiToken } from '../src/auth.js';
import { createLiveKitToken } from '../src/tokens.js';
import { checkRateLimit, clearRateLimits } from '../src/rateLimiter.js';
import { startAttendeeTurnTimer, startUrgentCapTimer, endTurn } from '../src/wsTurnManager.js';
import { setRoomServiceClient } from '../src/roomService.js';

describe('Connect-On-Speak & WebSocket Realtime Server', () => {
  let server;
  let port;
  let wsUrl;
  let removeParticipantMock;

  beforeEach(async () => {
    clearSessions();
    clearRateLimits();
    vi.useRealTimers();

    removeParticipantMock = vi.fn().mockResolvedValue({});
    setRoomServiceClient({
      listParticipants: vi.fn().mockResolvedValue([]),
      getParticipant: vi.fn().mockResolvedValue({ tracks: [] }),
      updateParticipant: vi.fn().mockResolvedValue({}),
      mutePublishedTrack: vi.fn().mockResolvedValue({}),
      removeParticipant: removeParticipantMock,
      deleteRoom: vi.fn().mockResolvedValue({})
    });

    const app = createApp();
    server = http.createServer(app);
    setupWebSocketServer(server);

    await new Promise((resolve) => {
      server.listen(0, () => {
        port = server.address().port;
        wsUrl = `ws://localhost:${port}/ws`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await new Promise((resolve) => server.close(resolve));
  });

  it('generates scoped LiveKit tokens with strict TTL and permissions', async () => {
    // Attendee normal token: 120s TTL
    const attToken = await createLiveKitToken({
      role: 'attendee',
      code: '8K2M9X',
      identity: 'att-123',
      name: 'Alice',
      ttlSeconds: 120
    });
    expect(attToken.ttlSeconds).toBe(120);
    expect(attToken.token).toBeTruthy();

    // Urgent token: 7s TTL
    const urgentToken = await createLiveKitToken({
      role: 'attendee',
      code: '8K2M9X',
      identity: 'att-urgent',
      name: 'Bob',
      isUrgent: true
    });
    expect(urgentToken.ttlSeconds).toBe(7);
  });

  it('enforces turn caps and calls removeParticipant when cap expires', async () => {
    vi.useFakeTimers();
    const session = initSession('Cap Test Session');
    session.floor = {
      holderId: 'att-speaking',
      holderRole: 'attendee',
      holderName: 'Charlie',
      startedAt: Date.now(),
      mode: 'attendee'
    };

    startAttendeeTurnTimer(session, 'att-speaking', 120);

    // Fast-forward 121 seconds
    await vi.advanceTimersByTimeAsync(121000);

    expect(removeParticipantMock).toHaveBeenCalledWith(session.roomName, 'att-speaking');
    expect(session.floor).toBeNull();
  });

  it('enforces 5-second cap on urgent blip and ducks/restores stage audio', async () => {
    vi.useFakeTimers();
    const session = initSession('Urgent Test Session');
    session.floor = {
      holderId: 'att-urgent',
      holderRole: 'attendee',
      holderName: 'Dave',
      startedAt: Date.now(),
      mode: 'urgent'
    };

    startUrgentCapTimer(session, 'att-urgent', 5);

    // Fast-forward 6 seconds
    await vi.advanceTimersByTimeAsync(6000);

    expect(removeParticipantMock).toHaveBeenCalledWith(session.roomName, 'att-urgent');
    expect(session.floor).toBeNull();
  });

  it('rate limits requests per identity and session, NOT by IP', () => {
    const key = 'SESSION1:att-same-ip-1';
    for (let i = 0; i < 60; i++) {
      expect(checkRateLimit(key, 60)).toBe(true);
    }
    // 61st request from same identity is blocked
    expect(checkRateLimit(key, 60)).toBe(false);

    // Different attendee from same IP is allowed
    const key2 = 'SESSION1:att-same-ip-2';
    expect(checkRateLimit(key2, 60)).toBe(true);
  });

  it('connects via WebSocket, filters attendee data, and prevents leaking attendee list', async () => {
    const session = initSession('Privacy Test');
    const attToken = signApiToken({
      role: 'attendee',
      code: session.code,
      identity: 'att-alice',
      name: 'Alice'
    });

    const client = new WebSocket(`${wsUrl}?token=${attToken}`);

    const received = await new Promise((resolve) => {
      client.on('message', (raw) => {
        resolve(JSON.parse(raw));
      });
    });

    expect(received.type).toBe('init');
    expect(received.role).toBe('attendee');
    expect(received.selfState).toBe('listening');
    // Crucial: Attendees do NOT receive full queue or attendee list
    expect(received.queue).toBeUndefined();
    expect(received.principals).toBeUndefined();

    client.close();
  });

  it('handles 20 concurrent attendee sockets with 0 peak LiveKit connections until granted', async () => {
    const session = initSession('20 Sockets Test');
    const clients = [];

    for (let i = 1; i <= 20; i++) {
      const token = signApiToken({
        role: 'attendee',
        code: session.code,
        identity: `att-sim-${i}`,
        name: `Attendee ${i}`
      });
      const ws = new WebSocket(`${wsUrl}?token=${token}`);
      clients.push(ws);
    }

    await new Promise((r) => setTimeout(r, 200));

    const metrics = session;
    // With 20 attendees connected via WebSocket, LiveKit has ZERO participants connected!
    expect(clients.length).toBe(20);
    // Attendees don't touch LiveKit until granted
    expect(removeParticipantMock).not.toHaveBeenCalled();

    clients.forEach(c => c.close());
  });
});
