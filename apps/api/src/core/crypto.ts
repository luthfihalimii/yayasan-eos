import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// AES-256-GCM untuk secret TOTP di DB (PRD §5.1 — enkripsi at-rest data sensitif).
// Key dari APP_ENCRYPTION_KEY (32-byte, base64/hex/panjang apapun → SHA-256 derive).

function key(): Buffer {
  const raw = process.env.APP_ENCRYPTION_KEY;
  if (!raw) throw new Error('APP_ENCRYPTION_KEY belum di-set');
  return createHash('sha256').update(raw).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), enc.toString('base64'), cipher.getAuthTag().toString('base64')].join('.');
}

export function decryptSecret(payload: string): string {
  const [iv, data, tag] = payload.split('.').map((p) => Buffer.from(p, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function sha256hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}
