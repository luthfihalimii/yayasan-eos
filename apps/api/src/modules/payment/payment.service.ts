import { Injectable } from '@nestjs/common';
import { Prisma, WebhookInbox } from '@prisma/client';
import { PrismaService } from '../../core/prisma.service';
import { currentUnitContext } from '../../core/unit-context';
import { LedgerService } from '../ledger/ledger.service';
import { WebhookChannel } from './webhook-inbox.service';

// Payload callback DOKU (subset yang kita andalkan — field final dikonfirmasi §13).
const REQUIRED = ['invoiceNumber', 'amount', 'studentAccountId'] as const;
export interface DokuCallbackPayload {
  invoiceNumber: string;
  amount: string | number;
  studentAccountId: string; // dipetakan dari VA number / QRIS reference oleh billing (Phase 2)
}

export class InvalidCallbackPayloadError extends Error {
  constructor(missing: string) {
    super(`Payload callback tidak lengkap: field ${missing} tidak ada`);
  }
}

/**
 * Prosesor inbox → journal top-up/SPP (PRD §0.1 settlement & clearing):
 * callback valid = uang sampai di DOKU, BELUM di yayasan →
 * [ +DOKU_CLEARING (unit YAYASAN), −akun siswa ] via LedgerService.
 * Journal settlement/fee menyusul saat dana cair (DOKU_SETTLEMENT, Phase 2).
 */
@Injectable()
export class PaymentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  async processCallback(inbox: WebhookInbox): Promise<string> {
    const payload = inbox.rawPayload as unknown as DokuCallbackPayload;
    for (const f of REQUIRED) {
      if (payload[f] === undefined || payload[f] === null || payload[f] === '') {
        throw new InvalidCallbackPayloadError(f);
      }
    }
    const amount = new Prisma.Decimal(payload.amount);
    if (!amount.isPositive()) throw new InvalidCallbackPayloadError('amount (harus > 0)');

    // Operasi menyentuh akun YAYASAN + akun siswa lintas unit → wajib context
    // system worker '__ALL__' (AGENTS.md §5.1) — bukan context unit request.
    return currentUnitContext.run(null, async () => {
      const clearing = await this.getClearingAccount();
      const { journal } = await this.ledger.postJournal({
        unitId: clearing.unitId, // journal settlement-side hidup di unit YAYASAN
        source: inbox.channel,
        refType: inbox.channel === 'DOKU_VA' ? 'SPP_PAYMENT' : 'TOPUP',
        refId: payload.invoiceNumber,
        idempotencyKey: inbox.businessKey,
        legs: [
          { accountId: clearing.id, amount },
          { accountId: payload.studentAccountId, amount: amount.negated() },
        ],
      });
      return journal.id;
    });
  }

  private async getClearingAccount() {
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_unit_id', '__ALL__', true)`;
      return tx.ledgerAccount.findFirstOrThrow({
        where: { ownerType: 'INTERNAL', accountCode: 'DOKU_CLEARING' },
      });
    });
  }
}

export function extractBusinessKey(channel: WebhookChannel, payload: DokuCallbackPayload): string {
  // Key bisnis (AGENTS.md §5.1) — bukan Request-Id. Field final dikonfirmasi DOKU (§13).
  return `${payload.invoiceNumber}:${payload.amount}`;
}
