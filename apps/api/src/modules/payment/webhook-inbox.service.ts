import { JournalSource, Prisma, PrismaClient, WebhookInbox } from '@prisma/client';
import { DokuHeaders, verifyDokuSignature } from './doku-signature';

export type WebhookChannel = Extract<JournalSource, 'DOKU_VA' | 'DOKU_QRIS'>;

export interface WebhookResult {
  /** HTTP status yang harus dijawab ke DOKU. Non-2xx = DOKU retry. */
  httpStatus: 200 | 401 | 500;
  outcome: 'PROCESSED' | 'DUPLICATE' | 'REJECTED_SIGNATURE' | 'FAILED';
  inboxId?: string;
}

/** Prosesor journal di belakang inbox — LedgerService.postJournal via adapter per channel. */
export type InboxProcessor = (inbox: WebhookInbox) => Promise<string /* journalId */>;

/**
 * AGENTS.md §5.1 — autentikasi DULU, idempotency KEDUA, dan crash-recovery:
 * - insert-first inbox ber-key bisnis (BUKAN Request-Id — bisa berganti per retry)
 * - duplikat PROCESSED → 200; duplikat RECEIVED/FAILED (crash setelah insert,
 *   sebelum journal) → proses ulang SEKARANG, bukan 200 kosong
 * - reprocessStale() = re-processor internal yang menyapu baris menua
 */
export class WebhookInboxService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly secretKey: string,
    private readonly processor: InboxProcessor,
  ) {}

  async receive(
    channel: WebhookChannel,
    headers: DokuHeaders,
    requestTarget: string,
    rawBody: string,
    businessKey: string,
  ): Promise<WebhookResult> {
    // 1) Signature — sebelum menyentuh apapun. Forgery ber-key asli mati di sini,
    //    tidak sempat "menduduki" slot dedup milik callback sah.
    const sig = verifyDokuSignature(this.secretKey, headers, requestTarget, rawBody);
    if (!sig.ok) return { httpStatus: 401, outcome: 'REJECTED_SIGNATURE' };

    // 2) Insert-first. Unique violation = sudah pernah diterima.
    let inbox: WebhookInbox;
    try {
      inbox = await this.prisma.webhookInbox.create({
        data: {
          channel,
          businessKey,
          rawPayload: JSON.parse(rawBody) as Prisma.InputJsonValue,
          signature: headers.signature,
        },
      });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const existing = await this.prisma.webhookInbox.findUniqueOrThrow({
          where: { channel_businessKey: { channel, businessKey } },
        });
        if (existing.status === 'PROCESSED') {
          return { httpStatus: 200, outcome: 'DUPLICATE', inboxId: existing.id };
        }
        // Crash sebelumnya: baris ada, journal belum — proses ulang sekarang.
        return this.process(existing);
      }
      throw e;
    }

    return this.process(inbox);
  }

  private async process(inbox: WebhookInbox): Promise<WebhookResult> {
    try {
      const journalId = await this.processor(inbox);
      await this.prisma.webhookInbox.update({
        where: { id: inbox.id },
        data: { status: 'PROCESSED', journalId, processedAt: new Date() },
      });
      return { httpStatus: 200, outcome: 'PROCESSED', inboxId: inbox.id };
    } catch {
      // 500 → DOKU retry; baris tinggal RECEIVED/FAILED, re-processor menyapu.
      await this.prisma.webhookInbox
        .update({ where: { id: inbox.id }, data: { status: 'FAILED' } })
        .catch(() => undefined);
      return { httpStatus: 500, outcome: 'FAILED', inboxId: inbox.id };
    }
  }

  /** Re-processor (BullMQ repeat job nantinya): sapu RECEIVED/FAILED menua. */
  async reprocessStale(olderThanMs: number, limit = 50): Promise<number> {
    const cutoff = new Date(Date.now() - olderThanMs);
    const stale = await this.prisma.webhookInbox.findMany({
      where: { status: { in: ['RECEIVED', 'FAILED'] }, receivedAt: { lt: cutoff } },
      orderBy: { receivedAt: 'asc' },
      take: limit,
    });
    let ok = 0;
    for (const row of stale) {
      const res = await this.process(row);
      if (res.outcome === 'PROCESSED') ok++;
    }
    return ok;
  }
}
