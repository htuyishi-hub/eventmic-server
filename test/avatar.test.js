import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { initSession, clearSessions } from '../src/sessionStore.js';
import { signApiToken } from '../src/auth.js';
import { avatarStore } from '../src/avatarStore.js';

describe('Temporary Profile Photos / Avatars (eventmic-server)', () => {
  let app;
  let session;
  let code;
  let adminToken;
  let principalToken;
  let attendee1Token;
  let attendee2Token;

  const adminPasscode = 'test-passcode';

  beforeEach(async () => {
    process.env.HOST_PASSCODE = adminPasscode;
    clearSessions();
    app = createApp();

    session = initSession('Avatar Test Session');
    code = session.code;

    adminToken = signApiToken({ role: 'admin', code, identity: 'admin-id' });
    principalToken = signApiToken({ role: 'principal', code, identity: 'prn-speaker1', name: 'Speaker One' });
    attendee1Token = signApiToken({ role: 'attendee', code, identity: 'att-alice', name: 'Alice' });
    attendee2Token = signApiToken({ role: 'attendee', code, identity: 'att-bob', name: 'Bob' });
  });

  afterEach(() => {
    clearSessions();
  });

  // Helper to create test image buffer of specified format and size
  async function makeTestImage(format = 'jpeg', width = 100, height = 100) {
    const s = sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 120, g: 150, b: 200 }
      }
    });
    if (format === 'png') return s.png().toBuffer();
    if (format === 'webp') return s.webp().toBuffer();
    return s.jpeg().toBuffer();
  }

  describe('1. Magic-byte verification and Type Rejection', () => {
    it('rejects plain text disguised as image with 400', async () => {
      const fakeImage = Buffer.from('This is not an image at all!');
      const res = await request(app)
        .post('/api/avatar')
        .set('Authorization', `Bearer ${attendee1Token}`)
        .set('Content-Type', 'image/jpeg')
        .send(fakeImage);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_IMAGE_TYPE');
    });

    it('rejects unsupported image types (e.g. GIF) with 400', async () => {
      const gifBuf = await sharp({
        create: { width: 10, height: 10, channels: 3, background: 'red' }
      }).gif().toBuffer();

      const res = await request(app)
        .post('/api/avatar')
        .set('Authorization', `Bearer ${attendee1Token}`)
        .set('Content-Type', 'image/gif')
        .send(gifBuf);

      expect(res.status).toBe(400);
      expect(res.body.code).toBe('INVALID_IMAGE_TYPE');
    });

    it('accepts valid JPEG, PNG, and WebP, re-encoding to 256x256 WebP', async () => {
      for (const fmt of ['jpeg', 'png', 'webp']) {
        const img = await makeTestImage(fmt, 120, 120);
        const res = await request(app)
          .post('/api/avatar')
          .set('Authorization', `Bearer ${attendee1Token}`)
          .set('Content-Type', `image/${fmt}`)
          .send(img);

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.identity).toBe('att-alice');
        expect(typeof res.body.version).toBe('number');
      }

      // Verify stored format is 256x256 WebP
      const stored = avatarStore.getAvatar(code, 'att-alice');
      expect(stored).not.toBeNull();
      expect(stored.mime).toBe('image/webp');
      const meta = await sharp(stored.bytes).metadata();
      expect(meta.format).toBe('webp');
      expect(meta.width).toBe(256);
      expect(meta.height).toBe(256);
    });

    it('accepts base64 encoded JSON body', async () => {
      const img = await makeTestImage('jpeg', 80, 80);
      const b64 = `data:image/jpeg;base64,${img.toString('base64')}`;

      const res = await request(app)
        .post('/api/avatar')
        .set('Authorization', `Bearer ${attendee1Token}`)
        .send({ image: b64 });

      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });
  });

  describe('2. Size Limits & Session Cap', () => {
    it('rejects image exceeding 150 KB with 413', async () => {
      // 150 KB = 153,600 bytes. Generate > 150 KB buffer.
      const largeBuf = Buffer.alloc(160 * 1024, 0xFF);
      // Give it jpeg header so magic bytes pass
      largeBuf[0] = 0xFF;
      largeBuf[1] = 0xD8;
      largeBuf[2] = 0xFF;

      const res = await request(app)
        .post('/api/avatar')
        .set('Authorization', `Bearer ${attendee1Token}`)
        .set('Content-Type', 'image/jpeg')
        .send(largeBuf);

      expect(res.status).toBe(413);
      expect(res.body.code).toBe('AVATAR_TOO_LARGE');
    });

    it('enforces session total cap of 50 MB', async () => {
      // Create a store with small cap for testing
      const customStore = new (avatarStore.constructor)({ sessionCapBytes: 500 });
      const smallBuf = Buffer.alloc(300, 0x11);
      customStore.setAvatar('TEST', 'user1', smallBuf);

      expect(() => {
        customStore.setAvatar('TEST', 'user2', smallBuf);
      }).toThrow(/Session avatar storage cap exceeded/);
    });
  });

  describe('3. Rate Limiting (5 uploads / min per identity)', () => {
    it('allows 5 uploads per minute and rejects the 6th with 429', async () => {
      const img = await makeTestImage('jpeg', 40, 40);

      for (let i = 1; i <= 5; i++) {
        const res = await request(app)
          .post('/api/avatar')
          .set('Authorization', `Bearer ${attendee1Token}`)
          .set('Content-Type', 'image/jpeg')
          .send(img);
        expect(res.status).toBe(200);
      }

      // 6th upload should be blocked
      const blockedRes = await request(app)
        .post('/api/avatar')
        .set('Authorization', `Bearer ${attendee1Token}`)
        .set('Content-Type', 'image/jpeg')
        .send(img);

      expect(blockedRes.status).toBe(429);
      expect(blockedRes.body.code).toBe('RATE_LIMITED');

      // Different identity is NOT rate-limited
      const otherRes = await request(app)
        .post('/api/avatar')
        .set('Authorization', `Bearer ${attendee2Token}`)
        .set('Content-Type', 'image/jpeg')
        .send(img);
      expect(otherRes.status).toBe(200);
    });
  });

  describe('4. Role Access and Visibility Rules', () => {
    beforeEach(async () => {
      const img = await makeTestImage('jpeg', 50, 50);
      await request(app)
        .post('/api/avatar')
        .set('Authorization', `Bearer ${attendee1Token}`)
        .set('Content-Type', 'image/jpeg')
        .send(img);
    });

    it('allows attendee to fetch their own avatar', async () => {
      const res = await request(app)
        .get(`/api/avatar/${code}/att-alice`)
        .set('Authorization', `Bearer ${attendee1Token}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('image/webp');
      expect(res.headers['cache-control']).toBe('private, max-age=300');
      expect(res.headers['etag']).toBeDefined();
    });

    it('allows admin and principals to fetch any participant avatar', async () => {
      const adminRes = await request(app)
        .get(`/api/avatar/${code}/att-alice`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(adminRes.status).toBe(200);

      const princRes = await request(app)
        .get(`/api/avatar/${code}/att-alice`)
        .set('Authorization', `Bearer ${principalToken}`);
      expect(princRes.status).toBe(200);
    });

    it('forbids attendee from fetching another attendee avatar when they do NOT hold the floor', async () => {
      const res = await request(app)
        .get(`/api/avatar/${code}/att-alice`)
        .set('Authorization', `Bearer ${attendee2Token}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('FORBIDDEN');
    });

    it('allows attendee to fetch another attendee avatar WHEN they hold the floor', async () => {
      // Set Alice as current floor holder
      session.floor = {
        holderId: 'att-alice',
        holderName: 'Alice',
        holderRole: 'attendee',
        startedAt: Date.now(),
        mode: 'attendee'
      };

      const res = await request(app)
        .get(`/api/avatar/${code}/att-alice`)
        .set('Authorization', `Bearer ${attendee2Token}`);

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('image/webp');
    });

    it('returns 304 Not Modified when ETag matches If-None-Match', async () => {
      const fetchRes = await request(app)
        .get(`/api/avatar/${code}/att-alice`)
        .set('Authorization', `Bearer ${attendee1Token}`);

      expect(fetchRes.status).toBe(200);
      const etag = fetchRes.headers['etag'];

      const cachedRes = await request(app)
        .get(`/api/avatar/${code}/att-alice`)
        .set('Authorization', `Bearer ${attendee1Token}`)
        .set('If-None-Match', etag);

      expect(cachedRes.status).toBe(304);
    });
  });

  describe('5. Settings: photos = "off"', () => {
    beforeEach(async () => {
      session.settings.photos = 'off';
    });

    it('rejects uploads with 403 PHOTOS_DISABLED when photos setting is off', async () => {
      const img = await makeTestImage('jpeg', 40, 40);
      const res = await request(app)
        .post('/api/avatar')
        .set('Authorization', `Bearer ${attendee1Token}`)
        .set('Content-Type', 'image/jpeg')
        .send(img);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PHOTOS_DISABLED');
    });

    it('rejects GET requests with 403 PHOTOS_DISABLED when photos setting is off', async () => {
      // Put avatar into store directly
      const img = await makeTestImage('webp', 40, 40);
      avatarStore.setAvatar(code, 'att-alice', img);

      const res = await request(app)
        .get(`/api/avatar/${code}/att-alice`)
        .set('Authorization', `Bearer ${attendee1Token}`);

      expect(res.status).toBe(403);
      expect(res.body.code).toBe('PHOTOS_DISABLED');
    });
  });

  describe('6. Deletion Lifecycle', () => {
    beforeEach(async () => {
      const img = await makeTestImage('jpeg', 50, 50);
      await request(app)
        .post('/api/avatar')
        .set('Authorization', `Bearer ${attendee1Token}`)
        .set('Content-Type', 'image/jpeg')
        .send(img);
    });

    it('allows participant to delete their own avatar via DELETE /api/avatar', async () => {
      const delRes = await request(app)
        .delete('/api/avatar')
        .set('Authorization', `Bearer ${attendee1Token}`);

      expect(delRes.status).toBe(200);
      expect(delRes.body.ok).toBe(true);

      const getRes = await request(app)
        .get(`/api/avatar/${code}/att-alice`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(getRes.status).toBe(404);
      expect(getRes.body.code).toBe('AVATAR_NOT_FOUND');
    });

    it('allows admin to delete any avatar via DELETE /api/avatar/:identity', async () => {
      const delRes = await request(app)
        .delete(`/api/avatar/att-alice?code=${code}`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(delRes.status).toBe(200);

      const getRes = await request(app)
        .get(`/api/avatar/${code}/att-alice`)
        .set('Authorization', `Bearer ${adminToken}`);
      expect(getRes.status).toBe(404);
    });

    it('deletes avatar when participant is removed via admin remove route', async () => {
      const removeRes = await request(app)
        .post(`/api/sessions/${code}/attendees/att-alice/remove`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(removeRes.status).toBe(200);

      expect(avatarStore.getAvatar(code, 'att-alice')).toBeNull();
    });

    it('deletes all session avatars when session ends', async () => {
      expect(avatarStore.getAvatar(code, 'att-alice')).not.toBeNull();

      const endRes = await request(app)
        .post(`/api/sessions/${code}/end`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(endRes.status).toBe(200);
      expect(avatarStore.getAvatar(code, 'att-alice')).toBeNull();
      expect(avatarStore.getSessionBytes(code)).toBe(0);
    });
  });

  describe('7. Disconnect Grace Period and State Messages', () => {
    it('state responses contain hasAvatar and avatarVersion, never image bytes', async () => {
      const img = await makeTestImage('jpeg', 50, 50);
      await request(app)
        .post('/api/avatar')
        .set('Authorization', `Bearer ${attendee1Token}`)
        .set('Content-Type', 'image/jpeg')
        .send(img);

      // Add to hands
      session.attendeeHands.set('att-alice', {
        id: 'att-alice',
        name: 'Alice',
        reason: 'question',
        raisedAt: Date.now()
      });

      const res = await request(app)
        .get(`/api/sessions/${code}/state`)
        .set('Authorization', `Bearer ${adminToken}`);

      expect(res.status).toBe(200);
      const queueItem = res.body.queue.find(q => q.id === 'att-alice');
      expect(queueItem).toBeDefined();
      expect(queueItem.hasAvatar).toBe(true);
      expect(queueItem.avatarVersion).toBe(1);

      // Ensure no raw bytes are in JSON payload
      const jsonStr = JSON.stringify(res.body);
      expect(jsonStr).not.toContain('image/webp');
      expect(jsonStr.length).toBeLessThan(10000);
    });

    it('cleans up avatar on disconnect grace period expiration', async () => {
      const customStore = new (avatarStore.constructor)({ disconnectGraceMs: 20 });
      const img = await makeTestImage('webp', 30, 30);
      customStore.setAvatar('DISC_SESS', 'user-disc', img);

      expect(customStore.getAvatar('DISC_SESS', 'user-disc')).not.toBeNull();

      let cleanedUp = false;
      customStore.scheduleDisconnectCleanup('DISC_SESS', 'user-disc', () => {
        cleanedUp = true;
      });

      // Wait 30ms for timer to fire
      await new Promise(r => setTimeout(r, 35));

      expect(cleanedUp).toBe(true);
      expect(customStore.getAvatar('DISC_SESS', 'user-disc')).toBeNull();
    });

    it('cancels cleanup if user reconnects before grace period expires', async () => {
      const customStore = new (avatarStore.constructor)({ disconnectGraceMs: 40 });
      const img = await makeTestImage('webp', 30, 30);
      customStore.setAvatar('RECONN_SESS', 'user-reconn', img);

      customStore.scheduleDisconnectCleanup('RECONN_SESS', 'user-reconn');
      // User returns at 10ms
      await new Promise(r => setTimeout(r, 10));
      customStore.cancelDisconnectCleanup('RECONN_SESS', 'user-reconn');

      // Wait past the 40ms mark
      await new Promise(r => setTimeout(r, 45));

      // Avatar should still be present
      expect(customStore.getAvatar('RECONN_SESS', 'user-reconn')).not.toBeNull();
    });
  });
});
