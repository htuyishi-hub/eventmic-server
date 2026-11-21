import { WebSocketServer } from 'ws';
import { sessions, getSortedAttendeeQueue, isFairModeActive, VALID_REASONS } from './sessionStore.js';
import { verifyApiToken } from './auth.js';
import { checkRateLimit } from './rateLimiter.js';
import { getSessionMetrics } from './metrics.js';
import { createLiveKitToken } from './tokens.js';
import {
  registerSocket,
  unregisterSocket,
  sendToSocket,
  sendToIdentity,
  broadcastToRole,
  broadcastToAll,
  scheduleBatchedQueueBroadcast,
  getConnectedAttendeeCount,
  sessionSockets
} from './wsBroadcaster.js';
import {
  startAttendeeTurnTimer,
  startUrgentCapTimer,
  endTurn
} from './wsTurnManager.js';
import { isAllowedOrigin } from './cors.js';
import { avatarStore } from './avatarStore.js';

export function setupWebSocketServer(httpServer) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (request, socket, head) => {
    const origin = request.headers['origin'];
    if (!isAllowedOrigin(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    const parsedUrl = new URL(request.url, 'http://localhost');
    const pathname = parsedUrl.pathname;
    const query = Object.fromEntries(parsedUrl.searchParams.entries());
    if (pathname === '/ws' || pathname === '/') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request, query);
      });
    } else {
      socket.destroy();
    }
  });

  // Heartbeat ping interval every 25 seconds
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate();
        return;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {}
    });
  }, 25000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  wss.on('connection', (ws, req, query) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    let token = query?.token;

    const handleAuthenticated = (authData) => {
      const { role, code, identity, name } = authData;
      const session = sessions.get(code);

      if (!session || session.status === 'ended') {
        sendToSocket(ws, { type: 'error', code: 'INVALID_SESSION', message: 'Session not active' });
        ws.close();
        return;
      }

      registerSocket(code, identity, ws, role, name);
      avatarStore.cancelDisconnectCleanup(code, identity);

      // Send initial role-filtered state snapshot
      sendInitialState(ws, session, role, identity);

      // Notify admin and principals about presence update
      broadcastToRole(code, 'admin', {
        type: 'attendee_count',
        count: getConnectedAttendeeCount(code),
        metrics: getSessionMetrics(code).getSnapshot()
      });
      broadcastToRole(code, 'principal', {
        type: 'attendee_count',
        count: getConnectedAttendeeCount(code)
      });
    };

    if (token) {
      const authData = verifyApiToken(token);
      if (authData) {
        handleAuthenticated(authData);
      } else {
        sendToSocket(ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
        ws.close();
        return;
      }
    }

    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === 'auth') {
        const authData = verifyApiToken(msg.token);
        if (authData) {
          handleAuthenticated(authData);
        } else {
          sendToSocket(ws, { type: 'error', code: 'UNAUTHORIZED', message: 'Invalid or expired token' });
          ws.close();
        }
        return;
      }

      if (!ws.sessionCode || !ws.identity) return;

      const code = ws.sessionCode;
      const identity = ws.identity;
      const role = ws.role;
      const session = sessions.get(code);
      if (!session || session.status === 'ended') return;

      // Rate limit check: per session and identity
      if (!checkRateLimit(`${code}:${identity}`)) {
        sendToSocket(ws, { type: 'error', code: 'RATE_LIMITED', message: 'Too many requests' });
        return;
      }

      await handleClientMessage(msg, ws, session, code, identity, role);
    });

    ws.on('close', () => {
      const sessionCode = ws.sessionCode;
      const identity = ws.identity;
      unregisterSocket(ws);

      if (sessionCode && identity) {
        const codeMap = sessionSockets.get(sessionCode);
        const hasOtherSockets = codeMap && codeMap.has(identity) && codeMap.get(identity).size > 0;
        if (!hasOtherSockets) {
          avatarStore.scheduleDisconnectCleanup(sessionCode, identity, () => {
            broadcastToAll(sessionCode, {
              type: 'avatar_deleted',
              identity,
              hasAvatar: false,
              avatarVersion: 0
            });
          });
        }
      }

      if (sessionCode) {
        broadcastToRole(sessionCode, 'admin', {
          type: 'attendee_count',
          count: getConnectedAttendeeCount(sessionCode),
          metrics: getSessionMetrics(sessionCode).getSnapshot()
        });
      }
    });
  });

  return wss;
}

function sendInitialState(ws, session, role, identity) {
  const attendeeCount = getConnectedAttendeeCount(session.code);
  const fairActive = isFairModeActive(session);

  if (role === 'attendee') {
    const queue = getSortedAttendeeQueue(session);
    const pos = queue.findIndex(item => item.id === identity);
    sendToSocket(ws, {
      type: 'init',
      role,
      selfState: session.floor?.holderId === identity ? 'on_air' : (pos !== -1 ? 'hand_raised' : 'listening'),
      selfAvatar: avatarStore.getAvatarMeta(session.code, identity),
      floor: session.floor ? {
        name: session.floor.holderName,
        role: session.floor.holderRole,
        mode: session.floor.mode,
        ...avatarStore.getAvatarMeta(session.code, session.floor.holderId)
      } : null,
      position: pos !== -1 ? pos + 1 : 0,
      attendeeCount,
      settings: {
        photos: session.settings?.photos || 'speaker_only'
      }
    });
  } else {
    // Admin & Principal receive queues, lists, and settings
    const queue = getSortedAttendeeQueue(session).map(item => ({
      ...item,
      ...avatarStore.getAvatarMeta(session.code, item.id)
    }));
    sendToSocket(ws, {
      type: 'init',
      role,
      session: { code: session.code, name: session.name, status: session.status },
      queue,
      floor: session.floor ? {
        ...session.floor,
        ...avatarStore.getAvatarMeta(session.code, session.floor.holderId)
      } : null,
      principalQueue: session.principalQueue.map(p => ({
        ...p,
        ...avatarStore.getAvatarMeta(session.code, p.id)
      })),
      principals: Array.from(session.principals.values()).map(p => ({
        id: p.id,
        name: p.name,
        pin: role === 'admin' ? p.pin : undefined,
        inviteToken: role === 'admin' ? p.inviteToken : undefined,
        createdAt: p.createdAt,
        ...avatarStore.getAvatarMeta(session.code, p.id)
      })),
      settings: session.settings,
      fairModeActive: fairActive,
      attendeeCount,
      messages: session.messages || [],
      metrics: role === 'admin' ? getSessionMetrics(session.code).getSnapshot() : undefined
    });
  }
}

async function handleClientMessage(msg, ws, session, code, identity, role) {
  switch (msg.type) {
    case 'raise_hand': {
      if (role !== 'attendee') return;
      const reason = (msg.reason || 'question').toLowerCase().trim();
      const validReason = VALID_REASONS.includes(reason) ? reason : 'question';

      session.attendeeHands.set(identity, {
        id: identity,
        name: ws.displayName || 'Attendee',
        reason: validReason,
        raisedAt: Date.now(),
        urgent: false
      });
      session.handsRaised++;
      scheduleBatchedQueueBroadcast(session);
      break;
    }

    case 'lower_hand': {
      if (role !== 'attendee') return;
      session.attendeeHands.delete(identity);
      if (session.floor?.holderId === identity) {
        await endTurn(session, identity, 'released');
      } else {
        scheduleBatchedQueueBroadcast(session);
      }
      break;
    }

    case 'grant_floor': {
      if (role !== 'admin' && (role !== 'principal' || session.floor?.holderId !== identity)) {
        sendToSocket(ws, { type: 'error', code: 'FORBIDDEN', message: 'Not authorized to grant floor' });
        return;
      }
      const targetId = msg.attendeeId;
      const hand = session.attendeeHands.get(targetId);
      if (!hand) return;

      session.attendeeHands.delete(targetId);

      // 1. Preempt existing speaker if any
      if (session.floor && session.floor.holderId !== targetId) {
        await endTurn(session, session.floor.holderId, 'preempted');
      }

      // 2. Issue short-lived Connect-on-Speak LiveKit token for attendee (valid 2 min)
      const tokenData = await createLiveKitToken({
        role: 'attendee',
        code,
        identity: targetId,
        name: hand.name,
        ttlSeconds: 120
      });

      session.floor = {
        holderId: targetId,
        holderRole: 'attendee',
        holderName: hand.name,
        startedAt: Date.now(),
        mode: 'attendee',
        reason: hand.reason
      };
      session.speakerCount++;

      // 3. Send turn_granted to attendee
      sendToIdentity(code, targetId, {
        type: 'turn_granted',
        livekitUrl: tokenData.url,
        token: tokenData.token,
        turnCapSeconds: 120,
        mode: 'attendee'
      });

      // 4. Start turn timer (warning at 105s, cap at 120s)
      startAttendeeTurnTimer(session, targetId, 120);

      // 5. Broadcast floor update
      broadcastToAll(code, { type: 'floor_update', floor: session.floor });
      scheduleBatchedQueueBroadcast(session);
      break;
    }

    case 'take_floor': {
      if (role !== 'admin' && role !== 'principal') return;

      // Rule 3: Check if another principal holds floor
      if (session.floor && session.floor.holderRole === 'principal' && session.floor.holderId !== identity) {
        if (role !== 'admin') {
          const isAllowed = session.floorAllow && session.floorAllow.principalId === identity && Date.now() < session.floorAllow.expiresAt;
          if (!isAllowed) {
            sendToSocket(ws, { type: 'error', code: 'FORBIDDEN', message: 'Floor is held by another speaker. Request to speak instead.' });
            return;
          }
          session.floorAllow = null;
        }
      }

      // Rule 2: Preempt attendee with "The speaker is taking the floor"
      if (session.floor && session.floor.holderRole === 'attendee') {
        sendToIdentity(code, session.floor.holderId, {
          type: 'preempted',
          message: 'The speaker is taking the floor'
        });
        await endTurn(session, session.floor.holderId, 'The speaker is taking the floor');
      } else if (session.floor && session.floor.holderId !== identity) {
        await endTurn(session, session.floor.holderId, 'preempted');
      }

      const tokenData = await createLiveKitToken({
        role: 'principal',
        code,
        identity,
        name: ws.displayName || 'Speaker',
        ttlSeconds: 3600
      });

      session.principalQueue = session.principalQueue.filter(p => p.id !== identity);
      session.floor = {
        holderId: identity,
        holderRole: role === 'admin' ? 'admin' : 'principal',
        holderName: ws.displayName || 'Speaker',
        startedAt: Date.now(),
        mode: 'principal'
      };
      session.speakerCount++;

      sendToIdentity(code, identity, {
        type: 'turn_granted',
        livekitUrl: tokenData.url,
        token: tokenData.token,
        mode: 'principal'
      });

      broadcastToAll(code, { type: 'floor_update', floor: session.floor });
      broadcastToRole(code, 'admin', { type: 'principal_queue_update', principalQueue: session.principalQueue });
      broadcastToRole(code, 'principal', { type: 'principal_queue_update', principalQueue: session.principalQueue });
      break;
    }

    case 'request_speak': {
      if (role !== 'principal') return;
      if (!session.principalQueue.some(p => p.id === identity)) {
        session.principalQueue.push({ id: identity, name: ws.displayName || 'Speaker', requestedAt: Date.now() });
      }
      broadcastToRole(code, 'admin', { type: 'principal_queue_update', principalQueue: session.principalQueue });
      broadcastToRole(code, 'principal', { type: 'principal_queue_update', principalQueue: session.principalQueue });
      break;
    }

    case 'allow_principal': {
      if (role !== 'admin' && session.floor?.holderId !== identity) return;
      const targetId = msg.targetPrincipalId;
      session.floorAllow = { principalId: targetId, expiresAt: Date.now() + 60000 };
      session.principalQueue = session.principalQueue.filter(p => p.id !== targetId);

      sendToIdentity(code, targetId, { type: 'handover_allowed', expiresAt: session.floorAllow.expiresAt });
      broadcastToRole(code, 'admin', { type: 'principal_queue_update', principalQueue: session.principalQueue });
      broadcastToRole(code, 'principal', { type: 'principal_queue_update', principalQueue: session.principalQueue });
      break;
    }

    case 'urgent_request': {
      if (role !== 'attendee') return;
      // Urgent token: 7s TTL, 5s speaking cap with ducking
      const tokenData = await createLiveKitToken({
        role: 'attendee',
        code,
        identity,
        name: ws.displayName || 'Attendee',
        ttlSeconds: 7,
        isUrgent: true
      });

      session.floor = {
        holderId: identity,
        holderRole: 'attendee',
        holderName: ws.displayName || 'Attendee',
        startedAt: Date.now(),
        mode: 'urgent'
      };

      sendToIdentity(code, identity, {
        type: 'turn_granted',
        livekitUrl: tokenData.url,
        token: tokenData.token,
        turnCapSeconds: 5,
        isUrgent: true,
        mode: 'urgent'
      });

      startUrgentCapTimer(session, identity, 5);
      broadcastToAll(code, { type: 'floor_update', floor: session.floor });
      break;
    }

    case 'livekit_failed': {
      // Client reports failure to connect to LiveKit WebRTC
      if (session.floor?.holderId === identity) {
        session.floor = null;
        // Re-insert at front of queue
        session.attendeeHands.set(identity, {
          id: identity,
          name: ws.displayName || 'Attendee',
          reason: 'question',
          raisedAt: 0, // Oldest priority
          urgent: false
        });

        sendToIdentity(code, identity, {
          type: 'livekit_failed_handled',
          message: 'Connection failed, you are still in line'
        });

        broadcastToAll(code, { type: 'floor_update', floor: null });
        scheduleBatchedQueueBroadcast(session);
      }
      break;
    }

    case 'chat_message': {
      if (role !== 'admin' && role !== 'principal') {
        sendToSocket(ws, { type: 'error', code: 'FORBIDDEN', message: 'Backstage chat is for admin and speakers only' });
        break;
      }
      const text = typeof msg.text === 'string' ? msg.text.trim().slice(0, 500) : '';
      const audioDataUrl = typeof msg.audioDataUrl === 'string' && msg.audioDataUrl.startsWith('data:audio/') && msg.audioDataUrl.length <= 300000
        ? msg.audioDataUrl
        : null;
      if (!text && !audioDataUrl) break;

      if (!Array.isArray(session.messages)) session.messages = [];
      const entry = {
        id: 'msg-' + Math.random().toString(36).slice(2, 9),
        from: ws.displayName || (role === 'admin' ? 'Admin' : 'Speaker'),
        fromRole: role,
        fromId: identity,
        to: msg.to || 'all',
        text,
        ...(audioDataUrl ? { audioDataUrl, durationMs: Number(msg.durationMs) || 0 } : {}),
        ts: Date.now()
      };
      session.messages.push(entry);
      if (session.messages.length > 100) session.messages.shift();

      const payload = { type: 'messages', messages: session.messages };
      broadcastToRole(code, 'admin', payload);
      broadcastToRole(code, 'principal', payload);
      break;
    }

    case 'record_latency': {
      if (msg.grantToAudioMs && typeof msg.grantToAudioMs === 'number') {
        getSessionMetrics(code).recordGrantToAudio(role, msg.grantToAudioMs);
        broadcastToRole(code, 'admin', {
          type: 'metrics_update',
          metrics: getSessionMetrics(code).getSnapshot()
        });
      }
      break;
    }
  }
}
