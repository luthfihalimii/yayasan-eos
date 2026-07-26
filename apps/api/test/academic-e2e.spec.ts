import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/modules/auth/auth.service';
import { migratorClient, truncateAll } from './helpers';

let app: INestApplication;
let mig: PrismaClient;
let baseUrl: string;
let unitA: string;
let unitB: string;
let tokenTuA: string; // TU unit A
let tokenTeacher: string; // TEACHER unit A — role tidak diizinkan di /academic

async function login(email: string): Promise<string> {
  const res = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'rahasia123' }),
  });
  const { accessToken } = (await res.json()) as { accessToken: string };
  return accessToken;
}

function api(token: string, unit: string | undefined, path: string, init?: RequestInit) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      ...(unit ? { 'x-active-unit': unit } : {}),
      ...(init?.headers ?? {}),
    },
  });
}

beforeAll(async () => {
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
  const a = await mig.unit.create({ data: { type: 'SD', name: 'SD' } });
  const b = await mig.unit.create({ data: { type: 'SMP', name: 'SMP' } });
  unitA = a.id;
  unitB = b.id;
  const hash = await AuthService.hashPassword('rahasia123');
  await mig.user.create({
    data: { email: 'tua@trigunabhakti.or.id', passwordHash: hash, role: 'UNIT_ADMIN', memberships: { create: { unitId: unitA } } },
  });
  await mig.user.create({
    data: { email: 'guru@trigunabhakti.or.id', passwordHash: hash, role: 'TEACHER', memberships: { create: { unitId: unitA } } },
  });
  tokenTuA = await login('tua@trigunabhakti.or.id');
  tokenTeacher = await login('guru@trigunabhakti.or.id');
});

describe('E2E: academic master data + isolasi unit', () => {
  it('TU membuat tahun ajaran + kelas + siswa di unitnya', async () => {
    const year = await api(tokenTuA, unitA, '/academic/years', {
      method: 'POST',
      body: JSON.stringify({ label: '2026/2027', startsOn: '2026-07-13', endsOn: '2027-06-19' }),
    });
    expect(year.status).toBe(201);
    const { id: yearId } = (await year.json()) as { id: string };

    const cls = await api(tokenTuA, unitA, '/academic/classrooms', {
      method: 'POST',
      body: JSON.stringify({ academicYearId: yearId, grade: 1, name: '1A' }),
    });
    expect(cls.status).toBe(201);
    const { id: classId } = (await cls.json()) as { id: string };

    const student = await api(tokenTuA, unitA, '/academic/students', {
      method: 'POST',
      body: JSON.stringify({ nis: '2026-001', fullName: 'Budi', classroomId: classId }),
    });
    expect(student.status).toBe(201);

    const list = await api(tokenTuA, unitA, '/academic/students');
    expect(((await list.json()) as unknown[]).length).toBe(1);
  });

  it('x-active-unit di luar membership → 403 (TU A tidak bisa menyamar jadi unit B)', async () => {
    const res = await api(tokenTuA, unitB, '/academic/years');
    expect(res.status).toBe(403);
  });

  it('data unit B tidak terlihat dari context unit A (RLS end-to-end)', async () => {
    await mig.$executeRaw`SELECT set_config('app.current_unit_id', '__ALL__', false)`;
    await mig.academicYear.create({
      data: { unitId: unitB, label: '2026/2027', startsOn: new Date('2026-07-13'), endsOn: new Date('2027-06-19') },
    });
    const res = await api(tokenTuA, unitA, '/academic/years');
    expect((await res.json()) as unknown[]).toHaveLength(0);
  });

  it('role TEACHER ditolak di endpoint master data → 403', async () => {
    const res = await api(tokenTeacher, unitA, '/academic/years');
    expect(res.status).toBe(403);
  });

  it('duplikat NIS di unit sama → 409; validasi zod → 400', async () => {
    const mk = () =>
      api(tokenTuA, unitA, '/academic/students', {
        method: 'POST',
        body: JSON.stringify({ nis: 'X-1', fullName: 'Ani' }),
      });
    expect((await mk()).status).toBe(201);
    expect((await mk()).status).toBe(409);

    const bad = await api(tokenTuA, unitA, '/academic/years', {
      method: 'POST',
      body: JSON.stringify({ label: 'bukan-format', startsOn: 'x', endsOn: 'y' }),
    });
    expect(bad.status).toBe(400);
  });

  it('aktivasi tahun ajaran: hanya satu aktif per unit', async () => {
    const mkYear = (label: string) =>
      api(tokenTuA, unitA, '/academic/years', {
        method: 'POST',
        body: JSON.stringify({ label, startsOn: '2026-07-13', endsOn: '2027-06-19' }),
      }).then(async (r) => ((await r.json()) as { id: string }).id);
    const y1 = await mkYear('2025/2026');
    const y2 = await mkYear('2026/2027');
    await api(tokenTuA, unitA, `/academic/years/${y1}/activate`, { method: 'POST' });
    await api(tokenTuA, unitA, `/academic/years/${y2}/activate`, { method: 'POST' });
    const years = (await (await api(tokenTuA, unitA, '/academic/years')).json()) as { id: string; isActive: boolean }[];
    expect(years.filter((y) => y.isActive)).toHaveLength(1);
    expect(years.find((y) => y.id === y2)?.isActive).toBe(true);
  });
});
