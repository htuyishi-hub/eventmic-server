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
  findPrincipalByInviteToken,
  getSortedAttendeeQueue,
  recordSpeakHistoryEnd,
  isFairModeActive,
  VALID_REASONS
} from './sessionStore.js';
import {
  requireHostAuth,
  resolveAdminFromRequest,
  requireApiAuth,
  signApiToken,
  timingSafeCompare
} from './auth.js';
import {
  checkPinLockout,
  recordFailedPinAttempt,
  resetFailedPinAttempts
} from './rateLimiter.js';
import { createRequire } from 'module';
import { validateProductionEnv } from './env.js';
import { createCorsOptions } from './cors.js';
import { getRoomServiceClient } from './roomService.js';
import { getSessionMetrics } from './metrics.js';
import { avatarStore } from './avatarStore.js';
import { registerAdmin, authenticateAdmin } from './adminStore.js';
import { listSchedules, createSchedule, getSchedule, deleteSchedule, advanceOrRemoveSchedule, VALID_RECURRENCE } from './scheduleStore.js';
import { detectMagicBytes, reencodeAvatar, MAX_AVATAR_BYTES } from './avatarValidation.js';
import { broadcastToAll } from './wsBroadcaster.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

export function createApp() {
  validateProductionEnv();

  const app = express();

  app.use(cors(createCorsOptions()));
  app.use(express.json({ limit: '2mb' }));
  app.use(express.raw({ type: ['image/*', 'application/octet-stream'], limit: '2mb' }));

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
    let gitHash = '';
    try {
      const { execSync } = require('child_process');
      gitHash = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch {}

    const version = process.env.COMMIT_HASH || process.env.RENDER_GIT_COMMIT?.slice(0, 7) || gitHash || pkg.version;
    const isLiveKitConfigured = Boolean(
      process.env.LIVEKIT_URL &&
      process.env.LIVEKIT_API_KEY &&
      process.env.LIVEKIT_API_SECRET &&
      process.env.LIVEKIT_API_KEY !== 'devkey'
    );

    res.json({
      ok: true,
      version,
      uptimeSec: Math.floor(process.uptime()),
      livekitConfigured: isLiveKitConfigured,
      socketEnabled: true,
      sessions: sessions.size
    });
  });

  // -1. Multi-Admin Accounts (Sign Up / Sign In using API_TOKEN_SECRET JWTs)
  app.post('/api/admins/register', (req, res) => {
    try {
      const admin = registerAdmin(req.body || {});
      const adminToken = signApiToken({
        role: 'organizer',
        code: '*',
        identity: admin.id,
        name: admin.name,
        email: admin.email,
        exp: Math.floor(Date.now() / 1000) + 7 * 86400
      });
      res.status(201).json({ admin, adminToken });
    } catch (err) {
      res.status(err.status || 400).json({ code: err.code || 'BAD_REQUEST', error: err.message });
    }
  });

  app.post('/api/admins/login', (req, res) => {
    const admin = authenticateAdmin(req.body || {});
    if (!admin) {
      return res.status(401).json({ code: 'UNAUTHORIZED', error: 'Invalid email or password' });
    }
    const adminToken = signApiToken({
      role: 'organizer',
      code: '*',
      identity: admin.id,
      name: admin.name,
      email: admin.email,
      exp: Math.floor(Date.now() / 1000) + 7 * 86400
    });
    res.json({ admin, adminToken });
  });

  app.get('/api/admins/me', requireHostAuth, (req, res) => {
    res.json({ admin: req.admin });
  });

  // 0. Scheduled / Recurring Sessions Calendar (Admin)
  app.get('/api/schedules', requireHostAuth, (req, res) => {
    res.json(listSchedules(req.admin.id));
  });

  app.post('/api/schedules', requireHostAuth, (req, res) => {
    const { title, startAt, durationMinutes, recurrence, settings } = req.body || {};
    if (!title || typeof title !== 'string' || title.trim().length < 3 || title.trim().length > 60) {
      return res.status(400).json({ code: 'BAD_REQUEST', error: 'Title must be between 3 and 60 characters' });
    }
    const ts = Date.parse(startAt);
    if (!startAt || Number.isNaN(ts)) {
      return res.status(400).json({ code: 'BAD_REQUEST', error: 'Valid startAt date/time is required' });
    }
    if (recurrence && !VALID_RECURRENCE.includes(recurrence)) {
      return res.status(400).json({ code: 'BAD_REQUEST', error: 'Invalid recurrence' });
    }
    const item = createSchedule({ ownerId: req.admin.id, title, startAt, durationMinutes, recurrence, settings });
    res.status(201).json(item);
  });

  app.delete('/api/schedules/:id', requireHostAuth, (req, res) => {
    const ok = deleteSchedule(req.params.id, req.admin.id);
    if (!ok) return res.status(404).json({ code: 'NOT_FOUND', error: 'Schedule not found' });
    res.json({ ok: true });
  });

  app.post('/api/schedules/:id/start', requireHostAuth, (req, res) => {
    const sch = getSchedule(req.params.id, req.admin.id);
    if (!sch) return res.status(404).json({ code: 'NOT_FOUND', error: 'Schedule not found' });
    const session = initSession(sch.title, { code: sch.code, ownerId: req.admin.id, settings: sch.settings });
    const next = advanceOrRemoveSchedule(sch.id);
    res.status(201).json({
      code: session.code,
      name: session.name,
      createdAt: session.createdAt,
      settings: session.settings,
      nextOccurrence: next
    });
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

    const session = initSession(name, { ownerId: req.admin.id });
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
    const { role: rawRole, code: rawCode, name: rawName, pin, inviteToken, passcode, identity: clientIdentity } = req.body || {};
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
      const admin = resolveAdminFromRequest(req);
      if (!admin) {
        return res.status(401).json({ code: 'UNAUTHORIZED', error: 'Invalid admin credentials or passcode' });
      }
      if (admin.isOrganizer && session.ownerId && session.ownerId !== 'default-host' && session.ownerId !== admin.id) {
        return res.status(403).json({ code: 'FORBIDDEN', error: 'This session belongs to another admin' });
      }

      const identity = (rawRole === 'host' ? 'host-' : 'admin-') + Math.random().toString(36).substring(2, 10);
      const adminName = (typeof rawName === 'string' && rawName.trim()) ? rawName.trim() : (admin.name || 'Admin');

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

    // B. Role: Principal (Speaker) — accepts either unique inviteToken (link) OR 6-digit PIN (app button)
    if (role === 'principal') {
      let principal = null;
      if (inviteToken) {
        principal = findPrincipalByInviteToken(code, inviteToken);
        if (!principal) {
          return res.status(401).json({
            code: 'INVALID_INVITE',
            error: 'Invalid or revoked speaker invite link.'
          });
        }
      } else {
        const pinRateKey = `${code}:${req.ip || 'global'}`;
        const lockout = checkPinLockout(pinRateKey);
        if (lockout.locked) {
          const remainingSec = Math.ceil(lockout.remainingMs / 1000);
          return res.status(429).json({
            code: 'PIN_LOCKED',
            error: `Too many incorrect PIN attempts. Locked for ${remainingSec} seconds.`
          });
        }

        if (!pin) {
          return res.status(401).json({ code: 'UNAUTHORIZED', error: '6-digit PIN is required for principal' });
        }
        principal = findPrincipalByPin(code, pin);
        if (!principal) {
          const resFailed = recordFailedPinAttempt(pinRateKey, 5, 60000);
          if (resFailed.locked) {
            return res.status(429).json({
              code: 'PIN_LOCKED',
              error: 'Too many incorrect PIN attempts. Locked for 60 seconds.'
            });
          }
          return res.status(401).json({
            code: 'UNAUTHORIZED',
            error: `Invalid principal PIN. ${5 - resFailed.attempts} attempt(s) remaining.`
          });
        }

        resetFailedPinAttempts(pinRateKey);
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
    avatarStore.deleteAvatar(code, req.params.id);
    broadcastToAll(code, { type: 'avatar_deleted', identity: req.params.id, hasAvatar: false, avatarVersion: 0 });
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
            lastSpokeAt: hist?.lastSpokeAt || null,
            ...avatarStore.getAvatarMeta(code, p.identity)
          };
        });
    } catch {}

    const principalsList = Array.from(session.principals.values()).map(p => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      pin: callerRole === 'admin' ? p.pin : undefined,
      ...avatarStore.getAvatarMeta(code, p.id)
    }));

    const spokeHistory = Array.from(session.speakHistory.values()).flatMap(s =>
      s.history.map(h => ({
        id: s.id,
        name: s.name,
        startedAt: h.startedAt,
        durationSeconds: h.durationSeconds,
        reason: h.reason,
        ...avatarStore.getAvatarMeta(code, s.id)
      }))
    ).sort((a, b) => b.startedAt - a.startedAt);

    const floorWithAvatar = session.floor ? {
      ...session.floor,
      ...avatarStore.getAvatarMeta(code, session.floor.holderId)
    } : null;

    const queueWithAvatar = sortedQueue.map(item => ({
      ...item,
      ...avatarStore.getAvatarMeta(code, item.id)
    }));

    const principalQueueWithAvatar = session.principalQueue.map(p => ({
      ...p,
      ...avatarStore.getAvatarMeta(code, p.id)
    }));

    res.json({
      code: session.code,
      name: session.name,
      status: session.status,
      floor: floorWithAvatar,
      principalQueue: principalQueueWithAvatar,
      queue: queueWithAvatar,
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

    const { fairMode, fairFromMinutesBeforeEnd, sessionEndsAt, principalConnectMode, photos } = req.body || {};
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
    if (photos !== undefined && ['on', 'speaker_only', 'off'].includes(photos)) {
      session.settings.photos = photos;
    }

    broadcastToAll(code, {
      type: 'settings_update',
      settings: session.settings
    });

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

    avatarStore.deleteSession(code);

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

  // 15. Remove / Block Attendee (Admin only)
  app.post('/api/sessions/:code/attendees/:id/remove', requireApiAuth(['admin']), async (req, res) => {
    const code = String(req.params.code || '').trim().toUpperCase();
    const session = sessions.get(code);
    if (!session) return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });
    const identity = req.params.id;

    avatarStore.deleteAvatar(code, identity);
    session.attendeeHands.delete(identity);
    if (session.floor?.holderId === identity) {
      session.floor = null;
    }

    try {
      const roomService = getRoomServiceClient();
      await roomService.removeParticipant(session.roomName, identity);
    } catch {}

    broadcastToAll(code, { type: 'avatar_deleted', identity, hasAvatar: false, avatarVersion: 0 });
    res.json({ ok: true });
  });

  // --- Temporary Profile Photos (Avatars) ---

  // 16. Upload Avatar: POST /api/avatar
  app.post('/api/avatar', requireApiAuth(['admin', 'principal', 'attendee']), async (req, res) => {
    const sessionCode = String(req.auth.code || req.body?.code || req.query.code || '').trim().toUpperCase();
    const session = sessions.get(sessionCode);

    if (!session) {
      return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });
    }
    if (session.status === 'ended') {
      return res.status(410).json({ code: 'SESSION_ENDED', error: 'Session has ended' });
    }

    // Setting check: When photos === 'off', uploads are rejected with a clear code
    if (session.settings?.photos === 'off') {
      return res.status(403).json({
        code: 'PHOTOS_DISABLED',
        error: 'Profile photos are disabled for this session'
      });
    }

    // Identity target: admin can set photo for any principal/participant; others set their own
    let targetIdentity = req.auth.identity;
    if (req.auth.role === 'admin' && (req.body?.targetIdentity || req.query.identity)) {
      targetIdentity = req.body?.targetIdentity || req.query.identity;
    }

    // Rate limit: 5 uploads per minute per identity
    if (!avatarStore.checkUploadRateLimit(sessionCode, targetIdentity)) {
      return res.status(429).json({
        code: 'RATE_LIMITED',
        error: 'Upload limit exceeded. Maximum 5 uploads per minute.'
      });
    }

    // Extract image buffer from binary or JSON body
    let rawBuffer = null;
    if (Buffer.isBuffer(req.body)) {
      rawBuffer = req.body;
    } else if (req.body && typeof req.body === 'object') {
      const b64 = req.body.image || req.body.data;
      if (typeof b64 === 'string') {
        const clean = b64.includes('base64,') ? b64.split('base64,')[1] : b64;
        try {
          rawBuffer = Buffer.from(clean, 'base64');
        } catch {
          return res.status(400).json({ code: 'BAD_REQUEST', error: 'Invalid base64 image data' });
        }
      }
    }

    if (!rawBuffer || rawBuffer.length === 0) {
      return res.status(400).json({ code: 'BAD_REQUEST', error: 'Image body is required' });
    }

    // Limit: 150 KB max
    if (rawBuffer.length > MAX_AVATAR_BYTES) {
      return res.status(413).json({
        code: 'AVATAR_TOO_LARGE',
        error: `Avatar image exceeds maximum limit of 150 KB (${rawBuffer.length} bytes received)`
      });
    }

    // Magic bytes check (jpeg, webp, png)
    const detectedMime = detectMagicBytes(rawBuffer);
    if (!detectedMime) {
      return res.status(400).json({
        code: 'INVALID_IMAGE_TYPE',
        error: 'Invalid image format. Only JPEG, PNG, or WebP images are allowed.'
      });
    }

    // Re-encode with sharp to 256x256 WebP, quality ~80, metadata stripped
    let processedBuffer;
    try {
      processedBuffer = await reencodeAvatar(rawBuffer);
    } catch (err) {
      console.error('Failed to process avatar with sharp:', err.message);
      return res.status(500).json({ code: 'PROCESSING_ERROR', error: 'Failed to process image' });
    }

    // Store in-memory with session total 50 MB cap check
    try {
      const { version, updatedAt, size } = avatarStore.setAvatar(
        sessionCode,
        targetIdentity,
        processedBuffer,
        'image/webp'
      );

      // Broadcast update event to all connected sockets in session
      broadcastToAll(sessionCode, {
        type: 'avatar_updated',
        identity: targetIdentity,
        hasAvatar: true,
        avatarVersion: version
      });

      return res.json({
        ok: true,
        identity: targetIdentity,
        version,
        size,
        updatedAt
      });
    } catch (err) {
      if (err.code === 'SESSION_AVATAR_CAP_EXCEEDED') {
        return res.status(413).json({
          code: 'SESSION_AVATAR_CAP_EXCEEDED',
          error: 'Session avatar storage limit (50 MB) exceeded'
        });
      }
      throw err;
    }
  });

  // 17. Fetch Avatar: GET /api/avatar/:code/:identity
  app.get('/api/avatar/:code/:identity', requireApiAuth(['admin', 'principal', 'attendee']), (req, res) => {
    const sessionCode = String(req.params.code || '').trim().toUpperCase();
    const identity = req.params.identity;
    const session = sessions.get(sessionCode);

    if (!session) {
      return res.status(404).json({ code: 'INVALID_CODE', error: 'Session not found' });
    }

    const { role: callerRole, identity: callerIdentity, code: tokenCode } = req.auth;
    if (callerRole !== 'admin' && tokenCode && tokenCode !== sessionCode) {
      return res.status(403).json({ code: 'FORBIDDEN', error: 'Token does not match session' });
    }

    // When photos === 'off', deny attendee requests
    if (session.settings?.photos === 'off') {
      return res.status(403).json({ code: 'PHOTOS_DISABLED', error: 'Profile photos are disabled for this session' });
    }

    // Role-based visibility check:
    // - admin and principals may fetch any avatar
    // - an attendee may fetch ONLY the current floor holder's avatar (and their own); otherwise 403.
    if (callerRole === 'attendee') {
      const isSelf = callerIdentity === identity;
      const isFloorHolder = session.floor && session.floor.holderId === identity;

      if (!isSelf && !isFloorHolder) {
        return res.status(403).json({
          code: 'FORBIDDEN',
          error: 'Attendees may only view the current floor speaker photo or their own'
        });
      }
    }

    const avatar = avatarStore.getAvatar(sessionCode, identity);
    if (!avatar) {
      return res.status(404).json({ code: 'AVATAR_NOT_FOUND', error: 'Avatar not found' });
    }

    const etag = `W/"${avatar.version}"`;
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.setHeader('ETag', etag);
    res.setHeader('Content-Type', avatar.mime || 'image/webp');

    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }

    return res.send(avatar.bytes);
  });

  // 18. Delete Own Avatar: DELETE /api/avatar
  app.delete('/api/avatar', requireApiAuth(['admin', 'principal', 'attendee']), (req, res) => {
    const sessionCode = String(req.auth.code || req.query.code || '').trim().toUpperCase();
    const identity = req.auth.identity;

    avatarStore.deleteAvatar(sessionCode, identity);

    broadcastToAll(sessionCode, {
      type: 'avatar_deleted',
      identity,
      hasAvatar: false,
      avatarVersion: 0
    });

    return res.json({ ok: true });
  });

  // 19. Admin Delete Any Avatar: DELETE /api/avatar/:identity
  app.delete('/api/avatar/:identity', requireApiAuth(['admin']), (req, res) => {
    const sessionCode = String(req.auth.code || req.query.code || '').trim().toUpperCase();
    const identity = req.params.identity;

    avatarStore.deleteAvatar(sessionCode, identity);

    broadcastToAll(sessionCode, {
      type: 'avatar_deleted',
      identity,
      hasAvatar: false,
      avatarVersion: 0
    });

    return res.json({ ok: true });
  });

  return app;
}
