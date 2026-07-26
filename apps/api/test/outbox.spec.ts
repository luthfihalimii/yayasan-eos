import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import type { Queue } from 'bullmq';
import { emitOutbox, pumpOutboxOnce } from '../src/core/outbox/outbox';
import { migratorClient, truncateAll } from './helpers';

let mig: PrismaClient;

// Fake queue — kontrak yang dipakai pumpOutboxOnce hanya .add(name, data, opts).
function fakeQueue() {
  const jobs: { name: string; data: unknown; jobId?: string }[] = [];
  return {
    jobs,
    queue: {
      add: async (name: string, data: unknown, opts?: { jobId?: string }) => {
        jobs.push({ name, data, jobId: opts?.jobId });
      },
    } as unknown as Queue,
  };
}

beforeAll(() => {
  mig = migratorClient();
});
afterAll(async () => {
  await mig.$disconnect();
});
beforeEach(async () => {
  await truncateAll(mig);
});

describe('Transactional outbox (AGENTS.md §4.3, §11)', () => {
  it('rollback transaksi domain → event ikut hilang (atomik, tidak ada event yatim)', async () => {
    await expect(
      mig.$transaction(async (tx) => {
        await emitOutbox(tx, 'library.fine.created', { unitId: 'u1', idempotencyKey: 'fine:1:2026-07-26' });
        throw new Error('domain write gagal');
      }),
    ).rejects.toThrow('domain write gagal');
    expect(await mig.outboxEvent.count()).toBe(0);
  });

  it('commit → relay publish sekali, tandai published; pump kedua tidak mengulang', async () => {
    const { jobs, queue } = fakeQueue();
    await mig.$transaction(async (tx) => {
      await emitOutbox(tx, 'library.fine.created', { unitId: 'u1', idempotencyKey: 'fine:2:2026-07-26' });
    });
    expect(await pumpOutboxOnce(mig, queue)).toBe(1);
    expect(await pumpOutboxOnce(mig, queue)).toBe(0); // sudah published
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('library.fine.created');
    expect(jobs[0].jobId).toBeDefined(); // dedup BullMQ via outbox row id
  });

  it('crash relay setelah add() sebelum mark → event terbit lagi, jobId sama (konsumen idempoten yang menyelesaikan)', async () => {
    const { jobs, queue } = fakeQueue();
    await mig.$transaction(async (tx) => {
      await emitOutbox(tx, 'ledger.reversal.requested', { unitId: 'u1', idempotencyKey: 'reversal:j1:0' });
    });
    // Simulasi crash: add jalan, mark tidak (queue yang throw SETELAH mencatat).
    const crashyQueue = {
      add: async (name: string, data: unknown, opts?: { jobId?: string }) => {
        jobs.push({ name, data, jobId: opts?.jobId });
        throw new Error('redis putus setelah add');
      },
    } as unknown as Queue;
    await expect(pumpOutboxOnce(mig, crashyQueue)).rejects.toThrow();
    // Retry pump normal → publish ulang dengan jobId SAMA → BullMQ dedup.
    expect(await pumpOutboxOnce(mig, queue)).toBe(1);
    expect(jobs).toHaveLength(2);
    expect(jobs[0].jobId).toBe(jobs[1].jobId);
  });
});
