import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

// Seed idempoten (upsert semua) — aman dijalankan berulang.
// Jalan sebagai MIGRATOR (owner) tapi RLS FORCE tetap berlaku → sentinel session-scope.
// Kredensial admin awal dari env; JANGAN hardcode di file (PRD §5.1).

const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 19 * 1024, timeCost: 2, parallelism: 1 };

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.MIGRATOR_DATABASE_URL } },
});

async function main() {
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? 'admin@eos.local';
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  if (!adminPassword || adminPassword.length < 12) {
    throw new Error('SEED_ADMIN_PASSWORD wajib di-set (>= 12 karakter) — tidak ada default.');
  }

  await prisma.$executeRaw`SELECT set_config('app.current_unit_id', '__ALL__', false)`;

  // 1) Units — YAYASAN dulu (akun clearing hidup di sana), lalu jenjang.
  const unitDefs = [
    { type: 'YAYASAN', name: 'Yayasan EOS' },
    { type: 'SD', name: 'SD EOS' },
    { type: 'SMP', name: 'SMP EOS' },
    { type: 'SMA', name: 'SMA EOS' },
  ] as const;

  const units: Record<string, string> = {};
  for (const def of unitDefs) {
    const existing = await prisma.unit.findFirst({ where: { type: def.type } });
    const unit = existing ?? (await prisma.unit.create({ data: def }));
    units[def.type] = unit.id;
  }

  // 2) Akun internal level yayasan (AGENTS §5.1) — identitas = accountCode.
  const accountDefs = [
    { accountCode: 'DOKU_CLEARING', label: 'DOKU Clearing/Receivable' },
    { accountCode: 'BANK_YAYASAN', label: 'Bank Yayasan' },
    { accountCode: 'FEE_PG', label: 'Beban Fee Payment Gateway' },
  ];
  for (const def of accountDefs) {
    const existing = await prisma.ledgerAccount.findFirst({
      where: { unitId: units.YAYASAN, ownerType: 'INTERNAL', accountCode: def.accountCode },
    });
    if (!existing) {
      await prisma.ledgerAccount.create({
        data: { unitId: units.YAYASAN, ownerType: 'INTERNAL', ...def },
      });
    }
  }

  // 3) Yayasan Admin awal — membership ke SEMUA unit (endpoint biasa tetap
  //    butuh active unit ∈ membership; cross-unit hanya via @CrossUnit).
  const passwordHash = await argon2.hash(adminPassword, ARGON2_OPTIONS);
  const admin = await prisma.user.upsert({
    where: { email: adminEmail },
    update: {}, // idempoten — tidak reset password admin yang sudah ada
    create: { email: adminEmail, passwordHash, role: 'YAYASAN_ADMIN' },
  });
  for (const unitId of Object.values(units)) {
    await prisma.unitMembership.upsert({
      where: { userId_unitId: { userId: admin.id, unitId } },
      update: {},
      create: { userId: admin.id, unitId },
    });
  }

  console.log(`Seed OK — units: ${Object.keys(units).join(', ')}; admin: ${adminEmail}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
