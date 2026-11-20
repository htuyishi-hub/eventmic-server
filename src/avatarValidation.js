import sharp from 'sharp';

export const MAX_AVATAR_BYTES = 150 * 1024; // 150 KB

/**
 * Detects image MIME type purely by magic bytes.
 * Does NOT trust client-supplied Content-Type.
 * @param {Buffer} buffer
 * @returns {'image/jpeg' | 'image/png' | 'image/webp' | null}
 */
export function detectMagicBytes(buffer) {
  if (!buffer || !Buffer.isBuffer(buffer) || buffer.length < 12) {
    return null;
  }

  // JPEG: 0xFF, 0xD8, 0xFF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) {
    return 'image/jpeg';
  }

  // PNG: 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4E &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0D &&
    buffer[5] === 0x0A &&
    buffer[6] === 0x1A &&
    buffer[7] === 0x0A
  ) {
    return 'image/png';
  }

  // WebP: RIFF header at 0..3 and WEBP at 8..11
  if (
    buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 &&
    buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50
  ) {
    return 'image/webp';
  }

  return null;
}

/**
 * Re-encodes any valid image to 256x256 WebP with ~80 quality and stripped metadata.
 * @param {Buffer} inputBuffer
 * @returns {Promise<Buffer>}
 */
export async function reencodeAvatar(inputBuffer) {
  return sharp(inputBuffer)
    .resize(256, 256, {
      fit: 'cover',
      position: 'center'
    })
    .webp({ quality: 80 })
    .toBuffer();
}
