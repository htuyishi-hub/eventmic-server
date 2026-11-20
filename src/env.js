/**
 * Environment configuration and strict production validation.
 */

/**
 * Validates that all required environment variables are properly set in production.
 * Refuses to start if any required variable is missing or insecure, naming the variable without leaking values.
 * @param {Record<string, string | undefined>} [env=process.env]
 */
export function validateProductionEnv(env = process.env) {
  if (env.NODE_ENV !== 'production') {
    return;
  }

  const errors = [];

  if (!env.LIVEKIT_URL || !String(env.LIVEKIT_URL).trim()) {
    errors.push('LIVEKIT_URL');
  }

  if (!env.LIVEKIT_API_KEY || !String(env.LIVEKIT_API_KEY).trim() || env.LIVEKIT_API_KEY === 'devkey') {
    errors.push('LIVEKIT_API_KEY');
  }

  if (!env.LIVEKIT_API_SECRET || !String(env.LIVEKIT_API_SECRET).trim() || env.LIVEKIT_API_SECRET === 'secret') {
    errors.push('LIVEKIT_API_SECRET');
  }

  const supabaseConfigured = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
  if (!env.HOST_PASSCODE || !String(env.HOST_PASSCODE).trim()) {
    if (!supabaseConfigured) errors.push('HOST_PASSCODE');
  } else if (String(env.HOST_PASSCODE).trim() === '1234') {
    throw new Error('Insecure HOST_PASSCODE in production: default "1234" is rejected. Set a strong secret passcode.');
  }

  const tokenSecret = env.API_TOKEN_SECRET || env.LIVEKIT_API_SECRET;
  if (!tokenSecret || !String(tokenSecret).trim() || tokenSecret === 'secret') {
    errors.push('API_TOKEN_SECRET or LIVEKIT_API_SECRET');
  }

  if (errors.length > 0) {
    throw new Error(`Missing required production environment variable(s): ${errors.join(', ')}`);
  }
}
