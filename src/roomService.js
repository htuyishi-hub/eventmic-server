import { RoomServiceClient } from 'livekit-server-sdk';

let customClient = null;

/**
 * Returns the active RoomServiceClient instance.
 * @returns {RoomServiceClient}
 */
export function getRoomServiceClient() {
  if (customClient) {
    return customClient;
  }
  const url = process.env.LIVEKIT_URL || 'https://demo.livekit.cloud';
  const apiKey = process.env.LIVEKIT_API_KEY || 'devkey';
  const apiSecret = process.env.LIVEKIT_API_SECRET || 'secret';
  return new RoomServiceClient(url, apiKey, apiSecret);
}

/**
 * Injects a mock RoomServiceClient for testing.
 * @param {any} client
 */
export function setRoomServiceClient(client) {
  customClient = client;
}
