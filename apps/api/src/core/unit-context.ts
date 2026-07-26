import { AsyncLocalStorage } from 'node:async_hooks';

// AGENTS.md §4.2:
// null      = cross-unit (hanya guard @CrossUnit / system worker finansial)
// string    = active unitId tervalidasi terhadap membership
// undefined = context tidak pernah di-set → BUG, wajib fail-closed
export const currentUnitContext = new AsyncLocalStorage<string | null>();

export const RLS_CROSS_UNIT_SENTINEL = '__ALL__';

export class MissingUnitContextError extends Error {
  constructor() {
    super('Unit context belum pernah di-set — request ditolak (AGENTS.md §4.2)');
  }
}

/** GUC value untuk transaksi saat ini. Throw kalau context hilang (fail-closed). */
export function resolveRlsValue(): string {
  const store = currentUnitContext.getStore();
  if (store === undefined) throw new MissingUnitContextError();
  return store === null ? RLS_CROSS_UNIT_SENTINEL : store;
}
