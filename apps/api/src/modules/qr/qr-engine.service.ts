import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

// AGENTS.md §5.2. GATE_PASS TIDAK di sini — Postgres-backed (GatePass model),
// karena butuh audit + survive restart; Redis hanya token 30 detik frekuensi tinggi.
export type DynamicQrType = 'GATE_ATTENDANCE' | 'CANTEEN_PAYMENT';

export const QR_TTL_SECONDS = 30;

export interface QrPayload {
  studentId: string;
  type: DynamicQrType;
}

export class QrEngineService {
  constructor(private readonly redis: Redis) {}

  /** Token CSPRNG 128-bit, key ber-namespace type: qr:{type}:{token}. */
  async generate(studentId: string, type: DynamicQrType): Promise<string> {
    const token = randomBytes(16).toString('base64url');
    await this.redis.set(
      `qr:${type}:${token}`,
      JSON.stringify({ studentId, type } satisfies QrPayload),
      'EX',
      QR_TTL_SECONDS,
    );
    return token;
  }

  /**
   * Single-use atomik: GETDEL — dua scanner bersamaan, tepat satu menang.
   * Namespace di key = scan salah-type MISS tanpa mengonsumsi token (§5.2):
   * scanner kasir tidak pernah membaca namespace GATE_ATTENDANCE.
   */
  async consume(token: string, scannerType: DynamicQrType): Promise<QrPayload | null> {
    const raw = await this.redis.getdel(`qr:${scannerType}:${token}`);
    if (!raw) return null;
    const payload = JSON.parse(raw) as QrPayload;
    // Lapis kedua — payload type harus cocok (defense in depth).
    if (payload.type !== scannerType) return null;
    return payload;
  }
}
