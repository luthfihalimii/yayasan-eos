import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { LedgerService, UnbalancedJournalError, InsufficientLedgerBalanceError, LedgerAccountLockError } from '../src/modules/ledger/ledger.service';
import { appClient, migratorClient, inUnit, truncateAll } from './helpers';

const D = Prisma.Decimal;

let app: PrismaClient;
let mig: PrismaClient;
let ledger: LedgerService;
let unitSmp: string;
let unitYayasan: string;
let student: string; // LedgerAccount id (STUDENT, unit SMP)
let revenue: string; // LedgerAccount id (INTERNAL kantin revenue, unit SMP)
let clearing: string; // LedgerAccount id (INTERNAL DOKU clearing, unit YAYASAN)

beforeAll(async () => {
  app = appClient();
  mig = migratorClient();
  ledger = new LedgerService(app);
});

afterAll(async () => {
  await app.$disconnect();
  await mig.$disconnect();
});

beforeEach(async () => {
  await truncateAll(mig);
  const smp = await mig.unit.create({ data: { type: 'SMP', name: 'SMP EOS' } });
  const yys = await mig.unit.create({ data: { type: 'YAYASAN', name: 'Yayasan' } });
  unitSmp = smp.id;
  unitYayasan = yys.id;
  const s = await mig.ledgerAccount.create({
    data: { unitId: unitSmp, ownerType: 'STUDENT', ownerId: smp.id /* dummy uuid */, label: 'Siswa A' },
  });
  const r = await mig.ledgerAccount.create({
    data: { unitId: unitSmp, ownerType: 'INTERNAL', accountCode: 'CANTEEN_REVENUE', label: 'Pendapatan Kantin' },
  });
  const c = await mig.ledgerAccount.create({
    data: { unitId: unitYayasan, ownerType: 'INTERNAL', accountCode: 'DOKU_CLEARING', label: 'DOKU Clearing' },
  });
  student = s.id;
  revenue = r.id;
  clearing = c.id;
});

function topupLegs(amount: number) {
  // Top-up: debit clearing (+), kredit siswa (−) — saldo efektif siswa naik.
  return [
    { accountId: clearing, amount },
    { accountId: student, amount: -amount },
  ];
}

describe('LedgerService.postJournal', () => {
  it('menolak journal tidak balance / kaki < 2 / amount 0', async () => {
    await inUnit(null, async () => {
      await expect(
        ledger.postJournal({
          unitId: unitSmp, source: 'INTERNAL', refType: 'TOPUP', idempotencyKey: 'k1',
          legs: [{ accountId: student, amount: 10 }, { accountId: revenue, amount: -9 }],
        }),
      ).rejects.toBeInstanceOf(UnbalancedJournalError);
      await expect(
        ledger.postJournal({
          unitId: unitSmp, source: 'INTERNAL', refType: 'TOPUP', idempotencyKey: 'k2',
          legs: [{ accountId: student, amount: 0 }, { accountId: revenue, amount: 0 }],
        }),
      ).rejects.toBeInstanceOf(UnbalancedJournalError);
    });
  });

  it('top-up menaikkan saldo efektif siswa; balance cache = efektif', async () => {
    await inUnit(null, async () => {
      await ledger.postJournal({
        unitId: unitYayasan, source: 'DOKU_QRIS', refType: 'TOPUP', idempotencyKey: 'inv-1', legs: topupLegs(50_000),
      });
    });
    const acc = await mig.ledgerAccount.findUniqueOrThrow({ where: { id: student } });
    expect(new D(acc.balance).toNumber()).toBe(50_000);
  });

  it('idempotent: key sama 2x → satu journal, replayed=true', async () => {
    await inUnit(null, async () => {
      const a = await ledger.postJournal({
        unitId: unitYayasan, source: 'DOKU_QRIS', refType: 'TOPUP', idempotencyKey: 'inv-dup', legs: topupLegs(10_000),
      });
      const b = await ledger.postJournal({
        unitId: unitYayasan, source: 'DOKU_QRIS', refType: 'TOPUP', idempotencyKey: 'inv-dup', legs: topupLegs(10_000),
      });
      expect(a.replayed).toBe(false);
      expect(b.replayed).toBe(true);
      expect(b.journal.id).toBe(a.journal.id);
    });
    expect(await mig.journalEntry.count()).toBe(1);
    const acc = await mig.ledgerAccount.findUniqueOrThrow({ where: { id: student } });
    expect(new D(acc.balance).toNumber()).toBe(10_000); // tidak dobel
  });

  it('debit melebihi saldo efektif → InsufficientLedgerBalanceError', async () => {
    await inUnit(null, async () => {
      await ledger.postJournal({
        unitId: unitYayasan, source: 'DOKU_QRIS', refType: 'TOPUP', idempotencyKey: 'inv-2', legs: topupLegs(5_000),
      });
      await expect(
        ledger.postJournal({
          unitId: unitSmp, source: 'INTERNAL', refType: 'CANTEEN_PAYMENT', idempotencyKey: 'pay-1',
          legs: [
            { accountId: student, amount: 7_000 },
            { accountId: revenue, amount: -7_000 },
          ],
        }),
      ).rejects.toBeInstanceOf(InsufficientLedgerBalanceError);
    });
  });

  it('debit paralel ke akun sama: lock serialize, tidak overdraft', async () => {
    await inUnit(null, async () => {
      await ledger.postJournal({
        unitId: unitYayasan, source: 'DOKU_QRIS', refType: 'TOPUP', idempotencyKey: 'inv-3', legs: topupLegs(10_000),
      });
      const pay = (n: number) =>
        ledger.postJournal({
          unitId: unitSmp, source: 'INTERNAL', refType: 'CANTEEN_PAYMENT', idempotencyKey: `pay-race-${n}`,
          legs: [
            { accountId: student, amount: 7_000 },
            { accountId: revenue, amount: -7_000 },
          ],
        });
      const results = await Promise.allSettled([pay(1), pay(2)]);
      const ok = results.filter((r) => r.status === 'fulfilled');
      expect(ok.length).toBe(1); // satu sukses, satu tolak — bukan dua-duanya lolos
    });
    const acc = await mig.ledgerAccount.findUniqueOrThrow({ where: { id: student } });
    expect(new D(acc.balance).toNumber()).toBe(3_000);
  });

  it('reversal: sekali sukses, replay tidak dobel, re-reverse setelah reversal-of-reversal sah', async () => {
    await inUnit(null, async () => {
      const { journal } = await ledger.postJournal({
        unitId: unitYayasan, source: 'DOKU_QRIS', refType: 'TOPUP', idempotencyKey: 'inv-4', legs: topupLegs(20_000),
      });
      const r1 = await ledger.reverseJournal(journal.id);
      expect(r1.replayed).toBe(false);
      const r1b = await ledger.reverseJournal(journal.id); // replay → reversal aktif dikembalikan
      expect(r1b.replayed).toBe(true);
      expect(r1b.journal.id).toBe(r1.journal.id);

      let acc = await mig.ledgerAccount.findUniqueOrThrow({ where: { id: student } });
      expect(new D(acc.balance).toNumber()).toBe(0);

      // Balik reversal-nya (efek asli kembali), lalu reverse original lagi → key :1, sah.
      await ledger.reverseJournal(r1.journal.id);
      const r2 = await ledger.reverseJournal(journal.id);
      expect(r2.replayed).toBe(false);
      expect(r2.journal.idempotencyKey).toBe(`reversal:${journal.id}:1`);
      acc = await mig.ledgerAccount.findUniqueOrThrow({ where: { id: student } });
      expect(new D(acc.balance).toNumber()).toBe(0);
    });
  });

  it('lock mismatch: akun di luar unit context (tersaring RLS) → abort, bukan lanjut diam-diam', async () => {
    // Context unit SMP mencoba journal yang menyentuh akun clearing milik unit YAYASAN.
    await inUnit(unitSmp, async () => {
      await expect(
        ledger.postJournal({
          unitId: unitSmp, source: 'INTERNAL', refType: 'TOPUP', idempotencyKey: 'k-lock',
          legs: topupLegs(1_000),
        }),
      ).rejects.toBeInstanceOf(LedgerAccountLockError);
    });
    expect(await mig.journalEntry.count()).toBe(0);
  });

  it('trigger DB menolak journal timpang dari penulis bypass ($executeRaw)', async () => {
    await mig.$executeRaw`SELECT set_config('app.current_unit_id', '__ALL__', false)`;
    await expect(
      mig.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_unit_id', '__ALL__', true)`;
        const j = await tx.journalEntry.create({
          data: { unitId: unitSmp, source: 'INTERNAL', refType: 'MANUAL_ADJUSTMENT', idempotencyKey: 'bypass-1' },
        });
        // Satu kaki saja, tidak balance — service dilewati, trigger COMMIT harus menolak.
        await tx.ledgerEntry.create({
          data: { journalId: j.id, accountId: student, unitId: unitSmp, amount: new D(500) },
        });
      }),
    ).rejects.toThrow(/tidak balance|kaki/);
  });
});
