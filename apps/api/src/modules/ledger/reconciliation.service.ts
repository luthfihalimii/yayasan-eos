import { Prisma, PrismaClient } from '@prisma/client';

// AGENTS.md §5.1 — reconciliation harian: rekalkulasi dari SUM(LedgerEntry)
// vs balance cache, dan verifikasi ulang zero-sum per journal.
// Selisih = ALERT, JANGAN auto-silent-correct (drift bisa = fraud/bug —
// harus diinvestigasi manusia, bukan disembunyikan mesin).

export interface BalanceDrift {
  accountId: string;
  accountCode: string | null;
  label: string;
  cached: string; // Decimal as string — presisi penuh untuk laporan
  recomputed: string;
  diff: string;
}

export interface UnbalancedJournal {
  journalId: string;
  sum: string;
  legCount: number;
}

export interface ReconciliationReport {
  checkedAccounts: number;
  drifts: BalanceDrift[];
  unbalancedJournals: UnbalancedJournal[];
  ranAt: Date;
}

export class ReconciliationService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Jalan sebagai system context '__ALL__' (menyapu semua unit sekaligus).
   * Read-only — tidak mengubah apa pun. Alerting = tanggung jawab pemanggil
   * (log + notifikasi bendahara saat drift ditemukan).
   */
  async run(): Promise<ReconciliationReport> {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_unit_id', '__ALL__', true)`;

      // 1) Drift balance cache vs SUM — saldo efektif: STUDENT = -SUM, INTERNAL = SUM (§5.1).
      const drifts = await tx.$queryRaw<BalanceDrift[]>`
        SELECT
          a.id                AS "accountId",
          a."accountCode"     AS "accountCode",
          a.label,
          a.balance::text     AS cached,
          eff.recomputed::text AS recomputed,
          (a.balance - eff.recomputed)::text AS diff
        FROM "LedgerAccount" a
        CROSS JOIN LATERAL (
          SELECT CASE WHEN a."ownerType" = 'STUDENT'
                      THEN -COALESCE(SUM(e.amount), 0)
                      ELSE  COALESCE(SUM(e.amount), 0)
                 END AS recomputed
          FROM "LedgerEntry" e
          WHERE e."accountId" = a.id
        ) eff
        WHERE a.balance <> eff.recomputed`;

      // 2) Journal timpang — seharusnya mustahil (constraint trigger), tapi
      //    reconciliation memverifikasi ulang; trigger bisa saja di-drop keliru di migration.
      const unbalancedJournals = await tx.$queryRaw<UnbalancedJournal[]>`
        SELECT e."journalId" AS "journalId",
               SUM(e.amount)::text AS sum,
               COUNT(*)::int AS "legCount"
        FROM "LedgerEntry" e
        GROUP BY e."journalId"
        HAVING SUM(e.amount) <> 0 OR COUNT(*) < 2`;

      const checkedAccounts = await tx.ledgerAccount.count();
      return { checkedAccounts, drifts, unbalancedJournals, ranAt: new Date() };
    });
  }
}

export function reportHasFindings(r: ReconciliationReport): boolean {
  return r.drifts.length > 0 || r.unbalancedJournals.length > 0;
}
