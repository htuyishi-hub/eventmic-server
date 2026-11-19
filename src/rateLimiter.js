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

/**
 * Resets rate limit records (for testing).
 */
export function clearRateLimits() {
  requestLogs.clear();
}
