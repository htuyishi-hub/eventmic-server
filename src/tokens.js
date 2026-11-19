import { AccessToken } from 'livekit-server-sdk';

/**
 * Creates a scoped LiveKit AccessToken on demand.
 * 
 * @param {Object} params
 * @param {string} params.role - 'admin' | 'principal' | 'attendee'
 * @param {string} params.code - 6-char session code
 * @param {string} params.identity - Unique participant identity
 * @param {string} params.name - Display name
 * @param {number} [params.ttlSeconds] - Token time-to-live in seconds
 * @param {boolean} [params.isUrgent] - Whether this is an urgent blip (7s ttl)
 * @returns {Promise<{ token: string, url: string, ttlSeconds: number }>}
 */
export async function createLiveKitToken({
  role,
  code,
  identity,
  name,
  ttlSeconds,
  isUrgent = false
}) {
  const livekitUrl = process.env.LIVEKIT_URL || 'wss://demo.livekit.cloud';
  const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
  const apiSecret = process.env.LIVEKIT_API_SECRET || 'secret';
  const roomName = `em-${code.toUpperCase()}`;

  let ttl = ttlSeconds;
  let canPublish = false;
  let canSubscribe = false;
  let canPublishData = false;
  let roomAdmin = false;

  if (role === 'admin') {
    ttl = ttl || 6 * 3600; // 6 hours
    canSubscribe = true; // Admin listens to all stage audio
    canPublish = false;
    canPublishData = true;
    roomAdmin = true;
  } else if (role === 'principal') {
    ttl = ttl || 3600; // 1 hour
    canSubscribe = false; // /speaker must NEVER play audio to prevent PA feedback
    canPublish = true;
    canPublishData = true;
  } else if (role === 'attendee') {
    if (isUrgent) {
      ttl = ttl || 7; // Urgent blip: 7s TTL
    } else {
      ttl = ttl || 120; // Default turn cap: 2 minutes
    }
    canSubscribe = false; // Attendees don't subscribe over WebRTC
    canPublish = true; // Can publish mic when granted
    canPublishData = false;
  }

  const at = new AccessToken(apiKey, apiSecret, {
    identity,
    name: name || (role === 'admin' ? 'Admin' : role === 'principal' ? 'Speaker' : 'Attendee'),
    ttl: `${ttl}s`
  });

  at.addGrant({
    room: roomName,
    roomJoin: true,
    roomAdmin,
    canSubscribe,
    canPublish,
    canPublishData,
    canUpdateOwnMetadata: true
  });

  const token = await at.toJwt();
  return {
    token,
    url: livekitUrl,
    ttlSeconds: ttl
  };
}
