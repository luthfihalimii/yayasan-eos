import { PrismaClient } from '@prisma/client';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { pumpOutboxOnce } from './outbox';

export const OUTBOX_QUEUE_NAME = 'eos-events';

export function createOutboxQueue(redisUrl = process.env.REDIS_URL!): Queue {
  // maxRetriesPerRequest: null — requirement BullMQ untuk koneksi blocking.
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  return new Queue(OUTBOX_QUEUE_NAME, { connection });
}

/**
 * Relay loop (AGENTS.md §4.3): poll outbox → publish BullMQ → mark published.
 * Interval pendek cukup — SKIP LOCKED membuat multi-instance aman.
 * ponytail: polling 2s; ganti LISTEN/NOTIFY kalau latency event jadi masalah.
 */
export function startOutboxRelay(
  prisma: PrismaClient,
  queue: Queue,
  intervalMs = 2_000,
): { stop: () => Promise<void> } {
  let running = true;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    if (!running) return;
    try {
      // Drain: pump sampai kosong supaya backlog tidak menunggu interval berikutnya.
      while ((await pumpOutboxOnce(prisma, queue)) > 0) {
        if (!running) break;
      }
    } catch {
      // Redis putus dsb — baris tetap unpublished, tick berikutnya retry. Jangan crash relay.
    }
    if (running) timer = setTimeout(tick, intervalMs);
  };
  timer = setTimeout(tick, 0);

  return {
    stop: async () => {
      running = false;
      if (timer) clearTimeout(timer);
    },
  };
}
