import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { AccessToken, TrackSource, TrackType } from 'livekit-server-sdk';
import {
  sessions,
  initSession,
  addPrincipal,
  regeneratePrincipalPin,
  revokePrincipal,
  findPrincipalByPin,
  getSortedAttendeeQueue,
  recordSpeakHistoryEnd,
  isFairModeActive,
  VALID_REASONS
} from './sessionStore.js';
import {
  requireHostAuth,
  requireApiAuth,
  signApiToken,
  timingSafeCompare
} from './auth.js';
import { getRoomServiceClient } from './roomService.js';
import { getSessionMetrics } from './metrics.js';

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

  const authLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `${req.body?.code || 'global'}:${req.body?.identity || req.body?.pin || req.ip}`,
    message: { code: 'RATE_LIMITED', error: 'Too many auth requests, please try again later' }
  });

  // Health check
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
  });

  // 1. Create session (Admin)
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

    const session = initSession(name);
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

  // 3. Issue LiveKit & API tokens: POST /api/auth (and alias POST /api/token)
  const handleAuth = async (req, res) => {
    const { role: rawRole, code: rawCode, name: rawName, pin, passcode, identity: clientIdentity } = req.body || {};
    let role = rawRole;
    if (role === 'host') role = 'admin'; // Normalize legacy host -> admin

    if (!role || !['admin', 'principal', 'attendee'].includes(role)) {
      return res.status(400).json({ code: 'BAD_REQUEST', error: 'Role must be admin, principal, or attendee' });
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

    // A. Role: Admin
    if (role === 'admin') {
      const provided = req.headers['x-host-passcode'] || passcode;
      const expected = process.env.HOST_PASSCODE || '1234';

      if (!provided || !timingSafeCompare(provided, expected)) {
        return res.status(401).json({ code: 'UNAUTHORIZED', error: 'Invalid admin passcode' });
      }

      const identity = (rawRole === 'host' ? 'host-' : 'admin-') + Math.random().toString(36).substring(2, 10);
      const adminName = (typeof rawName === 'string' && rawName.trim()) ? rawName.trim() : 'Admin';

      const at = new AccessToken(apiKey, apiSecret, { identity, name: adminName, ttl: '6h' });
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
      const apiToken = signApiToken({ role: 'admin', code: session.code, identity, name: adminName });
      return res.json({ token, url: livekitUrl, apiToken, role: 'admin', identity, name: adminName });
    }

    // B. Role: Principal (Speaker)
    if (role === 'principal') {
      if (!pin) {
        return res.status(401).json({ code: 'UNAUTHORIZED', error: '6-digit PIN is required for principal' });
      }
      const principal = findPrincipalByPin(code, pin);
      if (!principal) {
        return res.status(401).json({ code: 'UNAUTHORIZED', error: 'Invalid principal PIN' });
      }

      const identity = principal.id;
      const pName = (typeof rawName === 'string' && rawName.trim()) ? rawName.trim() : principal.name;

      const at = new AccessToken(apiKey, apiSecret, { identity, name: pName, ttl: '6h' });
      at.addGrant({
        room: session.roomName,
        roomJoin: true,
        canSubscribe: true,
        canPublish: false,
        canPublishData: true,
        canUpdateOwnMetadata: true
      });

      const token = await at.toJwt();
      const apiToken = signApiToken({ role: 'principal', code: session.code, identity, name: pName });
      return res.json({ token, url: livekitUrl, apiToken, role: 'principal', identity, name: pName });
    }

    // C. Role: Attendee
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (name.length < 2 || name.length > 30) {
      return res.status(400).json({ code: 'BAD_REQUEST', error: 'Attendee name must be between 2 and 30 characters' });
    }

    let identity = '';
    if (typeof clientIdentity === 'string' && /^att-[a-z0-9]{6,16}$/.test(clientIdentity)) {
      identity = clientIdentity;
    } else {
      identity = 'att-' + Math.random().toString(36).substring(2, 12);
    }

    try {
      const roomService = getRoomServiceClient();
      const participants = await roomService.listParticipants(session.roomName);
      const attendeeCount = participants.filter(p => p.identity?.startsWith('att-')).length;
      if (attendeeCount >= 200) {
        return res.status(409).json({ code: 'FULL', error: 'Session is full (maximum 200 attendees reached)' });
      }
    } catch {}

    const at = new AccessToken(apiKey, apiSecret, { identity, name, ttl: '3h' });
    at.addGrant({
      room: session.roomName,
      roomJoin: true,
      canSubscribe: false,
      canPublish: false,
      canPublishData: false,
      canUpdateOwnMetadata: true
    });

    const token = await at.toJwt();
    const apiToken = signApiToken({ role: 'attendee', code: session.code, identity, name });
    return res.json({ token, url: livekitUrl, apiToken, role: 'attendee', identity, name });
  };

  app.post('/api/auth', authLimiter, handleAuth);
  app.post('/api/token', authLimiter, handleAuth);

  // 4. Principal Management (Admin only)
  app.get('/api/sessions/:code/principals', requireApiAuth(['admin']), (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    const session = sessions.get(code);
    if (!session) return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });

    const list = Array.from(session.principals.values());
    res.json(list);
  });

  app.post('/api/sessions/:code/principals', requireApiAuth(['admin']), (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    const session = sessions.get(code);
    if (!session) return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });

    const rawName = req.body?.name;
    if (!rawName || typeof rawName !== 'string' || rawName.trim().length < 2) {
      return res.status(400).json({ code: 'BAD_REQUEST', error: 'Principal name must be at least 2 characters' });
    }

    const principal = addPrincipal(code, rawName.trim());
    res.status(201).json(principal);
  });

  app.delete('/api/sessions/:code/principals/:id', requireApiAuth(['admin']), (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    const revoked = revokePrincipal(code, req.params.id);
    if (!revoked) return res.status(404).json({ code: 'NOT_FOUND', error: 'Principal not found' });
    res.json({ ok: true });
  });

  app.post('/api/sessions/:code/principals/:id/regenerate', requireApiAuth(['admin']), (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    const newPin = regeneratePrincipalPin(code, req.params.id);
    if (!newPin) return res.status(404).json({ code: 'NOT_FOUND', error: 'Principal not found' });
    res.json({ pin: newPin });
  });

  // 5. Session State & Settings
  app.get('/api/sessions/:code/state', requireApiAuth(['admin', 'principal', 'attendee']), async (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    const session = sessions.get(code);
    if (!session) return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });

    const callerRole = req.auth?.role;
    const sortedQueue = getSortedAttendeeQueue(session);
    const fairActive = isFairModeActive(session);

    let allAttendees = [];
    try {
      const roomService = getRoomServiceClient();
      const parts = await roomService.listParticipants(session.roomName);
      allAttendees = parts
        .filter(p => p.identity?.startsWith('att-'))
        .map(p => {
          const hist = session.speakHistory.get(p.identity);
          let state = 'listening';
          if (session.floor?.holderId === p.identity) state = 'speaking';
          else if (session.attendeeHands.has(p.identity)) state = 'hand_raised';
          return {
            id: p.identity,
            name: p.name || 'Attendee',
            state,
            timesSpoken: hist?.count || 0,
            lastSpokeAt: hist?.lastSpokeAt || null
          };
        });
    } catch {}

    const principalsList = Array.from(session.principals.values()).map(p => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      pin: callerRole === 'admin' ? p.pin : undefined
    }));

    const spokeHistory = Array.from(session.speakHistory.values()).flatMap(s =>
      s.history.map(h => ({
        id: s.id,
        name: s.name,
        startedAt: h.startedAt,
        durationSeconds: h.durationSeconds,
        reason: h.reason
      }))
    ).sort((a, b) => b.startedAt - a.startedAt);

    res.json({
      code: session.code,
      name: session.name,
      status: session.status,
      floor: session.floor,
      principalQueue: session.principalQueue,
      queue: sortedQueue,
      allAttendees,
      spokeHistory,
      principals: principalsList,
      settings: session.settings,
      fairModeActive: fairActive,
      floorAllow: session.floorAllow,
      metrics: getSessionMetrics(code).getSnapshot()
    });
  });

  app.post('/api/sessions/:code/settings', requireApiAuth(['admin']), (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    const session = sessions.get(code);
    if (!session) return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });

    const { fairMode, fairFromMinutesBeforeEnd, sessionEndsAt, principalConnectMode } = req.body || {};
    if (fairMode !== undefined && ['off', 'auto', 'on'].includes(fairMode)) {
      session.settings.fairMode = fairMode;
    }
    if (fairFromMinutesBeforeEnd !== undefined && typeof fairFromMinutesBeforeEnd === 'number') {
      session.settings.fairFromMinutesBeforeEnd = Math.max(1, fairFromMinutesBeforeEnd);
    }
    if (sessionEndsAt !== undefined) {
      session.settings.sessionEndsAt = sessionEndsAt ? Number(sessionEndsAt) : null;
    }
    if (principalConnectMode !== undefined && ['on_demand', 'always'].includes(principalConnectMode)) {
      session.settings.principalConnectMode = principalConnectMode;
    }

    res.json({ settings: session.settings, fairModeActive: isFairModeActive(session) });
  });

  app.post('/api/sessions/:code/latency', requireApiAuth(['admin', 'principal', 'attendee']), (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    const { grantToAudioMs, role } = req.body || {};
    if (typeof grantToAudioMs === 'number') {
      getSessionMetrics(code).recordGrantToAudio(role || req.auth?.role, grantToAudioMs);
    }
    res.json({ ok: true });
  });

  // 6. Floor Take (Principal or Admin)
  app.post('/api/floor/take', requireApiAuth(['admin', 'principal']), async (req, res) => {
    const { role, identity, name } = req.auth;
    const code = String(req.body?.code || req.auth.code || '').trim().toUpperCase();
    const session = sessions.get(code);

    if (!session) return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });
    if (session.status === 'ended') return res.status(410).json({ code: 'SESSION_ENDED', error: 'Session has ended' });

    const roomService = getRoomServiceClient();
    const currentFloor = session.floor;

    // Rule 3: Check if another principal holds the floor
    if (currentFloor && currentFloor.holderRole === 'principal' && currentFloor.holderId !== identity) {
      if (role !== 'admin') {
        const isAllowed = session.floorAllow &&
          session.floorAllow.principalId === identity &&
          Date.now() < session.floorAllow.expiresAt;

        if (!isAllowed) {
          return res.status(403).json({
            code: 'FORBIDDEN',
            error: 'Floor is held by another speaker. Request to speak instead.'
          });
        }
        // Consume allow
        session.floorAllow = null;
      }
    }

    try {
      // Step 1: Revoke existing speaker
      if (currentFloor && currentFloor.holderId !== identity) {
        recordSpeakHistoryEnd(session, currentFloor.holderId, currentFloor.holderName);
        try {
          const isAttendee = currentFloor.holderRole === 'attendee';
          await roomService.updateParticipant(session.roomName, currentFloor.holderId, {
            permission: { canPublish: false, canSubscribe: !isAttendee, canPublishData: !isAttendee, canUpdateOwnMetadata: true },
            attributes: { floor: '', floorRevokedReason: isAttendee ? 'The speaker is taking the floor' : '' }
          });
          const curPart = await roomService.getParticipant(session.roomName, currentFloor.holderId);
          const mic = curPart.tracks?.find(t => t.source === TrackSource.MICROPHONE || t.type === TrackType.AUDIO);
          if (mic && !mic.muted) {
            await roomService.mutePublishedTrack(session.roomName, currentFloor.holderId, mic.sid, true);
          }
        } catch {}
      }

      // Step 2: Grant new principal
      await roomService.updateParticipant(session.roomName, identity, {
        permission: {
          canPublish: true,
          canPublishSources: [TrackSource.MICROPHONE],
          canSubscribe: true,
          canPublishData: true,
          canUpdateOwnMetadata: true
        },
        attributes: { floor: 'granted', floorStartedAt: String(Date.now()), hand: '' }
      });

      // Remove from principalQueue if present
      session.principalQueue = session.principalQueue.filter(p => p.id !== identity);

      session.floor = {
        holderId: identity,
        holderRole: role,
        holderName: name || 'Speaker',
        startedAt: Date.now(),
        mode: 'principal'
      };
      session.speakerCount++;

      return res.json({ ok: true, floor: session.floor });
    } catch (err) {
      console.error('Error in floor/take:', err);
      return res.status(500).json({ code: 'UNKNOWN', error: 'Failed to take floor' });
    }
  });

  // 7. Request to speak (Principal queue)
  app.post('/api/floor/request-speak', requireApiAuth(['principal']), (req, res) => {
    const { identity, name, code: authCode } = req.auth;
    const code = String(req.body?.code || authCode || '').trim().toUpperCase();
    const session = sessions.get(code);

    if (!session) return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });

    if (!session.principalQueue.some(p => p.id === identity)) {
      session.principalQueue.push({ id: identity, name: name || 'Principal', requestedAt: Date.now() });
    }

    res.json({ ok: true, principalQueue: session.principalQueue });
  });

  // 8. Allow Principal (60s one-time permission)
  app.post('/api/floor/allow', requireApiAuth(['admin', 'principal']), (req, res) => {
    const { targetPrincipalId, principalId } = req.body || {};
    const target = targetPrincipalId || principalId;
    if (!target) return res.status(400).json({ code: 'BAD_REQUEST', error: 'targetPrincipalId is required' });

    const code = String(req.body?.code || req.auth.code || '').trim().toUpperCase();
    const session = sessions.get(code);
    if (!session) return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });

    // Must be admin or the current floor holder
    if (req.auth.role !== 'admin' && session.floor?.holderId !== req.auth.identity) {
      return res.status(403).json({ code: 'FORBIDDEN', error: 'Only current speaker or admin can allow floor handover' });
    }

    session.floorAllow = {
      principalId: target,
      expiresAt: Date.now() + 60 * 1000 // 60s
    };
    session.principalQueue = session.principalQueue.filter(p => p.id !== target);

    res.json({ ok: true, floorAllow: session.floorAllow });
  });

  // 9. Grant Floor to Attendee (Admin or Current Principal Holder)
  app.post('/api/floor/grant', requireApiAuth(['admin', 'principal']), async (req, res) => {
    const { code: rawCode, identity } = req.body || {};
    if (!identity || typeof identity !== 'string') {
      return res.status(400).json({ code: 'BAD_REQUEST', error: 'Target identity is required' });
    }

    const code = String(rawCode || req.auth.code || '').trim().toUpperCase();
    const session = sessions.get(code);

    if (!session) return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });
    if (session.status === 'ended') return res.status(410).json({ code: 'SESSION_ENDED', error: 'Session has ended' });

    // Rule 4: Only the current principal holder or admin may grant floor to an attendee
    if (req.auth.role === 'principal' && session.floor?.holderId !== req.auth.identity) {
      return res.status(403).json({
        code: 'FORBIDDEN',
        error: 'Only the current speaker holding the floor or admin may grant floor'
      });
    }

    const roomService = getRoomServiceClient();
    const currentFloor = session.floor;

    try {
      // Step 1: Revoke existing speaker
      const participants = await roomService.listParticipants(session.roomName).catch(() => []);
      for (const p of participants) {
        if (p.permission?.canPublish && p.identity !== identity) {
          const isAttendee = p.identity.startsWith('att-');
          await roomService.updateParticipant(session.roomName, p.identity, {
            permission: { canPublish: false, canSubscribe: !isAttendee, canPublishData: !isAttendee, canUpdateOwnMetadata: true },
            attributes: { floor: '' }
          });
          const mic = p.tracks?.find(t => t.source === TrackSource.MICROPHONE || t.type === TrackType.AUDIO);
          if (mic && !mic.muted) {
            try {
              await roomService.mutePublishedTrack(session.roomName, p.identity, mic.sid, true);
            } catch {}
          }
        }
      }

      if (currentFloor && currentFloor.holderId !== identity) {
        recordSpeakHistoryEnd(session, currentFloor.holderId, currentFloor.holderName);
      }

      // Step 2: Grant target attendee
      const handInfo = session.attendeeHands.get(identity);
      const attendeeReason = handInfo?.reason || 'question';
      session.attendeeHands.delete(identity);

      await roomService.updateParticipant(session.roomName, identity, {
        permission: {
          canPublish: true,
          canPublishSources: [TrackSource.MICROPHONE],
          canSubscribe: false,
          canPublishData: false,
          canUpdateOwnMetadata: true
        },
        attributes: { floor: 'granted', hand: '' }
      });

      let attendeeName = handInfo?.name || 'Attendee';
      try {
        const p = await roomService.getParticipant(session.roomName, identity);
        if (p?.name) attendeeName = p.name;
      } catch {}

      session.floor = {
        holderId: identity,
        holderRole: 'attendee',
        holderName: attendeeName,
        startedAt: Date.now(),
        mode: 'attendee',
        reason: attendeeReason
      };
      session.speakerCount++;

      return res.json({ ok: true, floor: session.floor });
    } catch (err) {
      console.error('Error granting floor:', err);
      return res.status(500).json({ code: 'UNKNOWN', error: 'Failed to grant floor' });
    }
  });

  // 10. Floor Revoke / Release
  app.post('/api/floor/revoke', requireApiAuth(['admin', 'principal', 'attendee']), async (req, res) => {
    const { code: rawCode, identity: rawId } = req.body || {};
    const code = String(rawCode || req.auth.code || '').trim().toUpperCase();
    const session = sessions.get(code);

    if (!session) return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });

    const identity = rawId || session.floor?.holderId || req.auth.identity;
    const roomService = getRoomServiceClient();

    try {
      if (session.floor && session.floor.holderId === identity) {
        recordSpeakHistoryEnd(session, identity, session.floor.holderName);
        session.floor = null;
      }

      const isAttendee = identity.startsWith('att-');
      await roomService.updateParticipant(session.roomName, identity, {
        permission: { canPublish: false, canSubscribe: !isAttendee, canPublishData: !isAttendee, canUpdateOwnMetadata: true },
        attributes: { floor: '' }
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

  // 11. Attendee Raise Hand with Reason (Rule 5)
  app.post('/api/floor/raise-hand', requireApiAuth(['attendee']), async (req, res) => {
    const { identity, name, code: authCode } = req.auth;
    const code = String(req.body?.code || authCode || '').trim().toUpperCase();
    const session = sessions.get(code);

    if (!session) return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });
    if (session.status === 'ended') return res.status(410).json({ code: 'SESSION_ENDED', error: 'Session has ended' });

    const reason = (req.body?.reason || 'question').toLowerCase().trim();
    if (!VALID_REASONS.includes(reason)) {
      return res.status(400).json({
        code: 'BAD_REQUEST',
        error: `Invalid reason: ${reason}. Must be one of: ${VALID_REASONS.join(', ')}`
      });
    }

    const handData = {
      id: identity,
      name: name || req.body?.name || 'Attendee',
      reason,
      raisedAt: Date.now(),
      urgent: false
    };

    session.attendeeHands.set(identity, handData);
    session.handsRaised++;

    try {
      const roomService = getRoomServiceClient();
      await roomService.updateParticipant(session.roomName, identity, {
        attributes: {
          hand: String(handData.raisedAt),
          handReason: reason
        }
      });
    } catch {}

    const sortedQueue = getSortedAttendeeQueue(session);
    const position = sortedQueue.findIndex(h => h.id === identity) + 1;

    res.json({ ok: true, hand: handData, position });
  });

  // 12. Attendee Lower Hand
  app.post('/api/floor/lower-hand', requireApiAuth(['attendee']), async (req, res) => {
    const { identity, code: authCode } = req.auth;
    const code = String(req.body?.code || authCode || '').trim().toUpperCase();
    const session = sessions.get(code);

    if (!session) return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });

    session.attendeeHands.delete(identity);

    try {
      const roomService = getRoomServiceClient();
      await roomService.updateParticipant(session.roomName, identity, {
        attributes: { hand: '', handReason: '' }
      });
    } catch {}

    res.json({ ok: true });
  });

  // 13. Floor mute
  app.post('/api/floor/mute', requireApiAuth(['admin', 'principal']), async (req, res) => {
    const { code: rawCode, identity, muted } = req.body || {};
    if (!identity || typeof identity !== 'string') {
      return res.status(400).json({ code: 'BAD_REQUEST', error: 'Target identity is required' });
    }

    const code = String(rawCode || req.auth.code || '').trim().toUpperCase();
    const session = sessions.get(code);
    if (!session) return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });

    const roomService = getRoomServiceClient();
    try {
      const participant = await roomService.getParticipant(session.roomName, identity);
      const mic = participant.tracks?.find(t => t.source === TrackSource.MICROPHONE || t.type === TrackType.AUDIO);
      if (mic) {
        await roomService.mutePublishedTrack(session.roomName, identity, mic.sid, Boolean(muted));
      }
      return res.json({ ok: true });
    } catch (err) {
      console.warn('Failed to mute track:', err);
      return res.json({ ok: true });
    }
  });

  // 14. End session (Admin only)
  app.post('/api/sessions/:code/end', requireApiAuth(['admin']), async (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    const session = sessions.get(code);

    if (!session) return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });

    session.status = 'ended';
    if (req.body?.handsRaised !== undefined) {
      session.handsRaised = Math.max(session.handsRaised, Number(req.body.handsRaised) || 0);
    }
    if (req.body?.speakerCount !== undefined) {
      session.speakerCount = Math.max(session.speakerCount, Number(req.body.speakerCount) || 0);
    }

    if (session.floor) {
      recordSpeakHistoryEnd(session, session.floor.holderId, session.floor.holderName);
      session.floor = null;
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
