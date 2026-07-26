import { PrismaClient, Prisma } from '@prisma/client';
import { resolveRlsValue } from './unit-context';

// Runtime client WAJIB pakai DATABASE_URL (eos_app, non-owner) — bukan MIGRATOR_DATABASE_URL.
export function createPrismaClient(url = process.env.DATABASE_URL): PrismaClient {
  return new PrismaClient({ datasources: { db: { url } } });
}

export type Tx = Prisma.TransactionClient;

/**
 * Semua akses DB lewat sini: satu transaksi, GUC di-set via set_config()
 * (parameterized — SET LOCAL tidak bisa; scope LOCAL aman untuk PgBouncer
 * transaction mode). resolveRlsValue() fail-closed pada context hilang.
 */
export async function withUnitTx<T>(
  prisma: PrismaClient,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const rlsValue = resolveRlsValue();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_unit_id', ${rlsValue}, true)`;
    return fn(tx);
  });
}
