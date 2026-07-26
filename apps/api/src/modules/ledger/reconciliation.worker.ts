import { PrismaClient } from '@prisma/client';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { ReconciliationService, reportHasFindings } from './reconciliation.service';

export const RECONCILIATION_QUEUE = 'eos-reconciliation';
const JOB_NAME = 'daily-reconciliation';

/**
 * Repeat job harian 00:17 (AGENTS: hindari menit :00 — semua sistem
 * sedunia antre di menit itu; job denda perpustakaan sudah ambil 00:00).
 * Alert path: log ERROR terstruktur — notifikasi bendahara (FCM/email)
 * menyusul di Phase 2 saat modul notifikasi ada.
 */
export async function scheduleReconciliation(redisUrl = process.env.REDIS_URL!): Promise<Queue> {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue(RECONCILIATION_QUEUE, { connection });
  await queue.upsertJobScheduler(
    'daily-reconciliation-scheduler',
    { pattern: '17 0 * * *' },
    { name: JOB_NAME },
  );
  return queue;
}

export function startReconciliationWorker(
  prisma: PrismaClient,
  redisUrl = process.env.REDIS_URL!,
  onFindings?: (reportJson: string) => void,
): Worker {
  const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
  const service = new ReconciliationService(prisma);
  return new Worker(
    RECONCILIATION_QUEUE,
    async () => {
      const report = await service.run();
      if (reportHasFindings(report)) {
        const payload = JSON.stringify({
          level: 'error',
          event: 'ledger.reconciliation.drift',
          drifts: report.drifts,
          unbalancedJournals: report.unbalancedJournals,
          ranAt: report.ranAt.toISOString(),
        });
        // Structured log (AGENTS §4.6) — JANGAN auto-correct (§5.1).
        console.error(payload);
        onFindings?.(payload);
      }
      return { findings: reportHasFindings(report), checked: report.checkedAccounts };
    },
    { connection },
  );
}
