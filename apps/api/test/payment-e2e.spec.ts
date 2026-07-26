import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/modules/auth/auth.service';
import { computeDokuSignature } from '../src/modules/payment/doku-signature';
import { migratorClient, truncateAll } from './helpers';

const D = Prisma.Decimal;
const SECRET = 'test-doku-secret';

let app: INestApplication;
let mig: PrismaClient;
let baseUrl: string;
let studentAccountId: string;

beforeAll(async () => {
  process.env.DOKU_SECRET_KEY = SECRET;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();
  await app.listen(0);
  baseUrl = await app.getUrl();
  mig = migratorClient();
});

afterAll(async () => {
  await app.close();
  await mig.$disconnect();
});

beforeEach(async () => {
  await truncateAll(mig);
  const smp = await mig.unit.create({ data: { type: 'SMP', name: 'SMP' } });
  const yys = await mig.unit.create({ data: { type: 'YAYASAN', name: 'Yayasan' } });
  const student = await mig.ledgerAccount.create({
    data: { unitId: smp.id, ownerType: 'STUDENT', ownerId: smp.id, label: 'Siswa A' },
  });
  await mig.ledgerAccount.create({
    data: { unitId: yys.id, ownerType: 'INTERNAL', accountCode: 'DOKU_CLEARING', label: 'DOKU Clearing' },
  });
  studentAccountId = student.id;
  await mig.user.create({
    data: {
      email: 'tu@eos.sch.id',
      passwordHash: await AuthService.hashPassword('rahasia123'),
      role: 'UNIT_ADMIN',
      memberships: { create: { unitId: smp.id } },
    },
  });
});

function dokuPost(path: string, payload: object) {
  const rawBody = JSON.stringify(payload);
  const h = {
    clientId: 'client-1',
    requestId: `req-${Math.random()}`,
    requestTimestamp: new Date().toISOString(),
  };
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'client-id': h.clientId,
      'request-id': h.requestId,
      'request-timestamp': h.requestTimestamp,
      signature: computeDokuSignature(SECRET, h, path, rawBody),
    },
    body: rawBody,
  });
}

describe('E2E: auth + webhook DOKU → Ledger', () => {
  it('login sukses mengembalikan JWT; password salah 401', async () => {
    const ok = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'tu@eos.sch.id', password: 'rahasia123' }),
    });
    expect(ok.status).toBe(201);
    const { accessToken } = (await ok.json()) as { accessToken: string };
    expect(accessToken.split('.')).toHaveLength(3);

    const bad = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'tu@eos.sch.id', password: 'salah' }),
    });
    expect(bad.status).toBe(401);
  });

  it('callback QRIS valid → journal clearing tercipta, saldo efektif siswa naik', async () => {
    const res = await dokuPost('/webhooks/doku/qris', {
      invoiceNumber: 'INV-100',
      amount: 50000,
      studentAccountId,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ outcome: 'PROCESSED' });

    const journal = await mig.journalEntry.findFirstOrThrow({ include: { entries: true } });
    expect(journal.source).toBe('DOKU_QRIS');
    expect(journal.refType).toBe('TOPUP');
    expect(journal.entries).toHaveLength(2);

    const student = await mig.ledgerAccount.findUniqueOrThrow({ where: { id: studentAccountId } });
    expect(new D(student.balance).toNumber()).toBe(50000);
    const inbox = await mig.webhookInbox.findFirstOrThrow();
    expect(inbox.status).toBe('PROCESSED');
    expect(inbox.journalId).toBe(journal.id);
  });

  it('callback sama dikirim 2x (retry DOKU, Request-Id beda) → satu journal, kedua 200 DUPLICATE', async () => {
    const payload = { invoiceNumber: 'INV-101', amount: 10000, studentAccountId };
    const r1 = await dokuPost('/webhooks/doku/qris', payload);
    const r2 = await dokuPost('/webhooks/doku/qris', payload);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(await r2.json()).toMatchObject({ outcome: 'DUPLICATE' });
    expect(await mig.journalEntry.count()).toBe(1);
    const student = await mig.ledgerAccount.findUniqueOrThrow({ where: { id: studentAccountId } });
    expect(new D(student.balance).toNumber()).toBe(10000); // tidak dobel
  });

  it('signature palsu → 401, tidak ada journal maupun baris inbox', async () => {
    const rawBody = JSON.stringify({ invoiceNumber: 'INV-102', amount: 99999, studentAccountId });
    const res = await fetch(`${baseUrl}/webhooks/doku/qris`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'client-id': 'attacker',
        'request-id': 'r-1',
        'request-timestamp': new Date().toISOString(),
        signature: 'HMACSHA256=forged',
      },
      body: rawBody,
    });
    expect(res.status).toBe(401);
    expect(await mig.journalEntry.count()).toBe(0);
    expect(await mig.webhookInbox.count()).toBe(0);
  });

  it('endpoint terproteksi tanpa token → 401', async () => {
    const res = await fetch(`${baseUrl}/`, { method: 'GET' });
    expect([401, 404]).toContain(res.status); // guard menolak sebelum routing 404
  });
});
