import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { emitOutbox } from '../src/core/outbox/outbox';
import { createOutboxQueue, startOutboxRelay, OUTBOX_QUEUE_NAME } from '../src/core/outbox/outbox-relay';
import { migratorClient, truncateAll } from './helpers';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

let mig: PrismaClient;
let queue: Queue;

beforeAll(() => {
  mig = migratorClient();
  queue = createOutboxQueue(REDIS_URL);
});

afterAll(async () => {
  await queue.close();
  await mig.$disconnect();
});

beforeEach(async () => {
  await truncateAll(mig);
  await queue.obliterate({ force: true });
});

describe('Outbox relay + BullMQ nyata (Redis)', () => {
  it('event domain sampai ke worker BullMQ end-to-end; jobId = outbox row id (dedup)', async () => {
    const received: { topic: string; unitId: string; key?: string }[] = [];
    const workerConn = new IORedis(REDIS_URL, { maxRetriesPerRequest: null });
    const worker = new Worker(
      OUTBOX_QUEUE_NAME,
      async (job) => {
        received.push({ topic: job.name, unitId: job.data.unitId, key: job.data.idempotencyKey });
      },
      { connection: workerConn },
    );

    const relay = startOutboxRelay(mig, queue, 200);
    try {
      await mig.$transaction(async (tx) => {
        await emitOutbox(tx, 'library.fine.created', { unitId: 'u-1', idempotencyKey: 'fine:L1:2026-07-26' });
        await emitOutbox(tx, 'ledger.reversal.requested', { unitId: 'u-1', idempotencyKey: 'reversal:J1:0' });
      });

      // Tunggu worker konsumsi (relay poll 200ms + worker async).
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('timeout menunggu worker')), 10_000);
        const check = setInterval(() => {
          if (received.length >= 2) {
            clearTimeout(deadline);
            clearInterval(check);
            resolve();
          }
        }, 100);
      });

      expect(received.map((r) => r.topic).sort()).toEqual([
        'ledger.reversal.requested',
        'library.fine.created',
      ]);
      expect(received.every((r) => r.unitId === 'u-1')).toBe(true);

      // Semua baris outbox tertandai published.
      expect(await mig.outboxEvent.count({ where: { publishedAt: null } })).toBe(0);

      // Pump ulang manual → tidak ada job baru (dedup by publishedAt + jobId).
      const { pumpOutboxOnce } = await import('../src/core/outbox/outbox');
      expect(await pumpOutboxOnce(mig, queue)).toBe(0);
    } finally {
      await relay.stop();
      await worker.close();
      await workerConn.quit();
    }
  });

  it('relay survive Redis error: baris tetap unpublished, tick berikutnya mengirim', async () => {
    // Queue palsu yang gagal sekali lalu delegasi ke queue asli.
    let failures = 1;
    const flakyQueue = {
      add: async (name: string, data: unknown, opts?: object) => {
        if (failures > 0) {
          failures--;
          throw new Error('redis blip');
        }
        return queue.add(name, data, opts);
      },
    } as unknown as Queue;

    const relay = startOutboxRelay(mig, flakyQueue, 150);
    try {
      await mig.$transaction(async (tx) => {
        await emitOutbox(tx, 'canteen.order.paid', { unitId: 'u-2', idempotencyKey: 'order:1' });
      });
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('timeout')), 10_000);
        const check = setInterval(async () => {
          const pending = await mig.outboxEvent.count({ where: { publishedAt: null } });
          if (pending === 0) {
            clearTimeout(deadline);
            clearInterval(check);
            resolve();
          }
        }, 100);
      });
    } finally {
      await relay.stop();
    }
  });
});
