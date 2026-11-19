import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { AccessToken, TrackSource, TrackType } from 'livekit-server-sdk';
import { sessions, generateUniqueCode } from './sessionStore.js';
import { requireHostAuth, timingSafeCompare } from './auth.js';
import { getRoomServiceClient } from './roomService.js';

export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json());

  // Rate limiters
  const sessionCreateLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { code: 'RATE_LIMITED', error: 'Too many session creation requests, please try again later' }
  });

  const tokenLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { code: 'RATE_LIMITED', error: 'Too many token requests, please try again later' }
  });

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // 1. Create session (Host)
  app.post('/api/sessions', sessionCreateLimiter, requireHostAuth, (req, res) => {
    const rawName = req.body?.name;
    if (typeof rawName !== 'string') {
      return res.status(400).json({ code: 'BAD_REQUEST', error: 'Session name is required' });
    }

    const name = rawName.trim();
    if (name.length < 3 || name.length > 60) {
      return res.status(400).json({
        code: 'BAD_REQUEST',
        error: 'Session name must be between 3 and 60 characters'
      });
    }

    const code = generateUniqueCode();
    const session = {
      code,
      name,
      roomName: `em-${code}`,
      createdAt: Date.now(),
      status: 'live',
      speakerCount: 0,
      handsRaised: 0
    };

    sessions.set(code, session);
    res.status(201).json({
      code: session.code,
      name: session.name,
      createdAt: session.createdAt
    });
  });

  // 2. Get session info (Public)
  app.get('/api/sessions/:code', (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    const session = sessions.get(code);

    if (!session) {
      return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });
    }

    res.json({
      code: session.code,
      name: session.name,
      status: session.status
    });
  });

  // 3. Issue LiveKit token (Host or Attendee)
  app.post('/api/token', tokenLimiter, async (req, res) => {
    const { role, code: rawCode, name: rawName, identity: clientIdentity } = req.body || {};

    if (!role || (role !== 'host' && role !== 'attendee')) {
      return res.status(400).json({ code: 'BAD_REQUEST', error: 'Role must be host or attendee' });
    }

    const code = String(rawCode || '').trim().toUpperCase();
    const session = sessions.get(code);

    if (!session) {
      return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });
    }

    if (session.status === 'ended') {
      return res.status(410).json({ code: 'SESSION_ENDED', error: 'Session has ended' });
    }

    const livekitUrl = process.env.LIVEKIT_URL || 'wss://demo.livekit.cloud';
    const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
    const apiSecret = process.env.LIVEKIT_API_SECRET || 'secret';

    if (role === 'host') {
      const provided = req.headers['x-host-passcode'];
      const expected = process.env.HOST_PASSCODE || '1234';

      if (!provided || !timingSafeCompare(provided, expected)) {
        return res.status(401).json({ code: 'UNAUTHORIZED', error: 'Invalid host passcode' });
      }

      const identity = 'host-' + Math.random().toString(36).substring(2, 10);
      const hostName = (typeof rawName === 'string' && rawName.trim()) ? rawName.trim() : 'Host';

      const at = new AccessToken(apiKey, apiSecret, {
        identity,
        name: hostName,
        ttl: '6h'
      });

      at.addGrant({
        room: session.roomName,
        roomJoin: true,
        roomAdmin: true,
        canSubscribe: true,
        canPublish: false,
        canPublishData: true,
        canUpdateOwnMetadata: true
      });

      const token = await at.toJwt();
      return res.json({ token, url: livekitUrl });
    }

    // Role is attendee
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (name.length < 2 || name.length > 30) {
      return res.status(400).json({
        code: 'BAD_REQUEST',
        error: 'Attendee name must be between 2 and 30 characters'
      });
    }

    // Sanitize identity or generate new one
    let identity = '';
    if (typeof clientIdentity === 'string' && /^att-[a-z0-9]{6,16}$/.test(clientIdentity)) {
      identity = clientIdentity;
    } else {
      identity = 'att-' + Math.random().toString(36).substring(2, 12);
    }

    // Check attendee cap (max 200)
    try {
      const roomService = getRoomServiceClient();
      const participants = await roomService.listParticipants(session.roomName);
      const attendeeCount = participants.filter(p => p.identity?.startsWith('att-')).length;
      if (attendeeCount >= 200) {
        return res.status(409).json({
          code: 'FULL',
          error: 'Session is full (maximum 200 attendees reached)'
        });
      }
    } catch {
      // Room may not exist yet on LiveKit before any connection
    }

    const at = new AccessToken(apiKey, apiSecret, {
      identity,
      name,
      ttl: '3h'
    });

    at.addGrant({
      room: session.roomName,
      roomJoin: true,
      canSubscribe: false,
      canPublish: false,
      canPublishData: false,
      canUpdateOwnMetadata: true
    });

    const token = await at.toJwt();
    return res.json({ token, url: livekitUrl });
  });

  // 4. Floor grant (Host)
  app.post('/api/floor/grant', requireHostAuth, async (req, res) => {
    const { code: rawCode, identity } = req.body || {};
    if (!identity || typeof identity !== 'string') {
      return res.status(400).json({ code: 'BAD_REQUEST', error: 'Target identity is required' });
    }

    const code = String(rawCode || '').trim().toUpperCase();
    const session = sessions.get(code);

    if (!session) {
      return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });
    }
    if (session.status === 'ended') {
      return res.status(410).json({ code: 'SESSION_ENDED', error: 'Session has ended' });
    }

    const roomService = getRoomServiceClient();

    try {
      // Step 1: Revoke existing speaker
      const participants = await roomService.listParticipants(session.roomName);
      for (const p of participants) {
        if (p.identity.startsWith('att-') && p.permission?.canPublish && p.identity !== identity) {
          await roomService.updateParticipant(session.roomName, p.identity, {
            permission: {
              canPublish: false,
              canSubscribe: false,
              canPublishData: false,
              canUpdateOwnMetadata: true
            },
            attributes: {
              floor: ''
            }
          });
          const mic = p.tracks?.find(t => t.source === TrackSource.MICROPHONE || t.type === TrackType.AUDIO);
          if (mic && !mic.muted) {
            try {
              await roomService.mutePublishedTrack(session.roomName, p.identity, mic.sid, true);
            } catch {}
          }
        }
      }

      // Step 2: Grant target speaker
      await roomService.updateParticipant(session.roomName, identity, {
        permission: {
          canPublish: true,
          canPublishSources: [TrackSource.MICROPHONE],
          canSubscribe: false,
          canPublishData: false,
          canUpdateOwnMetadata: true
        },
        attributes: {
          floor: 'granted',
          hand: ''
        }
      });

      // Step 3: Increment speaker count
      session.speakerCount++;

      return res.json({ ok: true });
    } catch (err) {
      console.error('Error granting floor:', err);
      return res.status(500).json({ code: 'UNKNOWN', error: 'Failed to grant floor' });
    }
  });

  // 5. Floor revoke (Host)
  app.post('/api/floor/revoke', requireHostAuth, async (req, res) => {
    const { code: rawCode, identity } = req.body || {};
    if (!identity || typeof identity !== 'string') {
      return res.status(400).json({ code: 'BAD_REQUEST', error: 'Target identity is required' });
    }

    const code = String(rawCode || '').trim().toUpperCase();
    const session = sessions.get(code);

    if (!session) {
      return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });
    }

    const roomService = getRoomServiceClient();

    try {
      await roomService.updateParticipant(session.roomName, identity, {
        permission: {
          canPublish: false,
          canSubscribe: false,
          canPublishData: false,
          canUpdateOwnMetadata: true
        },
        attributes: {
          floor: ''
        }
      });

      try {
        const participant = await roomService.getParticipant(session.roomName, identity);
        const mic = participant.tracks?.find(t => t.source === TrackSource.MICROPHONE || t.type === TrackType.AUDIO);
        if (mic) {
          await roomService.mutePublishedTrack(session.roomName, identity, mic.sid, true);
        }
      } catch {}

      return res.json({ ok: true });
    } catch (err) {
      console.error('Error revoking floor:', err);
      return res.status(500).json({ code: 'UNKNOWN', error: 'Failed to revoke floor' });
    }
  });

  // 6. Floor mute (Host)
  app.post('/api/floor/mute', requireHostAuth, async (req, res) => {
    const { code: rawCode, identity, muted } = req.body || {};
    if (!identity || typeof identity !== 'string') {
      return res.status(400).json({ code: 'BAD_REQUEST', error: 'Target identity is required' });
    }

    const code = String(rawCode || '').trim().toUpperCase();
    const session = sessions.get(code);

    if (!session) {
      return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });
    }

    const roomService = getRoomServiceClient();

    try {
      const participant = await roomService.getParticipant(session.roomName, identity);
      const mic = participant.tracks?.find(t => t.source === TrackSource.MICROPHONE || t.type === TrackType.AUDIO);
      if (mic) {
        await roomService.mutePublishedTrack(session.roomName, identity, mic.sid, Boolean(muted));
      }
      return res.json({ ok: true });
    } catch (err) {
      console.warn('Failed to mute published track:', err);
      return res.json({ ok: true });
    }
  });

  // 7. End session (Host)
  app.post('/api/sessions/:code/end', requireHostAuth, async (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    const session = sessions.get(code);

    if (!session) {
      return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });
    }

    session.status = 'ended';
    if (req.body?.handsRaised !== undefined) {
      session.handsRaised = Math.max(session.handsRaised, Number(req.body.handsRaised) || 0);
    }
    if (req.body?.speakerCount !== undefined) {
      session.speakerCount = Math.max(session.speakerCount, Number(req.body.speakerCount) || 0);
    }

    const roomService = getRoomServiceClient();
    try {
      await roomService.deleteRoom(session.roomName);
    } catch {}

    const durationSec = Math.max(1, Math.floor((Date.now() - session.createdAt) / 1000));
    return res.json({
      durationSec,
      speakerCount: session.speakerCount,
      handsRaised: session.handsRaised
    });
  });

  return app;
}
