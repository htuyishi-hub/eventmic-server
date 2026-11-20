/**
 * CORS and WebSocket origin verification middleware.
 */

/**
 * Checks whether an incoming origin is permitted.
 * Supports explicit ALLOWED_ORIGINS and wildcard Vercel previews (https://*.vercel.app).
 * @param {string | undefined} origin
 * @param {Record<string, string | undefined>} [env=process.env]
 * @returns {boolean}
 */
export function isAllowedOrigin(origin, env = process.env) {
  // Allow non-browser requests (e.g. curl, server-to-server, smoke test scripts)
  if (!origin) {
    return true;
  }

  const clean = origin.trim().replace(/\/+$/, '');

  // In non-production, default to allowing all origins if ALLOWED_ORIGINS is not set
  if (env.NODE_ENV !== 'production' && !env.ALLOWED_ORIGINS) {
    return true;
  }

  // Check explicit ALLOWED_ORIGINS list
  if (env.ALLOWED_ORIGINS) {
    const allowed = env.ALLOWED_ORIGINS.split(',').map(o => o.trim().replace(/\/+$/, '')).filter(Boolean);
    if (allowed.includes('*') || allowed.includes(clean)) {
      return true;
    }
  }

  // Check Vercel previews wildcard if enabled
  if (env.ALLOW_VERCEL_PREVIEWS === 'true' || env.ALLOW_VERCEL_PREVIEWS === '1') {
    if (/^https:\/\/[a-zA-Z0-9_.-]+\.vercel\.app$/i.test(clean)) {
      return true;
    }
  }

  // Log rejected origin only (never print secrets, headers, or internal state)
  console.warn(`[origin-check] Blocked unauthorized origin: ${clean}`);
  return false;
}

/**
 * Creates configured Express CORS options.
 * @param {Record<string, string | undefined>} [env=process.env]
 */
export function createCorsOptions(env = process.env) {
  return {
    origin: (origin, callback) => {
      if (isAllowedOrigin(origin, env)) {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-host-passcode', 'x-api-token']
  };
}
