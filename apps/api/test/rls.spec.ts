import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { appClient, migratorClient, inUnit, truncateAll } from './helpers';
import { withUnitTx } from '../src/core/prisma';
import { MissingUnitContextError } from '../src/core/unit-context';

let app: PrismaClient;
let mig: PrismaClient;
let unitA: string;
let unitB: string;

beforeAll(async () => {
  app = appClient();
  mig = migratorClient();
});
afterAll(async () => {
  await app.$disconnect();
  await mig.$disconnect();
});

beforeEach(async () => {
  await truncateAll(mig);
  const a = await mig.unit.create({ data: { type: 'SD', name: 'SD' } });
  const b = await mig.unit.create({ data: { type: 'SMP', name: 'SMP' } });
  unitA = a.id;
  unitB = b.id;
  await mig.ledgerAccount.createMany({
    data: [
      { unitId: unitA, ownerType: 'INTERNAL', accountCode: 'X', label: 'A-acc' },
      { unitId: unitB, ownerType: 'INTERNAL', accountCode: 'X', label: 'B-acc' },
    ],
  });
});

describe('RLS fail-closed sebagai eos_app (AGENTS.md §4.2, §11)', () => {
  it('GUC unit A → baris unit B tak terlihat', async () => {
    const rows = await inUnit(unitA, () => withUnitTx(app, (tx) => tx.ledgerAccount.findMany()));
    expect(rows).toHaveLength(1);
    expect(rows[0].unitId).toBe(unitA);
  });

  it('undefined context → ditolak sebelum menyentuh DB', async () => {
    await expect(withUnitTx(app, (tx) => tx.ledgerAccount.findMany())).rejects.toBeInstanceOf(
      MissingUnitContextError,
    );
  });

  it('query tanpa set_config (GUC unset) → NOL baris — RLS menutup, bukan membuka', async () => {
    const rows = await app.ledgerAccount.findMany(); // di luar withUnitTx, koneksi polos
    expect(rows).toHaveLength(0);
  });

  it('GUC empty-string (sisa pooled connection) → NOL baris', async () => {
    const rows = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_unit_id', '', true)`;
      return tx.ledgerAccount.findMany();
    });
    expect(rows).toHaveLength(0);
  });

  it('INSERT dengan GUC unset ditolak (USING berlaku untuk write juga)', async () => {
    await expect(
      app.ledgerAccount.create({
        data: { unitId: unitA, ownerType: 'INTERNAL', accountCode: 'Y', label: 'no-guc' },
      }),
    ).rejects.toThrow(/row-level security/i);
  });

  it("cross-unit via sentinel '__ALL__' → semua baris", async () => {
    const rows = await inUnit(null, () => withUnitTx(app, (tx) => tx.ledgerAccount.findMany()));
    expect(rows).toHaveLength(2);
  });

  it('duplikat akun INTERNAL ber-accountCode sama di unit sama ditolak (partial unique)', async () => {
    await expect(
      inUnit(null, () =>
        withUnitTx(app, (tx) =>
          tx.ledgerAccount.create({
            data: { unitId: unitA, ownerType: 'INTERNAL', accountCode: 'X', label: 'dupe clearing' },
          }),
        ),
      ),
    ).rejects.toThrow();
  });
});
