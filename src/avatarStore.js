/**
 * In-memory temporary avatar storage.
 * Map(sessionCode -> Map(identity -> { bytes, mime, version, updatedAt }))
 * Never writes to disk or database.
 */

const SESSION_CAP_BYTES = 50 * 1024 * 1024; // 50 MB per session
const DEFAULT_DISCONNECT_GRACE_MS = 10 * 60 * 1000; // 10 minutes

export class AvatarStore {
  constructor(options = {}) {
    // Map<sessionCode, Map<identity, { bytes: Buffer, mime: string, version: number, updatedAt: number }>>
    this.sessions = new Map();
    // Map<sessionCode, number> (total bytes stored per session)
    this.sessionBytes = new Map();
    // Map<`${sessionCode}:${identity}`, NodeJS.Timeout>
    this.disconnectTimers = new Map();
    // Map<`${sessionCode}:${identity}`, number[]> upload timestamps for 5 uploads / min rate limit
    this.uploadTimestamps = new Map();
    this.sessionCapBytes = options.sessionCapBytes || SESSION_CAP_BYTES;
    this.disconnectGraceMs = options.disconnectGraceMs || DEFAULT_DISCONNECT_GRACE_MS;
  }

  /**
   * Checks rate limit: 5 uploads per minute per identity.
   * @param {string} sessionCode
   * @param {string} identity
   * @returns {boolean} true if allowed, false if rate limited
   */
  checkUploadRateLimit(sessionCode, identity) {
    const key = `${sessionCode}:${identity}`;
    const now = Date.now();
    const windowStart = now - 60 * 1000;

    let timestamps = this.uploadTimestamps.get(key) || [];
    timestamps = timestamps.filter(t => t > windowStart);

    if (timestamps.length >= 5) {
      this.uploadTimestamps.set(key, timestamps);
      return false;
    }

    timestamps.push(now);
    this.uploadTimestamps.set(key, timestamps);
    return true;
  }

  /**
   * Sets or updates an avatar for a session participant.
   * @param {string} sessionCode
   * @param {string} identity
   * @param {Buffer} bytes
   * @param {string} mime
   * @returns {{ version: number, updatedAt: number, size: number }}
   */
  setAvatar(sessionCode, identity, bytes, mime = 'image/webp') {
    const code = String(sessionCode).trim().toUpperCase();
    if (!this.sessions.has(code)) {
      this.sessions.set(code, new Map());
      this.sessionBytes.set(code, 0);
    }

    const sessionAvatars = this.sessions.get(code);
    const existing = sessionAvatars.get(identity);
    const existingSize = existing ? existing.bytes.length : 0;
    const currentTotal = this.sessionBytes.get(code) || 0;
    const newTotal = currentTotal - existingSize + bytes.length;

    if (newTotal > this.sessionCapBytes) {
      const err = new Error('Session avatar storage cap exceeded (50 MB max)');
      err.code = 'SESSION_AVATAR_CAP_EXCEEDED';
      throw err;
    }

    // Cancel any disconnect cleanup timer if participant returns or uploads
    this.cancelDisconnectCleanup(code, identity);

    const version = existing ? existing.version + 1 : 1;
    const updatedAt = Date.now();

    sessionAvatars.set(identity, {
      bytes,
      mime,
      version,
      updatedAt
    });
    this.sessionBytes.set(code, newTotal);

    return { version, updatedAt, size: bytes.length };
  }

  /**
   * Retrieves an avatar.
   * @param {string} sessionCode
   * @param {string} identity
   * @returns {{ bytes: Buffer, mime: string, version: number, updatedAt: number } | null}
   */
  getAvatar(sessionCode, identity) {
    const code = String(sessionCode).trim().toUpperCase();
    const sessionAvatars = this.sessions.get(code);
    if (!sessionAvatars) return null;
    return sessionAvatars.get(identity) || null;
  }

  /**
   * Checks if an identity has an avatar and returns metadata.
   * @param {string} sessionCode
   * @param {string} identity
   * @returns {{ hasAvatar: boolean, avatarVersion: number }}
   */
  getAvatarMeta(sessionCode, identity) {
    const avatar = this.getAvatar(sessionCode, identity);
    if (!avatar) {
      return { hasAvatar: false, avatarVersion: 0 };
    }
    return { hasAvatar: true, avatarVersion: avatar.version };
  }

  /**
   * Deletes an avatar for an identity in a session.
   * @param {string} sessionCode
   * @param {string} identity
   * @returns {boolean} true if deleted
   */
  deleteAvatar(sessionCode, identity) {
    const code = String(sessionCode).trim().toUpperCase();
    this.cancelDisconnectCleanup(code, identity);

    const sessionAvatars = this.sessions.get(code);
    if (!sessionAvatars) return false;

    const existing = sessionAvatars.get(identity);
    if (!existing) return false;

    sessionAvatars.delete(identity);
    const currentTotal = this.sessionBytes.get(code) || 0;
    this.sessionBytes.set(code, Math.max(0, currentTotal - existing.bytes.length));
    return true;
  }

  /**
   * Deletes all avatars for a session (e.g. when session ends).
   * @param {string} sessionCode
   */
  deleteSession(sessionCode) {
    const code = String(sessionCode).trim().toUpperCase();

    // Cancel all disconnect timers for this session
    for (const [key, timer] of this.disconnectTimers.entries()) {
      if (key.startsWith(`${code}:`)) {
        clearTimeout(timer);
        this.disconnectTimers.delete(key);
      }
    }

    // Clear upload rate limit timestamps
    for (const key of this.uploadTimestamps.keys()) {
      if (key.startsWith(`${code}:`)) {
        this.uploadTimestamps.delete(key);
      }
    }

    this.sessions.delete(code);
    this.sessionBytes.delete(code);
  }

  /**
   * Clears all in-memory avatars and timers across all sessions.
   */
  clearAll() {
    for (const timer of this.disconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.disconnectTimers.clear();
    this.uploadTimestamps.clear();
    this.sessions.clear();
    this.sessionBytes.clear();
  }

  /**
   * Returns total bytes stored for a session.
   * @param {string} sessionCode
   * @returns {number}
   */
  getSessionBytes(sessionCode) {
    const code = String(sessionCode).trim().toUpperCase();
    return this.sessionBytes.get(code) || 0;
  }

  /**
   * Schedules avatar deletion if participant disconnects and does not return within grace period (default 10 min).
   * @param {string} sessionCode
   * @param {string} identity
   * @param {Function} [onCleanup]
   */
  scheduleDisconnectCleanup(sessionCode, identity, onCleanup) {
    const code = String(sessionCode).trim().toUpperCase();
    const key = `${code}:${identity}`;

    this.cancelDisconnectCleanup(code, identity);

    // Only schedule if user actually has an avatar
    if (!this.getAvatar(code, identity)) return;

    const timer = setTimeout(() => {
      this.disconnectTimers.delete(key);
      const deleted = this.deleteAvatar(code, identity);
      if (deleted && typeof onCleanup === 'function') {
        try {
          onCleanup();
        } catch {}
      }
    }, this.disconnectGraceMs);

    this.disconnectTimers.set(key, timer);
  }

  /**
   * Cancels any pending disconnect cleanup timer.
   * @param {string} sessionCode
   * @param {string} identity
   */
  cancelDisconnectCleanup(sessionCode, identity) {
    const code = String(sessionCode).trim().toUpperCase();
    const key = `${code}:${identity}`;
    const timer = this.disconnectTimers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.disconnectTimers.delete(key);
    }
  }
}

// Global singleton instance for the server process
export const avatarStore = new AvatarStore();
