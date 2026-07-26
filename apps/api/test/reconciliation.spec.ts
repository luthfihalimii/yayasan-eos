import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Prisma, PrismaClient } from '@prisma/client';
import { LedgerService } from '../src/modules/ledger/ledger.service';
import { ReconciliationService, reportHasFindings } from '../src/modules/ledger/reconciliation.service';
import { appClient, migratorClient, inUnit, truncateAll } from './helpers';

const D = Prisma.Decimal;

let app: PrismaClient;
let mig: PrismaClient;
let ledger: LedgerService;
let recon: ReconciliationService;
let unitYys: string;
let student: string;
let clearing: string;

beforeAll(() => {
  app = appClient();
  mig = migratorClient();
  ledger = new LedgerService(app);
  recon = new ReconciliationService(app); // jalan sebagai eos_app — RLS tetap berlaku
});
afterAll(async () => {
  await app.$disconnect();
  await mig.$disconnect();
});

beforeEach(async () => {
  await truncateAll(mig);
  const smp = await mig.unit.create({ data: { type: 'SMP', name: 'SMP' } });
  const yys = await mig.unit.create({ data: { type: 'YAYASAN', name: 'Yayasan' } });
  unitYys = yys.id;
  student = (
    await mig.ledgerAccount.create({
      data: { unitId: smp.id, ownerType: 'STUDENT', ownerId: smp.id, label: 'Siswa' },
    })
  ).id;
  clearing = (
    await mig.ledgerAccount.create({
      data: { unitId: yys.id, ownerType: 'INTERNAL', accountCode: 'DOKU_CLEARING', label: 'Clearing' },
    })
  ).id;
});

async function topup(key: string, amount: number) {
  await inUnit(null, () =>
    ledger.postJournal({
      unitId: unitYys,
      source: 'DOKU_QRIS',
      refType: 'TOPUP',
      idempotencyKey: key,
      legs: [
        { accountId: clearing, amount },
        { accountId: student, amount: -amount },
      ],
    }),
  );
}

describe('ReconciliationService (AGENTS.md §5.1)', () => {
  it('buku sehat → nol temuan; saldo efektif dua sisi cocok', async () => {
    await topup('inv-1', 50_000);
    await topup('inv-2', 25_000);
    const report = await recon.run();
    expect(report.checkedAccounts).toBe(2);
    expect(report.drifts).toHaveLength(0);
    expect(report.unbalancedJournals).toHaveLength(0);
    expect(reportHasFindings(report)).toBe(false);
  });

  it('drift balance cache terdeteksi dan TIDAK di-auto-correct', async () => {
    await topup('inv-3', 10_000);
    // Korupsi cache langsung (simulasi bug/kode nakal yang lolos REVOKE — via migrator).
    await mig.$executeRaw`SELECT set_config('app.current_unit_id', '__ALL__', false)`;
    await mig.$executeRawUnsafe(
      `UPDATE "LedgerAccount" SET balance = 999999 WHERE id = '${student}'`,
    );

    const report = await recon.run();
    expect(report.drifts).toHaveLength(1);
    expect(report.drifts[0].accountId).toBe(student);
    expect(new D(report.drifts[0].recomputed).toNumber()).toBe(10_000);
    expect(new D(report.drifts[0].cached).toNumber()).toBe(999_999);

    // TIDAK dikoreksi otomatis — nilai korup masih di tempat (alert, investigasi manusia).
    const acc = await mig.ledgerAccount.findUniqueOrThrow({ where: { id: student } });
    expect(new D(acc.balance).toNumber()).toBe(999_999);
  });

  it('normalisasi tanda benar: INTERNAL = SUM, STUDENT = -SUM (tidak false positive)', async () => {
    await topup('inv-4', 7_500);
    // clearing: SUM=+7500, cache=+7500 (INTERNAL); student: SUM=-7500, cache=+7500 (STUDENT efektif).
    const report = await recon.run();
    expect(report.drifts).toHaveLength(0);
  });
});
