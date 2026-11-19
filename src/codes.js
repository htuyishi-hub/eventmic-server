/**
 * Unambiguous alphanumeric characters (excluding 0, O, 1, I)
 */
export const UNAMBIGUOUS_CHARS = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/**
 * Validates whether a code matches the 6-character unambiguous format.
 * @param {string} code
 * @returns {boolean}
 */
export function isValidCode(code) {
  if (!code || typeof code !== 'string') return false;
  const upper = code.trim().toUpperCase();
  if (upper.length !== 6) return false;
  for (let i = 0; i < 6; i++) {
    if (!UNAMBIGUOUS_CHARS.includes(upper[i])) return false;
  }
  return true;
}
