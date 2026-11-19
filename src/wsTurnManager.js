import { recordSpeakHistoryEnd } from './sessionStore.js';
import { getRoomServiceClient } from './roomService.js';
import { sendToIdentity, broadcastToAll, scheduleBatchedQueueBroadcast } from './wsBroadcaster.js';
import { getSessionMetrics } from './metrics.js';

// Map<sessionCode, { warningTimer, capTimer, urgentTimer, identity, startedAt, capSeconds }>
const activeSessionTimers = new Map();

export function clearSessionTimers(code) {
  const record = activeSessionTimers.get(code);
  if (record) {
    if (record.warningTimer) clearTimeout(record.warningTimer);
    if (record.capTimer) clearTimeout(record.capTimer);
    if (record.urgentTimer) clearTimeout(record.urgentTimer);
    activeSessionTimers.delete(code);
  }
}

export function startAttendeeTurnTimer(session, identity, capSeconds = 120) {
  clearSessionTimers(session.code);

  const startedAt = Date.now();
  const warningMs = Math.max(0, (capSeconds - 15) * 1000);

  const warningTimer = setTimeout(() => {
    sendToIdentity(session.code, identity, {
      type: 'turn_warning',
      secondsLeft: 15
    });
  }, warningMs);

  const capTimer = setTimeout(async () => {
    await endTurn(session, identity, 'time_limit');
  }, capSeconds * 1000);

  activeSessionTimers.set(session.code, {
    warningTimer,
    capTimer,
    identity,
    startedAt,
    capSeconds
  });
}

export function startUrgentCapTimer(session, identity, capSeconds = 5) {
  clearSessionTimers(session.code);

  // Broadcast ducking command: duck current holder to ~30%
  broadcastToAll(session.code, {
    type: 'duck_stage',
    duck: true,
    factor: 0.3
  });

  const urgentTimer = setTimeout(async () => {
    // Restore stage audio
    broadcastToAll(session.code, {
      type: 'duck_stage',
      duck: false,
      factor: 1.0
    });
    await endTurn(session, identity, 'urgent_complete');
  }, capSeconds * 1000);

  activeSessionTimers.set(session.code, {
    urgentTimer,
    identity,
    startedAt: Date.now(),
    capSeconds
  });
}

export async function endTurn(session, identity, reason = 'released') {
  clearSessionTimers(session.code);

  if (session.floor && session.floor.holderId === identity) {
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - session.floor.startedAt) / 1000));
    recordSpeakHistoryEnd(session, identity, session.floor.holderName, session.floor.reason);
    getSessionMetrics(session.code).recordWebRtcSeconds(elapsedSeconds);
    session.floor = null;
  }

  // Authoritatively remove participant from LiveKit Room
  try {
    const roomService = getRoomServiceClient();
    await roomService.removeParticipant(session.roomName, identity);
  } catch {}

  // Notify the target attendee
  sendToIdentity(session.code, identity, {
    type: 'turn_ended',
    reason
  });

  // Broadcast floor release to all clients
  broadcastToAll(session.code, {
    type: 'floor_update',
    floor: null
  });

  scheduleBatchedQueueBroadcast(session);
}
