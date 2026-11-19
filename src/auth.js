import crypto from 'crypto';

/**
 * Timing-safe string comparison to prevent timing attacks.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function timingSafeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Express middleware to verify x-host-passcode.
 */
export function requireHostAuth(req, res, next) {
  const provided = req.headers['x-host-passcode'];
  const expected = process.env.HOST_PASSCODE || '1234';

  if (!provided || !timingSafeCompare(provided, expected)) {
    return res.status(401).json({
      code: 'UNAUTHORIZED',
      error: 'Invalid host passcode'
    });
  }

  next();
}
