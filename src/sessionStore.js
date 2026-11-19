import { UNAMBIGUOUS_CHARS } from './codes.js';

/**
 * In-memory session store
 * Map<string, {
 *   code: string,
 *   name: string,
 *   roomName: string,
 *   createdAt: number,
 *   status: 'live' | 'ended',
 *   speakerCount: number,
 *   handsRaised: number
 * }>
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
 * Clears all sessions (primarily for testing)
 */
export function clearSessions() {
  sessions.clear();
}
