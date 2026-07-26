import { Prisma, PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { Tx } from '../prisma';

// AGENTS.md §4.3 — transactional outbox: event ditulis DALAM transaksi domain,
// relay publish ke BullMQ terpisah. Payload event penulis-Ledger wajib bawa
// unitId + idempotencyKey (kontrak di /src/events/contracts).

export interface OutboxPayload {
  unitId: string;
  idempotencyKey?: string;
  [k: string]: unknown;
}

/** Panggil DI DALAM transaksi yang sama dengan write domain. */
export async function emitOutbox(tx: Tx, topic: string, payload: OutboxPayload): Promise<void> {
  await tx.outboxEvent.create({ data: { topic, payload: payload as Prisma.InputJsonValue } });
}

/**
 * Relay: poll baris belum-published → enqueue BullMQ → tandai published.
 * FOR UPDATE SKIP LOCKED = dua instance relay tidak dobel-publish.
 * Konsumen tetap wajib idempoten (at-least-once — crash di antara add()
 * dan markPublished = event terkirim 2x, dan itu by design).
 */
export async function pumpOutboxOnce(prisma: PrismaClient, queue: Queue, batch = 100): Promise<number> {
  const rows = await prisma.$transaction(async (tx) => {
    const pending = await tx.$queryRaw<{ id: string; topic: string; payload: unknown }[]>`
      SELECT id, topic, payload FROM "OutboxEvent"
      WHERE "publishedAt" IS NULL
      ORDER BY "createdAt"
      LIMIT ${batch}
      FOR UPDATE SKIP LOCKED`;
    for (const row of pending) {
      await queue.add(row.topic, row.payload, {
        jobId: row.id, // dedup level BullMQ: relay re-run tidak menggandakan job
        removeOnComplete: true,
      });
    }
    if (pending.length > 0) {
      await tx.$executeRaw`
        UPDATE "OutboxEvent" SET "publishedAt" = now()
        WHERE id = ANY(${pending.map((r) => r.id)}::uuid[])`;
    }
    return pending;
  });
  return rows.length;
}
