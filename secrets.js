// AES-256-GCM encryption for secrets stored at rest (OAuth refresh tokens, etc.).
// The key comes from ENCRYPTION_KEY — a base64-encoded 32-byte value. Generate one:
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
//
// Ciphertext format: "v1:<base64(iv[12] | tag[16] | ciphertext)>"
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'v1';
let _key = null;

function key() {
  if (_key) return _key;
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw) throw new Error('ENCRYPTION_KEY is not set — cannot encrypt/decrypt stored secrets');
  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) throw new Error(`ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length})`);
  _key = buf;
  return _key;
}

// True when a valid 32-byte ENCRYPTION_KEY is configured.
export function isConfigured() {
  try { key(); return true; } catch { return false; }
}

export function encrypt(plaintext) {
  if (plaintext == null) return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}:${Buffer.concat([iv, tag, ct]).toString('base64')}`;
}

export function decrypt(payload) {
  if (payload == null) return null;
  const [v, b64] = String(payload).split(':');
  if (v !== PREFIX || !b64) throw new Error('malformed ciphertext');
  const buf = Buffer.from(b64, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}
