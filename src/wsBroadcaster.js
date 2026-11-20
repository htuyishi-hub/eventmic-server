import { getSortedAttendeeQueue, isFairModeActive } from './sessionStore.js';
import { getSessionMetrics } from './metrics.js';
import { avatarStore } from './avatarStore.js';

// Map<sessionCode, Map<identity, Set<WebSocket>>>
export const sessionSockets = new Map();

// Map<sessionCode, NodeJS.Timeout> for 500ms batched queue broadcasts (max 2/sec)
const queueBroadcastTimers = new Map();

export function registerSocket(code, identity, ws, role, name) {
  if (!sessionSockets.has(code)) {
    sessionSockets.set(code, new Map());
  }
  const codeMap = sessionSockets.get(code);
  if (!codeMap.has(identity)) {
    codeMap.set(identity, new Set());
  }
  codeMap.get(identity).add(ws);
  ws.sessionCode = code;
  ws.identity = identity;
  ws.role = role;
  ws.displayName = name;

  updateSocketMetrics(code);
}

export function unregisterSocket(ws) {
  const { sessionCode, identity } = ws;
  if (!sessionCode || !identity) return;

  const codeMap = sessionSockets.get(sessionCode);
  if (codeMap && codeMap.has(identity)) {
    const set = codeMap.get(identity);
    set.delete(ws);
    if (set.size === 0) {
      codeMap.delete(identity);
    }
    if (codeMap.size === 0) {
      sessionSockets.delete(sessionCode);
    }
  }

  updateSocketMetrics(sessionCode);
}

export function updateSocketMetrics(code) {
  const codeMap = sessionSockets.get(code);
  let totalOpen = 0;
  if (codeMap) {
    for (const set of codeMap.values()) {
      totalOpen += set.size;
    }
  }
  const metrics = getSessionMetrics(code);
  metrics.updateSocketCount(totalOpen);
}

export function getConnectedAttendeeCount(code) {
  const codeMap = sessionSockets.get(code);
  if (!codeMap) return 0;
  let count = 0;
  for (const set of codeMap.values()) {
    for (const ws of set) {
      if (ws.role === 'attendee') {
        count++;
        break; // Count unique attendee identities
      }
    }
  }
  return count;
}

export function sendToSocket(ws, data) {
  if (ws && ws.readyState === 1) { // OPEN
    try {
      ws.send(JSON.stringify(data));
    } catch {}
  }
}

export function sendToIdentity(code, identity, data) {
  const codeMap = sessionSockets.get(code);
  if (!codeMap || !codeMap.has(identity)) return;
  for (const ws of codeMap.get(identity)) {
    sendToSocket(ws, data);
  }
}

export function broadcastToRole(code, role, data) {
  const codeMap = sessionSockets.get(code);
  if (!codeMap) return;
  for (const set of codeMap.values()) {
    for (const ws of set) {
      if (ws.role === role) {
        sendToSocket(ws, data);
      }
    }
  }
}

export function broadcastToAll(code, data) {
  const codeMap = sessionSockets.get(code);
  if (!codeMap) return;
  for (const set of codeMap.values()) {
    for (const ws of set) {
      sendToSocket(ws, data);
    }
  }
}

/**
 * Batches queue updates to max 2 broadcasts per second per session (500ms).
 * Strictly enforces per-role filtering:
 * - Admin and Principal receive the full sorted queue.
 * - Attendees receive ONLY their own queue position.
 */
export function scheduleBatchedQueueBroadcast(session) {
  const code = session.code;
  if (queueBroadcastTimers.has(code)) return;

  const timer = setTimeout(() => {
    queueBroadcastTimers.delete(code);
    executeQueueBroadcast(session);
  }, 500);

  queueBroadcastTimers.set(code, timer);
}

function executeQueueBroadcast(session) {
  const sortedQueue = getSortedAttendeeQueue(session);
  const fairActive = isFairModeActive(session);
  const attendeeCount = getConnectedAttendeeCount(session.code);

  // 1. Send full queue to Admins and Principals
  const queueWithAvatar = sortedQueue.map(item => ({
    ...item,
    ...avatarStore.getAvatarMeta(session.code, item.id)
  }));

  const adminQueueMsg = {
    type: 'queue_update',
    queue: queueWithAvatar,
    attendeeCount,
    fairModeActive: fairActive
  };

  const codeMap = sessionSockets.get(session.code);
  if (!codeMap) return;

  for (const set of codeMap.values()) {
    for (const ws of set) {
      if (ws.role === 'admin' || ws.role === 'principal' || ws.role === 'host') {
        sendToSocket(ws, adminQueueMsg);
      } else if (ws.role === 'attendee') {
        // 2. Send each attendee ONLY their own position
        const pos = sortedQueue.findIndex(item => item.id === ws.identity);
        const position = pos !== -1 ? pos + 1 : 0;
        sendToSocket(ws, {
          type: 'queue_position',
          position,
          inQueue: pos !== -1,
          attendeeCount
        });
      }
    }
  }
}
