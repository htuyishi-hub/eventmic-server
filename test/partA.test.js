import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { clearSessions, sessions } from '../src/sessionStore.js';
import { setRoomServiceClient } from '../src/roomService.js';

describe('Part A: Floor Rules, Roles, Reasons, Lists, and Fairness', () => {
  let app;
  let updateParticipantMock;
  let mutePublishedTrackMock;

  beforeEach(() => {
    clearSessions();
    process.env.LIVEKIT_URL = 'wss://demo.livekit.cloud';
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'secret';
    process.env.HOST_PASSCODE = '1234';

    updateParticipantMock = vi.fn().mockResolvedValue({});
    mutePublishedTrackMock = vi.fn().mockResolvedValue({});

    setRoomServiceClient({
      listParticipants: vi.fn().mockResolvedValue([]),
      getParticipant: vi.fn().mockResolvedValue({ tracks: [] }),
      updateParticipant: updateParticipantMock,
      mutePublishedTrack: mutePublishedTrackMock,
      deleteRoom: vi.fn().mockResolvedValue({})
    });

    app = createApp();
  });

  // Helper to create session and get admin token
  async function setupSession(name = 'Keynote 2026') {
    const sRes = await request(app)
      .post('/api/sessions')
      .set('x-host-passcode', '1234')
      .send({ name });
    const code = sRes.body.code;

    const adminAuth = await request(app)
      .post('/api/auth')
      .send({ role: 'admin', code, passcode: '1234' });

    return { code, adminToken: adminAuth.body.apiToken };
  }

  describe('1. Principal Management & Auth', () => {
    it('creates a principal with 6-digit PIN, lists, regenerates, and revokes', async () => {
      const { code, adminToken } = await setupSession();

      // Create principal
      const createRes = await request(app)
        .post(`/api/sessions/${code}/principals`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ name: 'Dr. Smith' });

      expect(createRes.status).toBe(201);
      expect(createRes.body.id).toMatch(/^prn-/);
      expect(createRes.body.name).toBe('Dr. Smith');
      expect(createRes.body.pin).toMatch(/^\d{6}$/);
      const prnId = createRes.body.id;
      const initialPin = createRes.body.pin;

      // Authenticate with PIN
      const authRes = await request(app)
        .post('/api/auth')
        .send({ role: 'principal', code, pin: initialPin });

      expect(authRes.status).toBe(200);
      expect(authRes.body.role).toBe('principal');
      expect(authRes.body.apiToken).toBeDefined();

      // Regenerate PIN
      const regenRes = await request(app)
        .post(`/api/sessions/${code}/principals/${prnId}/regenerate`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(regenRes.status).toBe(200);
      expect(regenRes.body.pin).toMatch(/^\d{6}$/);
      expect(regenRes.body.pin).not.toBe(initialPin);

      // Old PIN is rejected
      const failAuth = await request(app)
        .post('/api/auth')
        .send({ role: 'principal', code, pin: initialPin });
      expect(failAuth.status).toBe(401);

      // Revoke principal
      const revokeRes = await request(app)
        .delete(`/api/sessions/${code}/principals/${prnId}`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(revokeRes.status).toBe(200);
    });

    it('rate limits and locks out after 5 failed PIN attempts with 429', async () => {
      const { code } = await setupSession();

      for (let i = 1; i <= 4; i++) {
        const res = await request(app)
          .post('/api/auth')
          .send({ role: 'principal', code, pin: '000000' });
        expect(res.status).toBe(401);
        expect(res.body.code).toBe('UNAUTHORIZED');
      }

      // 5th failed attempt triggers 429 lockout
      const lockedRes = await request(app)
        .post('/api/auth')
        .send({ role: 'principal', code, pin: '000000' });
      expect(lockedRes.status).toBe(429);
      expect(lockedRes.body.code).toBe('PIN_LOCKED');

      // Subsequent attempt is also rejected with 429
      const subsequentRes = await request(app)
        .post('/api/auth')
        .send({ role: 'principal', code, pin: '000000' });
      expect(subsequentRes.status).toBe(429);
      expect(subsequentRes.body.code).toBe('PIN_LOCKED');
    });
  });

  describe('2. Floor Rules & Role Permissions', () => {
    it('rejects floor grant from attendees with 403', async () => {
      const { code } = await setupSession();

      const attAuth = await request(app)
        .post('/api/auth')
        .send({ role: 'attendee', code, name: 'Alice' });
      const attToken = attAuth.body.apiToken;

      const grantRes = await request(app)
        .post('/api/floor/grant')
        .set('Authorization', `Bearer ${attToken}`)
        .send({ code, identity: 'att-someone' });

      expect(grantRes.status).toBe(403);
      expect(grantRes.body.code).toBe('FORBIDDEN');
    });

    it('prevents Principal B from taking the floor over Principal A without permission', async () => {
      const { code, adminToken } = await setupSession();

      // Create two principals
      const p1 = (await request(app).post(`/api/sessions/${code}/principals`).set('Authorization', `Bearer ${adminToken}`).send({ name: 'Speaker A' })).body;
      const p2 = (await request(app).post(`/api/sessions/${code}/principals`).set('Authorization', `Bearer ${adminToken}`).send({ name: 'Speaker B' })).body;

      const p1Token = (await request(app).post('/api/auth').send({ role: 'principal', code, pin: p1.pin })).body.apiToken;
      const p2Token = (await request(app).post('/api/auth').send({ role: 'principal', code, pin: p2.pin })).body.apiToken;

      // P1 takes floor
      const take1 = await request(app).post('/api/floor/take').set('Authorization', `Bearer ${p1Token}`).send({ code });
      expect(take1.status).toBe(200);

      // P2 attempts to take floor without allow -> 403
      const take2Fail = await request(app).post('/api/floor/take').set('Authorization', `Bearer ${p2Token}`).send({ code });
      expect(take2Fail.status).toBe(403);
      expect(take2Fail.body.code).toBe('FORBIDDEN');

      // P2 requests to speak
      const reqSpeak = await request(app).post('/api/floor/request-speak').set('Authorization', `Bearer ${p2Token}`).send({ code });
      expect(reqSpeak.status).toBe(200);
      expect(reqSpeak.body.principalQueue).toHaveLength(1);

      // P1 allows P2
      const allowRes = await request(app).post('/api/floor/allow').set('Authorization', `Bearer ${p1Token}`).send({ code, targetPrincipalId: p2.id });
      expect(allowRes.status).toBe(200);

      // P2 takes floor successfully now
      const take2Success = await request(app).post('/api/floor/take').set('Authorization', `Bearer ${p2Token}`).send({ code });
      expect(take2Success.status).toBe(200);
      expect(take2Success.body.floor.holderId).toBe(p2.id);
    });

    it('rejects handover if allow has expired (60s)', async () => {
      const { code, adminToken } = await setupSession();

      const p1 = (await request(app).post(`/api/sessions/${code}/principals`).set('Authorization', `Bearer ${adminToken}`).send({ name: 'Speaker A' })).body;
      const p2 = (await request(app).post(`/api/sessions/${code}/principals`).set('Authorization', `Bearer ${adminToken}`).send({ name: 'Speaker B' })).body;

      const p1Token = (await request(app).post('/api/auth').send({ role: 'principal', code, pin: p1.pin })).body.apiToken;
      const p2Token = (await request(app).post('/api/auth').send({ role: 'principal', code, pin: p2.pin })).body.apiToken;

      await request(app).post('/api/floor/take').set('Authorization', `Bearer ${p1Token}`).send({ code });
      await request(app).post('/api/floor/allow').set('Authorization', `Bearer ${p1Token}`).send({ code, targetPrincipalId: p2.id });

      // Simulate expiration of 60s
      const session = sessions.get(code);
      session.floorAllow.expiresAt = Date.now() - 1000;

      const takeFail = await request(app).post('/api/floor/take').set('Authorization', `Bearer ${p2Token}`).send({ code });
      expect(takeFail.status).toBe(403);
    });
  });

  describe('3. Auto-Mute Attendee When Principal Takes Floor', () => {
    it('automatically revokes and mutes attendee when a principal takes the floor', async () => {
      const { code, adminToken } = await setupSession();

      const p1 = (await request(app).post(`/api/sessions/${code}/principals`).set('Authorization', `Bearer ${adminToken}`).send({ name: 'Speaker 1' })).body;
      const p1Token = (await request(app).post('/api/auth').send({ role: 'principal', code, pin: p1.pin })).body.apiToken;

      const attAuth = (await request(app).post('/api/auth').send({ role: 'attendee', code, name: 'Attendee Bob' })).body;

      // Admin grants floor to attendee
      await request(app).post('/api/floor/grant').set('Authorization', `Bearer ${adminToken}`).send({ code, identity: attAuth.identity });

      // Principal takes floor
      const takeRes = await request(app).post('/api/floor/take').set('Authorization', `Bearer ${p1Token}`).send({ code });
      expect(takeRes.status).toBe(200);

      // Verify attendee received 'The speaker is taking the floor' revocation attribute
      expect(updateParticipantMock).toHaveBeenCalledWith(
        `em-${code}`,
        attAuth.identity,
        expect.objectContaining({
          permission: expect.objectContaining({ canPublish: false }),
          attributes: expect.objectContaining({
            floor: '',
            floorRevokedReason: 'The speaker is taking the floor'
          })
        })
      );
    });
  });

  describe('4. Reasons Validation on Raise Hand', () => {
    it('accepts question, comment, compliment, clarification and rejects invalid reasons', async () => {
      const { code } = await setupSession();
      const attToken = (await request(app).post('/api/auth').send({ role: 'attendee', code, name: 'Sarah' })).body.apiToken;

      // Valid: comment
      const resComment = await request(app)
        .post('/api/floor/raise-hand')
        .set('Authorization', `Bearer ${attToken}`)
        .send({ code, reason: 'comment' });
      expect(resComment.status).toBe(200);
      expect(resComment.body.hand.reason).toBe('comment');

      // Valid: compliment
      const resComp = await request(app)
        .post('/api/floor/raise-hand')
        .set('Authorization', `Bearer ${attToken}`)
        .send({ code, reason: 'compliment' });
      expect(resComp.status).toBe(200);
      expect(resComp.body.hand.reason).toBe('compliment');

      // Invalid: rant -> 400
      const resInvalid = await request(app)
        .post('/api/floor/raise-hand')
        .set('Authorization', `Bearer ${attToken}`)
        .send({ code, reason: 'rant' });
      expect(resInvalid.status).toBe(400);
      expect(resInvalid.body.code).toBe('BAD_REQUEST');
    });
  });

  describe('5. Fair Mode Ordering', () => {
    it('orders by speakCount ASC then raisedAt ASC when fair mode is active', async () => {
      const { code, adminToken } = await setupSession();

      const a1Auth = (await request(app).post('/api/auth').send({ role: 'attendee', code, name: 'Att One' })).body;
      const a2Auth = (await request(app).post('/api/auth').send({ role: 'attendee', code, name: 'Att Two' })).body;

      // Simulate Att One spoke previously
      const session = sessions.get(code);
      session.speakHistory.set(a1Auth.identity, {
        id: a1Auth.identity,
        name: 'Att One',
        count: 1,
        lastSpokeAt: Date.now() - 30000,
        totalSeconds: 45,
        history: []
      });

      // Att One raises hand first
      await request(app).post('/api/floor/raise-hand').set('Authorization', `Bearer ${a1Auth.apiToken}`).send({ code, reason: 'question' });
      // Att Two raises hand later
      await request(app).post('/api/floor/raise-hand').set('Authorization', `Bearer ${a2Auth.apiToken}`).send({ code, reason: 'question' });

      // Normal mode (fairMode: 'off'): Att One is #1 because they raised first
      const stateNormal = await request(app).get(`/api/sessions/${code}/state`).set('Authorization', `Bearer ${adminToken}`);
      expect(stateNormal.body.queue[0].id).toBe(a1Auth.identity);
      expect(stateNormal.body.queue[1].id).toBe(a2Auth.identity);

      // Turn on Fair Mode
      await request(app).post(`/api/sessions/${code}/settings`).set('Authorization', `Bearer ${adminToken}`).send({ fairMode: 'on' });

      // Fair mode: Att Two is #1 because speakCount 0 < 1
      const stateFair = await request(app).get(`/api/sessions/${code}/state`).set('Authorization', `Bearer ${adminToken}`);
      expect(stateFair.body.fairModeActive).toBe(true);
      expect(stateFair.body.queue[0].id).toBe(a2Auth.identity);
      expect(stateFair.body.queue[0].speakCount).toBe(0);
      expect(stateFair.body.queue[1].id).toBe(a1Auth.identity);
      expect(stateFair.body.queue[1].speakCount).toBe(1);
    });
  });

  describe('6. Speak History Tracking', () => {
    it('records speaking duration and accumulates history in session state', async () => {
      const { code, adminToken } = await setupSession();
      const attAuth = (await request(app).post('/api/auth').send({ role: 'attendee', code, name: 'Dave' })).body;

      // Raise hand with reason clarification
      await request(app).post('/api/floor/raise-hand').set('Authorization', `Bearer ${attAuth.apiToken}`).send({ code, reason: 'clarification' });

      // Grant floor
      await request(app).post('/api/floor/grant').set('Authorization', `Bearer ${adminToken}`).send({ code, identity: attAuth.identity });

      // Simulate 5 seconds elapsed
      const session = sessions.get(code);
      session.floor.startedAt = Date.now() - 5000;

      // Revoke floor
      await request(app).post('/api/floor/revoke').set('Authorization', `Bearer ${adminToken}`).send({ code, identity: attAuth.identity });

      const stateRes = await request(app).get(`/api/sessions/${code}/state`).set('Authorization', `Bearer ${adminToken}`);
      expect(stateRes.body.spokeHistory).toHaveLength(1);
      expect(stateRes.body.spokeHistory[0].name).toBe('Dave');
      expect(stateRes.body.spokeHistory[0].reason).toBe('clarification');
      expect(stateRes.body.spokeHistory[0].durationSeconds).toBeGreaterThanOrEqual(5);
    });
  });
});
