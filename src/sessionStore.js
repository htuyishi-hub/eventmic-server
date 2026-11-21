import crypto from 'crypto';
import { UNAMBIGUOUS_CHARS } from './codes.js';
import { avatarStore } from './avatarStore.js';

export const VALID_REASONS = ['question', 'comment', 'compliment', 'clarification'];

/**
 * In-memory session store
 * Map<string, Session>
 */
export const sessions = new Map();

/**
 * Generates a unique 6-character uppercase code (excluding 0, O, 1, I).
 * @returns {string}
 */
export function generateUniqueCode() {
  const len = UNAMBIGUOUS_CHARS.length;
  for (let attempt = 0; attempt < 1000; attempt++) {
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += UNAMBIGUOUS_CHARS.charAt(Math.floor(Math.random() * len));
    }
    if (!sessions.has(code)) {
      return code;
    }
  }
  throw new Error('Failed to generate unique session code');
}

/**
 * Generates a random 6-digit numeric PIN for a principal.
 * @returns {string}
 */
export function generate6DigitPin() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/**
 * Creates and stores a new Session.
 * @param {string} name
 * @returns {Object}
 */
export function initSession(name, opts = {}) {
  const requested = opts.code && !sessions.has(opts.code) ? opts.code : null;
  const code = requested || generateUniqueCode();
  const session = {
    code,
    ownerId: opts.ownerId || 'default-host',
    name,
    roomName: `em-${code}`,
    createdAt: Date.now(),
    status: 'live',
    speakerCount: 0,
    handsRaised: 0,
    floor: null, // { holderId, holderRole, holderName, startedAt, mode: 'principal' | 'attendee' | 'urgent' }
    principalQueue: [], // [{ id, name, requestedAt }]
    attendeeHands: new Map(), // id -> { id, name, reason, raisedAt, urgent }
    speakHistory: new Map(), // id -> { id, name, count, lastSpokeAt, totalSeconds, history: [] }
    principals: new Map(), // id -> { id, name, pin, createdAt }
    messages: [], // backstage chat between admin & principals
    settings: {
      fairMode: 'off', // 'off' | 'auto' | 'on'
      fairFromMinutesBeforeEnd: 15,
      sessionEndsAt: null,
      principalConnectMode: 'on_demand', // 'on_demand' | 'always'
      photos: opts.settings?.photos || 'speaker_only',
      ...(opts.settings?.fairMode ? { fairMode: opts.settings.fairMode } : {}),
      ...(opts.settings?.turnCapSeconds ? { turnCapSeconds: opts.settings.turnCapSeconds } : {})
    },
    floorAllow: null // { principalId, expiresAt }
  };
  sessions.set(code, session);
  return session;
}

/**
 * Adds a new Principal to a session.
 * @param {string} code
 * @param {string} name
 * @returns {{ id: string, name: string, pin: string, createdAt: number }}
 */
export function addPrincipal(code, name) {
  const session = sessions.get(code);
  if (!session) throw new Error('Session not found');

  const id = 'prn-' + Math.random().toString(36).substring(2, 10);
  const pin = generate6DigitPin();
  const inviteToken = crypto.randomBytes(12).toString('base64url');
  const principal = {
    id,
    name: name.trim(),
    pin,
    inviteToken,
    createdAt: Date.now()
  };
  session.principals.set(id, principal);
  return principal;
}

/**
 * Regenerates a principal's 6-digit PIN.
 * @param {string} code
 * @param {string} principalId
 * @returns {string | null} new PIN
 */
export function regeneratePrincipalPin(code, principalId) {
  const session = sessions.get(code);
  if (!session) return null;
  const p = session.principals.get(principalId);
  if (!p) return null;
  p.pin = generate6DigitPin();
  return p.pin;
}

/**
 * Revokes a principal.
 * @param {string} code
 * @param {string} principalId
 * @returns {boolean}
 */
export function revokePrincipal(code, principalId) {
  const session = sessions.get(code);
  if (!session) return false;
  return session.principals.delete(principalId);
}

/**
 * Finds a principal by their 6-digit PIN in a session.
 * @param {string} code
 * @param {string} pin
 * @returns {Object | null}
 */
export function findPrincipalByInviteToken(code, inviteToken) {
  const session = sessions.get(code);
  if (!session || !inviteToken) return null;
  const clean = String(inviteToken).trim();
  for (const p of session.principals.values()) {
    if (p.inviteToken && p.inviteToken === clean) return p;
  }
  return null;
}

export function findPrincipalByPin(code, pin) {
  const session = sessions.get(code);
  if (!session || !pin) return null;
  const cleanPin = String(pin).trim();
  for (const p of session.principals.values()) {
    if (p.pin === cleanPin) {
      return p;
    }
  }
  return null;
}

/**
 * Checks whether Fair Mode is currently active for the session.
 * @param {Object} session
 * @returns {boolean}
 */
export function isFairModeActive(session) {
  if (!session?.settings) return false;
  const { fairMode, fairFromMinutesBeforeEnd, sessionEndsAt } = session.settings;
  if (fairMode === 'on') return true;
  if (fairMode === 'off') return false;
  if (fairMode === 'auto') {
    if (!sessionEndsAt) return false;
    const remainingMs = sessionEndsAt - Date.now();
    const thresholdMs = (fairFromMinutesBeforeEnd || 15) * 60 * 1000;
    return remainingMs <= thresholdMs;
  }
  return false;
}

/**
 * Returns fair-sorted queued attendee list.
 * If fair mode is active: sort by speakCount ASC, then raisedAt ASC.
 * Otherwise: sort by raisedAt ASC.
 * @param {Object} session
 * @returns {Array<{ id: string, name: string, reason: string, raisedAt: number, urgent: boolean, speakCount: number, hasNotSpoken: boolean }>}
 */
export function getSortedAttendeeQueue(session) {
  if (!session?.attendeeHands) return [];
  const hands = Array.from(session.attendeeHands.values());
  const fairActive = isFairModeActive(session);

  const enhanced = hands.map(h => {
    const hist = session.speakHistory.get(h.id);
    const count = hist?.count || 0;
    return {
      ...h,
      speakCount: count,
      hasNotSpoken: count === 0
    };
  });

  if (fairActive) {
    return enhanced.sort((a, b) => {
      if (a.speakCount !== b.speakCount) {
        return a.speakCount - b.speakCount;
      }
      return a.raisedAt - b.raisedAt;
    });
  }

  return enhanced.sort((a, b) => a.raisedAt - b.raisedAt);
}

/**
 * Records end of speaking turn into session.speakHistory.
 * @param {Object} session
 * @param {string} identity
 * @param {string} name
 * @param {string} [reason]
 */
export function recordSpeakHistoryEnd(session, identity, name, reason) {
  if (!session || !session.floor || session.floor.holderId !== identity) return;
  const startedAt = session.floor.startedAt;
  const durationSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));

  let hist = session.speakHistory.get(identity);
  if (!hist) {
    hist = {
      id: identity,
      name: name || session.floor.holderName || 'Attendee',
      count: 0,
      lastSpokeAt: 0,
      totalSeconds: 0,
      history: []
    };
    session.speakHistory.set(identity, hist);
  }

  hist.count += 1;
  hist.lastSpokeAt = Date.now();
  hist.totalSeconds += durationSeconds;
  hist.history.push({
    startedAt,
    durationSeconds,
    reason: reason || session.floor?.reason || 'floor'
  });
}

/**
 * Clears all sessions (primarily for testing).
 */
export function clearSessions() {
  sessions.clear();
  avatarStore.clearAll();
}
