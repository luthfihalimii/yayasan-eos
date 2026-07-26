import {
  AccountOwnerType,
  JournalEntry,
  JournalRefType,
  JournalSource,
  Prisma,
  PrismaClient,
} from '@prisma/client';
import { withUnitTx, Tx } from '../../core/prisma';

export interface JournalLeg {
  accountId: string;
  /** SIGNED: positif = debit, negatif = kredit (AGENTS.md §5.1). */
  amount: Prisma.Decimal | number | string;
}

export interface PostJournalInput {
  unitId: string;
  source: JournalSource;
  refType: JournalRefType;
  refId?: string;
  idempotencyKey: string;
  legs: JournalLeg[];
  reversalOfJournalId?: string;
}

export class UnbalancedJournalError extends Error {
  constructor(sum: Prisma.Decimal) {
    super(`Journal tidak balance: SUM(amount) = ${sum} (wajib 0, kaki >= 2)`);
  }
}

export class LedgerAccountLockError extends Error {
  constructor(requested: string[], locked: string[]) {
    super(
      `Lock mismatch: minta ${requested.length} akun, ter-lock ${locked.length}. ` +
        `Akun tidak ada ATAU tersaring RLS (di luar unit context): ` +
        requested.filter((id) => !locked.includes(id)).join(', '),
    );
  }
}

export class InsufficientLedgerBalanceError extends Error {
  constructor(accountId: string) {
    super(`Saldo efektif tidak cukup untuk debit akun ${accountId}`);
  }
}

const D = Prisma.Decimal;

/** Saldo efektif (§5.1): akun STUDENT = kewajiban → tampil/dicek sebagai -SUM. */
export function effectiveBalance(ownerType: AccountOwnerType, rawSum: Prisma.Decimal): Prisma.Decimal {
  return ownerType === 'STUDENT' ? rawSum.negated() : rawSum;
}

export class LedgerService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Satu-satunya jalur tulis journal (§5.1). Idempoten: replay dengan
   * (source, idempotencyKey) sama mengembalikan journal lama tanpa efek.
   */
  async postJournal(input: PostJournalInput): Promise<{ journal: JournalEntry; replayed: boolean }> {
    const sum = input.legs.reduce((acc, l) => acc.plus(new D(l.amount)), new D(0));
    if (!sum.isZero() || input.legs.length < 2 || input.legs.some((l) => new D(l.amount).isZero())) {
      throw new UnbalancedJournalError(sum);
    }

    try {
      const journal = await withUnitTx(this.prisma, (tx) => this.write(tx, input));
      return { journal, replayed: false };
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await withUnitTx(this.prisma, (tx) =>
          tx.journalEntry.findUnique({
            where: { source_idempotencyKey: { source: input.source, idempotencyKey: input.idempotencyKey } },
          }),
        );
        if (existing) return { journal: existing, replayed: true };
      }
      throw e;
    }
  }

  private async write(tx: Tx, input: PostJournalInput): Promise<JournalEntry> {
    // Lock semua akun terurut (deadlock-free) + assert count: baris yang
    // tersaring RLS/tidak ada TIDAK error sendiri — kurang satu = abort.
    const ids = [...new Set(input.legs.map((l) => l.accountId))].sort();
    const locked = await tx.$queryRaw<{ id: string; ownerType: AccountOwnerType; unitId: string; balance: Prisma.Decimal }[]>`
      SELECT id, "ownerType", "unitId", balance FROM "LedgerAccount"
      WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
    if (locked.length !== ids.length) {
      throw new LedgerAccountLockError(ids, locked.map((r) => r.id));
    }
    const byId = new Map(locked.map((r) => [r.id, r]));

    // Validasi saldo efektif per akun STUDENT yang kena debit (jajan/denda).
    const deltas = new Map<string, Prisma.Decimal>();
    for (const leg of input.legs) {
      deltas.set(leg.accountId, (deltas.get(leg.accountId) ?? new D(0)).plus(new D(leg.amount)));
    }
    for (const [accountId, delta] of deltas) {
      const acc = byId.get(accountId)!;
      if (acc.ownerType === 'STUDENT') {
        const newEffective = new D(acc.balance).minus(delta); // balance = efektif; debit (+) menurunkan
        if (newEffective.isNegative() && delta.isPositive()) {
          throw new InsufficientLedgerBalanceError(accountId);
        }
      }
    }

    const journal = await tx.journalEntry.create({
      data: {
        unitId: input.unitId,
        source: input.source,
        refType: input.refType,
        refId: input.refId,
        idempotencyKey: input.idempotencyKey,
        reversalOfJournalId: input.reversalOfJournalId,
      },
    });

    for (const leg of input.legs) {
      const acc = byId.get(leg.accountId)!;
      await tx.ledgerEntry.create({
        data: {
          journalId: journal.id,
          accountId: leg.accountId,
          // unitId kaki mengikuti AKUN-nya, bukan journal (§5.1 — kaki lintas unit).
          unitId: acc.unitId,
          amount: new D(leg.amount),
        },
      });
      // Balance cache = saldo EFEKTIF, di-update DALAM transaksi yang sama (§5.1).
      const delta = acc.ownerType === 'STUDENT' ? new D(leg.amount).negated() : new D(leg.amount);
      await tx.ledgerAccount.update({
        where: { id: leg.accountId },
        data: { balance: { increment: delta } },
      });
    }
    return journal;
  }

  /**
   * Reversing journal (§5.1): kaki negasi, key reversal:{journalId}:{n} —
   * n = jumlah reversal sebelumnya, supaya re-reverse setelah reversal-of-reversal sah.
   * Aturan "maksimal satu reversal aktif" ditegakkan di sini, bukan oleh unique key.
   */
  async reverseJournal(journalId: string): Promise<{ journal: JournalEntry; replayed: boolean }> {
    const { original, legs, priorReversals, activeReversal } = await withUnitTx(this.prisma, async (tx) => {
      const original = await tx.journalEntry.findUniqueOrThrow({
        where: { id: journalId },
        include: { entries: true, reversals: { include: { reversals: true } } },
      });
      // Reversal aktif = reversal yang belum dibalik lagi.
      const active = original.reversals.find((r) => r.reversals.length === 0);
      return {
        original,
        legs: original.entries,
        priorReversals: original.reversals.length,
        activeReversal: active,
      };
    });
    if (activeReversal) {
      return { journal: activeReversal, replayed: true };
    }
    return this.postJournal({
      unitId: original.unitId,
      source: 'INTERNAL',
      refType: 'REVERSAL',
      refId: journalId,
      idempotencyKey: `reversal:${journalId}:${priorReversals}`,
      legs: legs.map((e) => ({ accountId: e.accountId, amount: new D(e.amount).negated() })),
      reversalOfJournalId: journalId,
    });
  }
}
