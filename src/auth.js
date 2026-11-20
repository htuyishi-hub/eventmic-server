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

function getTokenSecret(explicitSecret) {
  if (explicitSecret) return explicitSecret;
  const secret = process.env.API_TOKEN_SECRET || process.env.LIVEKIT_API_SECRET;
  if (!secret || secret === 'secret') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('Missing required production secret: API_TOKEN_SECRET or LIVEKIT_API_SECRET');
    }
    return 'secret';
  }
  return secret;
}

/**
 * Signs an HMAC-SHA256 API token (JWT format).
 * @param {{ role: string, code: string, identity: string, exp?: number, name?: string }} claims
 * @param {string} [secret]
 * @returns {string}
 */
export function signApiToken(claims, secret) {
  const signingSecret = getTokenSecret(secret);
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const exp = claims.exp || Math.floor(Date.now() / 1000) + (claims.role === 'admin' ? 6 * 3600 : 3 * 3600);
  const body = Buffer.from(JSON.stringify({
    role: claims.role,
    code: claims.code,
    identity: claims.identity,
    name: claims.name || '',
    ...(claims.email ? { email: claims.email } : {}),
    exp
  })).toString('base64url');

  const signature = crypto.createHmac('sha256', signingSecret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

/**
 * Verifies an HMAC-SHA256 API token.
 * @param {string} token
 * @param {string} [secret]
 * @returns {{ role: string, code: string, identity: string, exp: number, name?: string } | null}
 */
export function verifyApiToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;

  const verifySecret = getTokenSecret(secret);
  const expectedSig = crypto.createHmac('sha256', verifySecret).update(`${header}.${body}`).digest('base64url');
  if (!timingSafeCompare(signature, expectedSig)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/**
 * Express middleware to verify x-host-passcode (for admin passcode auth).
 */
export function resolveAdminFromRequest(req) {
  const authHeader = req.headers['authorization'] || '';
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const token = bearer || req.headers['x-admin-token'] || req.body?.adminToken;
  if (token) {
    const claims = verifyApiToken(token);
    if (claims && claims.role === 'organizer') {
      return {
        id: claims.identity,
        name: claims.name || 'Admin',
        email: claims.email || '',
        isOrganizer: true
      };
    }
  }

  const provided = req.headers['x-host-passcode'] || req.body?.passcode;
  const expected = process.env.HOST_PASSCODE || '1234';
  if (provided && timingSafeCompare(provided, expected)) {
    return { id: 'default-host', name: 'Host', email: '', isOrganizer: false };
  }
  return null;
}

export function requireHostAuth(req, res, next) {
  const admin = resolveAdminFromRequest(req);
  if (!admin) {
    return res.status(401).json({
      code: 'UNAUTHORIZED',
      error: 'Invalid admin credentials or passcode'
    });
  }
  req.admin = admin;
  next();
}

/**
 * Express middleware to verify signed API token and check role permissions.
 * @param {string[]} [allowedRoles]
 */
export function requireApiAuth(allowedRoles = []) {
  return (req, res, next) => {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : req.headers['x-api-token'];

    // Also support admin passcode directly if provided in x-host-passcode header
    const hostPasscode = req.headers['x-host-passcode'];
    const expectedPasscode = process.env.HOST_PASSCODE || '1234';
    if (hostPasscode && timingSafeCompare(hostPasscode, expectedPasscode)) {
      req.auth = {
        role: 'admin',
        code: req.body?.code || req.params?.code || '',
        identity: 'admin-passcode'
      };
      return next();
    }

    if (!token) {
      return res.status(401).json({
        code: 'UNAUTHORIZED',
        error: 'Missing API authorization token'
      });
    }

    const claims = verifyApiToken(token);
    if (!claims) {
      return res.status(401).json({
        code: 'UNAUTHORIZED',
        error: 'Invalid or expired API token'
      });
    }

    if (allowedRoles.length > 0 && !allowedRoles.includes(claims.role)) {
      return res.status(403).json({
        code: 'FORBIDDEN',
        error: `Action restricted to ${allowedRoles.join('/')}; you are ${claims.role}`
      });
    }

    req.auth = claims;
    next();
  };
}
