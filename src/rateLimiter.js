/**
 * In-memory rate limiter per session and identity (not IP).
 * Essential for venues sharing a single public IP.
 */

const WINDOW_MS = 60 * 1000; // 1 minute
const MAX_REQUESTS_PER_WINDOW = 60; // 60 requests per minute

const requestLogs = new Map(); // key -> [timestamps]

/**
 * Checks if a request from key (${code}:${identity}) is allowed.
 * @param {string} key
 * @param {number} [maxRequests]
 * @param {number} [windowMs]
 * @returns {boolean} true if allowed, false if rate limited
 */
export function checkRateLimit(key, maxRequests = MAX_REQUESTS_PER_WINDOW, windowMs = WINDOW_MS) {
  if (!key) return true;
  const now = Date.now();
  let timestamps = requestLogs.get(key) || [];

  // Filter out timestamps outside window
  timestamps = timestamps.filter(t => now - t < windowMs);

  if (timestamps.length >= maxRequests) {
    requestLogs.set(key, timestamps);
    return false;
  }

  timestamps.push(now);
  requestLogs.set(key, timestamps);
  return true;
}

const failedPinAttempts = new Map(); // key -> { count: number, lockedUntil: number, firstAttempt: number }

/**
 * Checks if PIN attempts for this key are currently locked out.
 * @param {string} key
 * @returns {{ locked: boolean, remainingMs: number }}
 */
export function checkPinLockout(key) {
  if (!key) return { locked: false, remainingMs: 0 };
  const entry = failedPinAttempts.get(key);
  if (!entry) return { locked: false, remainingMs: 0 };
  const now = Date.now();
  if (entry.lockedUntil && entry.lockedUntil > now) {
    return { locked: true, remainingMs: entry.lockedUntil - now };
  }
  if (entry.lockedUntil && entry.lockedUntil <= now) {
    failedPinAttempts.delete(key);
    return { locked: false, remainingMs: 0 };
  }
  return { locked: false, remainingMs: 0 };
}

/**
 * Records a failed PIN attempt. If count >= maxAttempts (default 5), locks key for lockoutMs (default 60s).
 * @param {string} key
 * @param {number} [maxAttempts=5]
 * @param {number} [lockoutMs=60000]
 * @returns {{ locked: boolean, attempts: number }}
 */
export function recordFailedPinAttempt(key, maxAttempts = 5, lockoutMs = 60000) {
  if (!key) return { locked: false, attempts: 0 };
  const now = Date.now();
  let entry = failedPinAttempts.get(key) || { count: 0, lockedUntil: 0, firstAttempt: now };

  if (now - entry.firstAttempt > 5 * 60 * 1000 && !entry.lockedUntil) {
    entry = { count: 0, lockedUntil: 0, firstAttempt: now };
  }

  entry.count += 1;
  if (entry.count >= maxAttempts) {
    entry.lockedUntil = now + lockoutMs;
    failedPinAttempts.set(key, entry);
    return { locked: true, attempts: entry.count };
  }

  failedPinAttempts.set(key, entry);
  return { locked: false, attempts: entry.count };
}

/**
 * Resets failed PIN attempts upon successful auth.
 * @param {string} key
 */
export function resetFailedPinAttempts(key) {
  if (key) failedPinAttempts.delete(key);
}

/**
 * Resets rate limit records (for testing).
 */
export function clearRateLimits() {
  requestLogs.clear();
  failedPinAttempts.clear();
}
