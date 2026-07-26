import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { authenticator } from 'otplib';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/modules/auth/auth.service';
import { MailerService } from '../src/core/mailer.service';
import { migratorClient, truncateAll } from './helpers';

let app: INestApplication;
let mig: PrismaClient;
let baseUrl: string;
const sentMails: { to: string; text: string }[] = [];

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY = 'test-encryption-key-32-characters';
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(MailerService)
    .useValue({
      send: async (to: string, _subject: string, text: string) => {
        sentMails.push({ to, text });
      },
    })
    .compile();
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
  await mig.passwordResetToken.deleteMany();
  sentMails.length = 0;
  const unit = await mig.unit.create({ data: { type: 'SMP', name: 'SMP' } });
  await mig.user.create({
    data: {
      email: 'bendahara@trigunabhakti.or.id',
      passwordHash: await AuthService.hashPassword('password-lama-123'),
      role: 'STAFF',
      memberships: { create: { unitId: unit.id } },
    },
  });
});

const post = (path: string, body: object) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function loginToken(email: string, password: string, totpCode?: string): Promise<string> {
  const res = await post('/auth/login', { email, password, totpCode });
  const { accessToken } = (await res.json()) as { accessToken: string };
  return accessToken;
}

describe('E2E: reset password + TOTP', () => {
  it('alur reset lengkap: minta → email berisi token → reset → login password baru; token single-use', async () => {
    const r1 = await post('/auth/forgot-password', { email: 'bendahara@trigunabhakti.or.id' });
    expect(r1.status).toBe(201);
    expect(sentMails).toHaveLength(1);
    const token = sentMails[0].text.match(/token=([A-Za-z0-9_-]+)/)![1];

    // Token mentah TIDAK tersimpan di DB — hanya hash.
    const row = await mig.passwordResetToken.findFirstOrThrow();
    expect(row.tokenHash).not.toBe(token);

    const r2 = await post('/auth/reset-password', { token, newPassword: 'password-baru-456' });
    expect(r2.status).toBe(201);

    // Password lama mati, baru hidup.
    expect((await post('/auth/login', { email: 'bendahara@trigunabhakti.or.id', password: 'password-lama-123' })).status).toBe(401);
    expect((await post('/auth/login', { email: 'bendahara@trigunabhakti.or.id', password: 'password-baru-456' })).status).toBe(201);

    // Replay token → ditolak.
    const r3 = await post('/auth/reset-password', { token, newPassword: 'password-lain-789' });
    expect(r3.status).toBe(400);
  });

  it('email tidak terdaftar: 201 identik, TIDAK ada email terkirim', async () => {
    const res = await post('/auth/forgot-password', { email: 'hantu@trigunabhakti.or.id' });
    expect(res.status).toBe(201);
    expect(sentMails).toHaveLength(0);
  });

  it('password baru < 12 karakter ditolak', async () => {
    const res = await post('/auth/reset-password', { token: 'x'.repeat(32), newPassword: 'pendek' });
    expect(res.status).toBe(400);
  });

  it('TOTP: setup → enable → login tanpa kode 401 mfaRequired → login dengan kode sukses', async () => {
    const jwt = await loginToken('bendahara@trigunabhakti.or.id', 'password-lama-123');
    const auth = { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' };

    const setup = await fetch(`${baseUrl}/auth/totp/setup`, { method: 'POST', headers: auth });
    expect(setup.status).toBe(201);
    const { secret, otpauthUrl } = (await setup.json()) as { secret: string; otpauthUrl: string };
    expect(otpauthUrl).toContain('Yayasan%20EOS');

    // Secret di DB terenkripsi — bukan plaintext.
    const user = await mig.user.findUniqueOrThrow({ where: { email: 'bendahara@trigunabhakti.or.id' } });
    expect(user.totpSecretEnc).not.toContain(secret);
    expect(user.totpEnabledAt).toBeNull(); // belum aktif sebelum verifikasi

    const enable = await fetch(`${baseUrl}/auth/totp/enable`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ code: authenticator.generate(secret) }),
    });
    expect(enable.status).toBe(201);

    // Login lama (tanpa kode) → 401 + mfaRequired.
    const noCode = await post('/auth/login', { email: 'bendahara@trigunabhakti.or.id', password: 'password-lama-123' });
    expect(noCode.status).toBe(401);
    expect(await noCode.json()).toMatchObject({ mfaRequired: true });

    // Dengan kode valid → sukses.
    const withCode = await post('/auth/login', {
      email: 'bendahara@trigunabhakti.or.id',
      password: 'password-lama-123',
      totpCode: authenticator.generate(secret),
    });
    expect(withCode.status).toBe(201);
  });

  it('rate limit login: request ke-6 dalam semenit → 429', async () => {
    // skipIf throttler dievaluasi per-request — nyalakan hanya untuk test ini
    // (test lain login berulang lintas kasus; throttle aktif = false positive).
    process.env.THROTTLE_TEST = '1';
    try {
      for (let i = 0; i < 5; i++) {
        await post('/auth/login', { email: 'bendahara@trigunabhakti.or.id', password: 'salah' });
      }
      const sixth = await post('/auth/login', { email: 'bendahara@trigunabhakti.or.id', password: 'salah' });
      expect(sixth.status).toBe(429);
    } finally {
      delete process.env.THROTTLE_TEST;
    }
  });
});
