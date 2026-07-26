import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

// AGENTS.md §5.1 — komponen HMAC: Client-Id, Request-Id, Request-Timestamp,
// Request-Target (path — tanpa ini callback QRIS sah bisa di-replay ke handler VA),
// Digest body. Format final dikonfirmasi ke DOKU (§13); struktur ini mengikuti
// spesifikasi publik DOKU ("Signature=HMACSHA256=...").
export interface DokuHeaders {
  clientId: string;
  requestId: string;
  requestTimestamp: string; // ISO 8601 UTC
  signature: string; // "HMACSHA256=<base64>"
}

export const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

export function computeDokuSignature(
  secretKey: string,
  h: Omit<DokuHeaders, 'signature'>,
  requestTarget: string,
  rawBody: string,
): string {
  const digest = createHash('sha256').update(rawBody).digest('base64');
  const component = [
    `Client-Id:${h.clientId}`,
    `Request-Id:${h.requestId}`,
    `Request-Timestamp:${h.requestTimestamp}`,
    `Request-Target:${requestTarget}`,
    `Digest:${digest}`,
  ].join('\n');
  return 'HMACSHA256=' + createHmac('sha256', secretKey).update(component).digest('base64');
}

export function verifyDokuSignature(
  secretKey: string,
  h: DokuHeaders,
  requestTarget: string,
  rawBody: string,
  now = Date.now(),
): { ok: true } | { ok: false; reason: string } {
  const ts = Date.parse(h.requestTimestamp);
  if (Number.isNaN(ts)) return { ok: false, reason: 'timestamp tidak valid' };
  if (Math.abs(now - ts) > TIMESTAMP_TOLERANCE_MS) return { ok: false, reason: 'timestamp stale' };

  const expected = computeDokuSignature(secretKey, h, requestTarget, rawBody);
  const a = Buffer.from(expected);
  const b = Buffer.from(h.signature);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}
