import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Redis from 'ioredis';
import { QrEngineService } from '../src/modules/qr/qr-engine.service';

let redis: Redis;
let qr: QrEngineService;

beforeAll(() => {
  redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  qr = new QrEngineService(redis);
});
afterAll(async () => {
  await redis.quit();
});

describe('QrEngineService (AGENTS.md §5.2, §11)', () => {
  it('single-use: dua scanner bersamaan → tepat satu sukses (GETDEL atomik)', async () => {
    const token = await qr.generate('student-1', 'CANTEEN_PAYMENT');
    const [a, b] = await Promise.all([
      qr.consume(token, 'CANTEEN_PAYMENT'),
      qr.consume(token, 'CANTEEN_PAYMENT'),
    ]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.studentId).toBe('student-1');
  });

  it('scan salah-type → miss TANPA mengonsumsi (namespace key per type)', async () => {
    const token = await qr.generate('student-2', 'GATE_ATTENDANCE');
    // Kasir memindai QR gerbang: namespace CANTEEN_PAYMENT → miss.
    expect(await qr.consume(token, 'CANTEEN_PAYMENT')).toBeNull();
    // Token gerbang TIDAK hangus — scanner gerbang masih bisa memakainya.
    const gate = await qr.consume(token, 'GATE_ATTENDANCE');
    expect(gate?.studentId).toBe('student-2');
  });

  it('token expired (TTL) → null', async () => {
    const token = await qr.generate('student-3', 'GATE_ATTENDANCE');
    await redis.del(`qr:GATE_ATTENDANCE:${token}`); // simulasi TTL habis tanpa menunggu 30s
    expect(await qr.consume(token, 'GATE_ATTENDANCE')).toBeNull();
  });

  it('token acak tidak valid', async () => {
    expect(await qr.consume('tebak-tebakan', 'CANTEEN_PAYMENT')).toBeNull();
  });
});
