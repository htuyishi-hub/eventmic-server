import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { TokenVerifier, TrackSource, TrackType } from 'livekit-server-sdk';
import { createApp } from '../src/app.js';
import { sessions, clearSessions } from '../src/sessionStore.js';
import { setRoomServiceClient } from '../src/roomService.js';

describe('EventMic Server API', () => {
  let app;
  const verifier = new TokenVerifier('devkey', 'secret');

  beforeEach(() => {
    clearSessions();
    process.env.LIVEKIT_URL = 'wss://demo.livekit.cloud';
    process.env.LIVEKIT_API_KEY = 'devkey';
    process.env.LIVEKIT_API_SECRET = 'secret';
    process.env.HOST_PASSCODE = '1234';

    // Default mock RoomServiceClient
    setRoomServiceClient({
      listParticipants: vi.fn().mockResolvedValue([]),
      getParticipant: vi.fn().mockResolvedValue({ tracks: [] }),
      updateParticipant: vi.fn().mockResolvedValue({}),
      mutePublishedTrack: vi.fn().mockResolvedValue({}),
      deleteRoom: vi.fn().mockResolvedValue({})
    });

    app = createApp();
  });

  describe('Passcode & Session Creation', () => {
    it('rejects session creation without passcode (401)', async () => {
      const res = await request(app)
        .post('/api/sessions')
        .send({ name: 'Keynote Session' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('rejects session creation with invalid passcode (401)', async () => {
      const res = await request(app)
        .post('/api/sessions')
        .set('x-host-passcode', 'wrong')
        .send({ name: 'Keynote Session' });

      expect(res.status).toBe(401);
      expect(res.body.code).toBe('UNAUTHORIZED');
    });

    it('validates session name length 3..60 chars', async () => {
      const resShort = await request(app)
        .post('/api/sessions')
        .set('x-host-passcode', '1234')
        .send({ name: 'ab' });
      expect(resShort.status).toBe(400);
      expect(resShort.body.code).toBe('BAD_REQUEST');

      const resLong = await request(app)
        .post('/api/sessions')
        .set('x-host-passcode', '1234')
        .send({ name: 'a'.repeat(61) });
      expect(resLong.status).toBe(400);
      expect(resLong.body.code).toBe('BAD_REQUEST');
    });

    it('creates a session with valid code and returns 201', async () => {
      const res = await request(app)
        .post('/api/sessions')
        .set('x-host-passcode', '1234')
        .send({ name: 'Town Hall 2026' });

      expect(res.status).toBe(201);
      expect(res.body.code).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
      expect(res.body.name).toBe('Town Hall 2026');
      expect(res.body.createdAt).toBeTypeOf('number');
    });
  });

  describe('Session Info & Lifecycle', () => {
    it('returns 404 for unknown session code', async () => {
      const res = await request(app).get('/api/sessions/ZZZZZZ');
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('INVALID_CODE');
    });

    it('retrieves live session details publicly', async () => {
      const createRes = await request(app)
        .post('/api/sessions')
        .set('x-host-passcode', '1234')
        .send({ name: 'DevConf' });

      const code = createRes.body.code;
      const res = await request(app).get(`/api/sessions/${code}`);
      expect(res.status).toBe(200);
      expect(res.body.code).toBe(code);
      expect(res.body.name).toBe('DevConf');
      expect(res.body.status).toBe('live');
    });

    it('ends session, deletes LiveKit room and returns summary', async () => {
      const deleteRoomMock = vi.fn().mockResolvedValue({});
      setRoomServiceClient({
        listParticipants: vi.fn().mockResolvedValue([]),
        deleteRoom: deleteRoomMock
      });

      const createRes = await request(app)
        .post('/api/sessions')
        .set('x-host-passcode', '1234')
        .send({ name: 'Keynote' });
      const code = createRes.body.code;

      const endRes = await request(app)
        .post(`/api/sessions/${code}/end`)
        .set('x-host-passcode', '1234')
        .send({ handsRaised: 5, speakerCount: 2 });

      expect(endRes.status).toBe(200);
      expect(endRes.body.speakerCount).toBe(2);
      expect(endRes.body.handsRaised).toBe(5);
      expect(endRes.body.durationSec).toBeGreaterThanOrEqual(1);
      expect(deleteRoomMock).toHaveBeenCalledWith(`em-${code}`);

      // Token request after end returns 410 SESSION_ENDED
      const tokenRes = await request(app)
        .post('/api/token')
        .send({ role: 'attendee', code, name: 'Alice' });
      expect(tokenRes.status).toBe(410);
      expect(tokenRes.body.code).toBe('SESSION_ENDED');
    });
  });

  describe('Token Generation & Permissions', () => {
    it('creates host token with correct permissions', async () => {
      const createRes = await request(app)
        .post('/api/sessions')
        .set('x-host-passcode', '1234')
        .send({ name: 'Host Permissions Test' });
      const code = createRes.body.code;

      const res = await request(app)
        .post('/api/token')
        .set('x-host-passcode', '1234')
        .send({ role: 'host', code });

      expect(res.status).toBe(200);
      expect(res.body.token).toBeTypeOf('string');

      const claims = await verifier.verify(res.body.token);
      expect(claims.sub).toMatch(/^host-/);
      expect(claims.video.room).toBe(`em-${code}`);
      expect(claims.video.roomJoin).toBe(true);
      expect(claims.video.roomAdmin).toBe(true);
      expect(claims.video.canSubscribe).toBe(true);
      expect(claims.video.canPublish).toBe(false);
      expect(claims.video.canPublishData).toBe(true);
      expect(claims.video.canUpdateOwnMetadata).toBe(true);
    });

    it('creates attendee token with canPublish false and preserves client identity', async () => {
      const createRes = await request(app)
        .post('/api/sessions')
        .set('x-host-passcode', '1234')
        .send({ name: 'Attendee Permissions Test' });
      const code = createRes.body.code;

      const clientIdentity = 'att-xyz123abc';
      const res = await request(app)
        .post('/api/token')
        .send({ role: 'attendee', code, name: 'Bob', identity: clientIdentity });

      expect(res.status).toBe(200);
      const claims = await verifier.verify(res.body.token);
      expect(claims.sub).toBe(clientIdentity);
      expect(claims.video.room).toBe(`em-${code}`);
      expect(claims.video.roomJoin).toBe(true);
      expect(claims.video.canPublish).toBe(false);
      expect(claims.video.canSubscribe).toBe(false);
      expect(claims.video.canPublishData).toBe(false);
      expect(claims.video.canUpdateOwnMetadata).toBe(true);
    });

    it('enforces 200 attendee cap (409 FULL)', async () => {
      const createRes = await request(app)
        .post('/api/sessions')
        .set('x-host-passcode', '1234')
        .send({ name: 'Full Session Test' });
      const code = createRes.body.code;

      // Mock 200 attendees already in room
      const fakeParticipants = Array.from({ length: 200 }, (_, i) => ({
        identity: `att-user${i}`
      }));

      setRoomServiceClient({
        listParticipants: vi.fn().mockResolvedValue(fakeParticipants)
      });

      const res = await request(app)
        .post('/api/token')
        .send({ role: 'attendee', code, name: 'Attendee 201' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('FULL');
    });
  });

  describe('Floor Management (Grant, Revoke, Mute)', () => {
    it('grant revokes previous speaker and grants new speaker', async () => {
      const createRes = await request(app)
        .post('/api/sessions')
        .set('x-host-passcode', '1234')
        .send({ name: 'Floor Grant Test' });
      const code = createRes.body.code;

      const updateParticipantMock = vi.fn().mockResolvedValue({});
      const mutePublishedTrackMock = vi.fn().mockResolvedValue({});

      // Previous speaker identity: 'att-first'
      const existingParticipants = [
        {
          identity: 'att-first',
          permission: { canPublish: true },
          tracks: [{ sid: 'track-mic-1', type: TrackType.AUDIO, source: TrackSource.MICROPHONE, muted: false }]
        },
        {
          identity: 'att-second',
          permission: { canPublish: false },
          tracks: []
        }
      ];

      setRoomServiceClient({
        listParticipants: vi.fn().mockResolvedValue(existingParticipants),
        updateParticipant: updateParticipantMock,
        mutePublishedTrack: mutePublishedTrackMock
      });

      const res = await request(app)
        .post('/api/floor/grant')
        .set('x-host-passcode', '1234')
        .send({ code, identity: 'att-second' });

      expect(res.status).toBe(200);

      // Verify previous speaker revoked
      expect(updateParticipantMock).toHaveBeenCalledWith(`em-${code}`, 'att-first', {
        permission: {
          canPublish: false,
          canSubscribe: false,
          canPublishData: false,
          canUpdateOwnMetadata: true
        },
        attributes: { floor: '' }
      });
      expect(mutePublishedTrackMock).toHaveBeenCalledWith(`em-${code}`, 'att-first', 'track-mic-1', true);

      // Verify new speaker granted
      expect(updateParticipantMock).toHaveBeenCalledWith(`em-${code}`, 'att-second', {
        permission: {
          canPublish: true,
          canPublishSources: [TrackSource.MICROPHONE],
          canSubscribe: false,
          canPublishData: false,
          canUpdateOwnMetadata: true
        },
        attributes: { floor: 'granted', hand: '' }
      });

      // Verify speakerCount incremented
      const session = sessions.get(code);
      expect(session.speakerCount).toBe(1);
    });

    it('revoke clears floor attribute and permissions', async () => {
      const createRes = await request(app)
        .post('/api/sessions')
        .set('x-host-passcode', '1234')
        .send({ name: 'Revoke Test' });
      const code = createRes.body.code;

      const updateParticipantMock = vi.fn().mockResolvedValue({});
      const mutePublishedTrackMock = vi.fn().mockResolvedValue({});

      setRoomServiceClient({
        updateParticipant: updateParticipantMock,
        getParticipant: vi.fn().mockResolvedValue({
          tracks: [{ sid: 'track-1', type: TrackType.AUDIO, source: TrackSource.MICROPHONE }]
        }),
        mutePublishedTrack: mutePublishedTrackMock
      });

      const res = await request(app)
        .post('/api/floor/revoke')
        .set('x-host-passcode', '1234')
        .send({ code, identity: 'att-speaker' });

      expect(res.status).toBe(200);
      expect(updateParticipantMock).toHaveBeenCalledWith(`em-${code}`, 'att-speaker', {
        permission: {
          canPublish: false,
          canSubscribe: false,
          canPublishData: false,
          canUpdateOwnMetadata: true
        },
        attributes: { floor: '' }
      });
      expect(mutePublishedTrackMock).toHaveBeenCalledWith(`em-${code}`, 'att-speaker', 'track-1', true);
    });

    it('mute calls mutePublishedTrack for speaker', async () => {
      const createRes = await request(app)
        .post('/api/sessions')
        .set('x-host-passcode', '1234')
        .send({ name: 'Mute Test' });
      const code = createRes.body.code;

      const mutePublishedTrackMock = vi.fn().mockResolvedValue({});
      setRoomServiceClient({
        getParticipant: vi.fn().mockResolvedValue({
          tracks: [{ sid: 'track-mic-99', type: TrackType.AUDIO, source: TrackSource.MICROPHONE }]
        }),
        mutePublishedTrack: mutePublishedTrackMock
      });

      const res = await request(app)
        .post('/api/floor/mute')
        .set('x-host-passcode', '1234')
        .send({ code, identity: 'att-speaker', muted: true });

      expect(res.status).toBe(200);
      expect(mutePublishedTrackMock).toHaveBeenCalledWith(`em-${code}`, 'att-speaker', 'track-mic-99', true);
    });
  });
});
