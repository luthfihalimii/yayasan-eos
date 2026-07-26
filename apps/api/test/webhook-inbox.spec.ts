import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { WebhookInboxService } from '../src/modules/payment/webhook-inbox.service';
import { computeDokuSignature, DokuHeaders } from '../src/modules/payment/doku-signature';
import { appClient, migratorClient, truncateAll } from './helpers';

const SECRET = 'test-secret';
const TARGET = '/webhooks/doku/qris';

let app: PrismaClient;
let mig: PrismaClient;

beforeAll(() => {
  app = appClient();
  mig = migratorClient();
});
afterAll(async () => {
  await app.$disconnect();
  await mig.$disconnect();
});
beforeEach(async () => {
  await truncateAll(mig);
});

function signedHeaders(rawBody: string, overrides?: Partial<DokuHeaders>): DokuHeaders {
  const base = {
    clientId: 'client-1',
    requestId: `req-${Math.random()}`,
    requestTimestamp: new Date().toISOString(),
  };
  return {
    ...base,
    signature: computeDokuSignature(SECRET, base, TARGET, rawBody),
    ...overrides,
  };
}

function makeService(opts?: { failTimes?: number }) {
  let failures = opts?.failTimes ?? 0;
  const processed: string[] = [];
  const svc = new WebhookInboxService(app, SECRET, async (inbox) => {
    if (failures > 0) {
      failures--;
      throw new Error('processor down');
    }
    processed.push(inbox.businessKey);
    return '00000000-0000-7000-8000-000000000001'; // journalId dummy — jalur ledger diuji di ledger.spec
  });
  return { svc, processed };
}

describe('WebhookInboxService (AGENTS.md §5.1, §11)', () => {
  it('signature invalid → 401, TIDAK ada baris inbox', async () => {
    const { svc } = makeService();
    const body = JSON.stringify({ invoice: 'INV-1', amount: 50000 });
    const res = await svc.receive('DOKU_QRIS', signedHeaders(body, { signature: 'HMACSHA256=palsu' }), TARGET, body, 'INV-1:50000');
    expect(res).toMatchObject({ httpStatus: 401, outcome: 'REJECTED_SIGNATURE' });
    expect(await mig.webhookInbox.count()).toBe(0);
  });

  it('timestamp stale → 401 (anti replay)', async () => {
    const { svc } = makeService();
    const body = JSON.stringify({ invoice: 'INV-2' });
    const old = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const h = { clientId: 'client-1', requestId: 'r1', requestTimestamp: old };
    const headers = { ...h, signature: computeDokuSignature(SECRET, h, TARGET, body) };
    const res = await svc.receive('DOKU_QRIS', headers, TARGET, body, 'INV-2:x');
    expect(res.httpStatus).toBe(401);
  });

  it('signature sah untuk target lain (replay lintas endpoint) → 401', async () => {
    const { svc } = makeService();
    const body = JSON.stringify({ invoice: 'INV-3' });
    const headers = signedHeaders(body); // ditandatangani untuk TARGET (qris)
    const res = await svc.receive('DOKU_VA', headers, '/webhooks/doku/va', body, 'INV-3:x');
    expect(res.httpStatus).toBe(401); // Request-Target ikut HMAC
  });

  it('happy path → 200 PROCESSED; duplikat setelah PROCESSED → 200 DUPLICATE, prosesor tidak jalan lagi', async () => {
    const { svc, processed } = makeService();
    const body = JSON.stringify({ invoice: 'INV-4', amount: 10000 });
    const key = 'INV-4:10000';
    const r1 = await svc.receive('DOKU_QRIS', signedHeaders(body), TARGET, body, key);
    expect(r1).toMatchObject({ httpStatus: 200, outcome: 'PROCESSED' });
    // Retry DOKU — Request-Id BARU, body sama → dedup via business key.
    const r2 = await svc.receive('DOKU_QRIS', signedHeaders(body), TARGET, body, key);
    expect(r2).toMatchObject({ httpStatus: 200, outcome: 'DUPLICATE' });
    expect(processed).toHaveLength(1);
    expect(await mig.webhookInbox.count()).toBe(1);
  });

  it('crash setelah insert, sebelum journal → retry DOKU memproses ulang (bukan 200 kosong)', async () => {
    const { svc, processed } = makeService({ failTimes: 1 });
    const body = JSON.stringify({ invoice: 'INV-5', amount: 7000 });
    const key = 'INV-5:7000';
    const r1 = await svc.receive('DOKU_QRIS', signedHeaders(body), TARGET, body, key);
    expect(r1).toMatchObject({ httpStatus: 500, outcome: 'FAILED' }); // DOKU akan retry
    const r2 = await svc.receive('DOKU_QRIS', signedHeaders(body), TARGET, body, key);
    expect(r2).toMatchObject({ httpStatus: 200, outcome: 'PROCESSED' }); // baris lama diproses ulang
    expect(processed).toEqual([key]);
    const row = await mig.webhookInbox.findFirstOrThrow();
    expect(row.status).toBe('PROCESSED');
  });

  it('reprocessStale menyapu baris FAILED menua', async () => {
    const { svc, processed } = makeService({ failTimes: 1 });
    const body = JSON.stringify({ invoice: 'INV-6', amount: 1 });
    await svc.receive('DOKU_QRIS', signedHeaders(body), TARGET, body, 'INV-6:1');
    expect(processed).toHaveLength(0);
    // Tuakan barisnya supaya kena cutoff.
    await mig.$executeRaw`SELECT set_config('app.current_unit_id', '__ALL__', false)`;
    await mig.$executeRaw`UPDATE "WebhookInbox" SET "receivedAt" = now() - interval '1 hour'`;
    const n = await svc.reprocessStale(60_000);
    expect(n).toBe(1);
    expect(processed).toHaveLength(1);
  });
});
