import { PrismaClient } from '@prisma/client';
import { currentUnitContext } from '../src/core/unit-context';
import { createPrismaClient } from '../src/core/prisma';

// Test WAJIB connect sebagai eos_app (AGENTS.md §11) — test sebagai owner tidak membuktikan apa-apa.
export const APP_URL = process.env.DATABASE_URL ?? 'postgresql://eos_app:eos_app_dev@127.0.0.1:5433/eos?schema=public';
export const MIGRATOR_URL =
  process.env.MIGRATOR_DATABASE_URL ?? 'postgresql://eos_migrator:eos_migrator_dev@127.0.0.1:5433/eos?schema=public';

export function appClient(): PrismaClient {
  return createPrismaClient(APP_URL);
}

/** Owner client HANYA untuk setup/teardown fixture (RLS-forced tables butuh sentinel juga). */
export function migratorClient(): PrismaClient {
  return createPrismaClient(MIGRATOR_URL);
}

export function inUnit<T>(unitId: string | null, fn: () => Promise<T>): Promise<T> {
  return currentUnitContext.run(unitId, fn);
}

export async function truncateAll(prisma: PrismaClient): Promise<void> {
  // Session-scope sentinel: FORCE RLS berlaku juga untuk migrator saat DML/TRUNCATE.
  await prisma.$executeRaw`SELECT set_config('app.current_unit_id', '__ALL__', false)`;
  await prisma.$executeRawUnsafe(
    `TRUNCATE "LedgerEntry","JournalEntry","LedgerAccount","GatePass","WebhookInbox","OutboxEvent","UnitMembership","User","Unit" CASCADE`,
  );
}
