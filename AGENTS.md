# AGENTS.md — Yayasan Education Operating System (Yayasan EOS)

Dokumen ini adalah panduan kerja untuk AI coding agent (Claude Code, dsb.) yang mengerjakan repository ini. Isinya adalah rangkuman keputusan arsitektur dari PRD v1.0–v1.5 yang sudah difinalisasi — bukan pengganti PRD, tapi versi actionable-nya untuk keperluan implementasi sehari-hari. Kalau ada ketidakcocokan antara file ini dan PRD, PRD (`PRD.md` v1.5) yang jadi rujukan utama untuk requirement bisnis; file ini yang jadi rujukan utama untuk konvensi kode.

## Daftar Isi
1. [Ringkasan Proyek](#1-ringkasan-proyek)
2. [Tech Stack](#2-tech-stack)
3. [Struktur Repository](#3-struktur-repository-target)
4. [Prinsip Arsitektur Inti](#4-prinsip-arsitektur-inti)
   - 4.1 Isolasi Multi-Unit — Defense in Depth
   - 4.2 Request Context & Unit Scoping
   - 4.3 Modular Monolith + Event Contract + Outbox
   - 4.4 Partitioning — Dikoreksi
   - 4.5 Naming Convention & Code Style
   - 4.6 Logging & Monitoring
   - 4.7 Environment & Configuration
   - 4.8 Versioning & Migration
5. [Core Shared Services](#5-core-shared-services-modul-0--bangun-sekali-di-phase-1)
6. [Peta Modul](#6-peta-modul-ringkas--detail-lengkap-ada-di-prd-4-fase-mengikuti-roadmap-v15-prd-6)
7. [Non-Negotiable Rules](#7-non-negotiable-rules--jangan-dilanggar-tanpa-diskusi-ulang)
8. [Keamanan & RBAC](#8-keamanan--rbac)
9. [Reliability — UI Lapangan](#9-reliability--ui-lapangan)
10. [Backup & Retention](#10-backup--retention)
11. [Testing — Prioritas Coverage](#11-testing--prioritas-coverage)
12. [Rollout](#12-rollout)
13. [Belum Diputuskan](#13-belum-diputuskan-jangan-diasumsikan-agent)

---

## 1. Ringkasan Proyek
Yayasan EOS adalah **private internal system** (bukan multi-tenant SaaS untuk banyak organisasi) untuk satu Yayasan yang menaungi beberapa unit pendidikan (SD/SMP/SMA) dalam satu database, dipisah lewat `unitId`. Modul mencakup akademik, keuangan, perpustakaan, kantin, UKS/BK, HRIS, PPDB, dan parent monitoring.

## 2. Tech Stack
| Layer | Teknologi |
|---|---|
| Backend | NestJS (Modular Monolith), Socket.io untuk realtime |
| Database | PostgreSQL |
| ORM | Prisma ORM (**Client Extensions**, bukan Middleware) |
| Cache & Queue | Redis (caching, WebSocket adapter, BullMQ) |
| Web Admin | Astro (SSR) + TailwindCSS |
| Mobile | Flutter (iOS & Android), Riverpod/Bloc — target siswa & orang tua saja |
| Payment | DOKU (VA & QRIS/E-Wallet) — callback WAJIB verifikasi signature (§5.1) |
| Password Hash | Argon2id (m=19 MiB, t=2, p=1 minimum — OWASP), BUKAN bcrypt |
| Storage | AWS S3 / Cloudinary — bucket private + presigned URL untuk foto siswa |
| Push Notification | FCM |

## 3. Struktur Repository (target)
```
/apps
  /api        -> NestJS backend (modular monolith)
  /web        -> Astro admin dashboard (Yayasan/TU/Guru/Staf)
  /mobile     -> Flutter app (Siswa & Orang Tua)
/packages
  /shared-types -> tipe/DTO yang dipakai bareng API & web (kalau ada codegen dari Prisma)
prisma/
  schema.prisma
  migrations/
AGENTS.md      -> file ini
PRD.md         -> source of truth requirement bisnis (v1.5)
```

Setiap modul di `/apps/api/src/modules/*` sebaiknya self-contained (controller, service, repository, dto, events, tests). Komunikasi lintas modul dibedakan berdasarkan jenis operasi — **write/side-effect lewat event contract + outbox, read/query sinkron boleh lewat import service langsung, debit finansial point-of-sale sinkron via service Ledger** (lihat §4.3 untuk detail dan alasannya).

---

## 4. Prinsip Arsitektur Inti

### 4.1 Isolasi Multi-Unit — Defense in Depth (2 lapis, wajib keduanya)
1. **Prisma Client Extensions** (`$extends`) — setiap query ke model yang punya `unitId` di-scope otomatis di level aplikasi.
2. **PostgreSQL Row-Level Security (RLS)** — lapisan kedua di level database, supaya bug di lapisan aplikasi tidak otomatis berarti kebocoran data lintas unit.

```typescript
// Pola dasar Client Extensions (bukan Prisma Middleware — deprecated v4.16, dihapus v6.14)
export const withUnitScope = (unitId: string) =>
  Prisma.defineExtension((client) =>
    client.$extends({
      query: {
        $allModels: {
          async $allOperations({ args, operation, query, model }) {
            if (!MODELS_WITH_UNIT_ID.has(model)) return query(args);
            // Lihat caveat per-operasi di bawah — spread args.where saja TIDAK cukup.
            return query(scopeArgs(operation, args, unitId));
          },
        },
      },
    }),
  );
```

**Caveat wajib — spread `args.where` saja bocor untuk banyak operasi.** `scopeArgs` harus menangani per kelompok operasi:
- `findMany`/`findFirst`/`count`/`aggregate`/`updateMany`/`deleteMany`: merge `where` di top-level **aman** (Prisma meng-AND top-level keys, jadi `{ OR: [...], unitId }` tetap ter-scope benar).
- `create`/`createMany`: **tidak punya `where`** — `unitId` wajib diinjeksi/divalidasi di `args.data`. Tanpa ini, lapisan aplikasi mengizinkan insert lintas unit.
- `upsert`: tangani `where` DAN `create`/`update` sekaligus.
- `findUnique`/`findUniqueOrThrow`/`update`/`delete`/`upsert`: sejak Prisma 5.0 (`extendedWhereUnique` GA), whereUnique **boleh** berisi field non-unique tambahan — `scopeArgs` cukup inject `unitId` langsung ke `where`. Jangan pakai workaround lama (rewrite ke `findFirst` mengubah semantik error P2025; fetch-lalu-validasi = TOCTOU di path update/delete).
- **Nested write** (`connect`, nested `create` di `data`) dan **relation traversal** (`include`/`select`): tidak tersentuh top-level `where` — `connect: { id }` bisa attach record unit lain. Jangan andalkan extension untuk ini; RLS adalah jaring penangkapnya, dan justru karena itu RLS harus benar-benar hidup (§4.2).
- `$queryRaw`/`$executeRaw`: **bypass query extensions sepenuhnya** — RLS satu-satunya pengaman.
- Model tanpa `unitId` (join table murni) = lubang traversal; minimalkan, dan pastikan RLS di tabel tujuannya.

Detail bagaimana `unitId` didapat dan disalurkan sampai ke RLS policy — lihat §4.2.

### 4.2 Request Context & Unit Scoping
Unit context **wajib dinamis per-request**, diturunkan dari JWT claim/session — **bukan** environment variable statis (satu deployment API melayani SD+SMP+SMA sekaligus).

**Model membership (dikoreksi v1.5 — konsisten dengan role many-to-many):**
Guru bisa mengajar di banyak unit (§7.8) dan satu akun Orang Tua memantau anak lintas unit — satu klaim `unitId` skalar di JWT tidak bisa merepresentasikan keduanya. Desain:
- **JWT membawa `unitMemberships: string[]`** (+ role), bukan satu `unitId`.
- Setiap request mendeklarasikan **satu active unit** (header/param) — guard memvalidasi active unit ∈ memberships, lalu nilai tervalidasi itu yang masuk context. Siswa/TU/Staff punya memberships berisi satu unit; efeknya sama seperti dulu.
- **Orang Tua:** endpoint parent me-resolve unit dari anak yang sedang diakses — guard memverifikasi relasi orang tua–anak dulu, baru set context ke unit si anak.
- **Cross-unit (`@CrossUnit()`):** context di-set `null` (cross-unit) hanya pada **endpoint konsolidasi** ber-decorator `@CrossUnit()` eksplisit — untuk **Yayasan Admin** (BI, laporan gabungan) dan **Bendahara** (payroll & rekonsiliasi keuangan lintas unit — payroll konsolidasi adalah fungsi bendahara, PRD Modul 5; itu juga alasan MFA wajib untuk keduanya). Di endpoint biasa, kedua role tetap scoped ke active unit seperti role lain. Guard menentukan per-route, **bukan** blanket `role === 'YAYASAN_ADMIN' ? null : ...` di semua request.

```typescript
// Context storage — per-request via AsyncLocalStorage, bukan environment variable
export const currentUnitContext = new AsyncLocalStorage<string | null>();
// null      = cross-unit (HANYA Yayasan Admin/Bendahara di endpoint ber-@CrossUnit(),
//             diverifikasi guard; di bridge SQL diterjemahkan jadi sentinel '__ALL__')
// string    = active unitId tervalidasi terhadap membership
// undefined = getStore() dipanggil di luar .run() → context belum pernah
//             di-set sama sekali. Ini BUG (guard lupa dipasang, atau
//             background job query langsung tanpa set context sendiri),
//             BUKAN kondisi yang sama dengan null.
```

**Background job (BullMQ worker) tidak punya request lifecycle** — worker wajib memanggil `currentUnitContext.run(unitIdDariPayload, ...)` sendiri di awal pemrosesan job. Payload event karenanya wajib membawa `unitId` (§4.3). Worker yang lupa = kena fail-closed di bawah, dan itu memang disengaja.

**Bridge ke PostgreSQL** — empat hal berikut wajib bareng; tiga pertama pernah jadi bug produksi di sistem serupa, yang keempat membuat seluruh lapisan RLS hidup:

```typescript
const store = currentUnitContext.getStore();

// 1) Fail-closed untuk context yang hilang. undefined ≠ null — jangan
//    disamakan. Context yang hilang karena bug harus DITOLAK, bukan
//    otomatis kebuka jadi akses lintas unit.
if (store === undefined) {
  throw new Error('Unit context belum pernah di-set — request ditolak');
}

await prisma.$transaction(async (tx) => {
  // 2) Pakai set_config(), BUKAN "SET LOCAL app.x = ${value}" — value
  //    placeholder di statement SET tidak reliably ter-parameterize
  //    lewat sebagian besar driver/ORM termasuk Prisma $executeRaw.
  //    set_config() aman menerima parameter; argumen ketiga `true` =
  //    scope LOCAL (per-transaction, wajib untuk PgBouncer transaction mode).
  //    Cross-unit = sentinel eksplisit '__ALL__' (HANYA di-set guard
  //    @CrossUnit atau system worker finansial) — BUKAN string kosong,
  //    BUKAN skip set_config. Lihat desain fail-closed di policy.
  await tx.$executeRaw`SELECT set_config('app.current_unit_id', ${store ?? '__ALL__'}, true)`;
  return /* query lanjutan di transaction yang sama */;
});
// Isolation level: default Read Committed. JANGAN Serializable global —
// mutasi Ledger pakai row lock urutan deterministik (§5.1), Serializable
// menambah abort 40001 yang tidak ada strategi retry-nya.
```

```sql
-- 3) Policy FAIL-CLOSED. Tiga kondisi GUC dan perlakuannya:
--    * GUC = '<unitId>'   → hanya baris unit itu.
--    * GUC = '__ALL__'    → cross-unit (sentinel positif, hanya di-set
--                           guard @CrossUnit / system worker finansial).
--    * GUC unset (NULL) ATAU '' (sisa transaksi lama di pooled connection,
--      PgBouncer transaction mode me-reset GUC LOCAL jadi empty string)
--      → DENY SEMUA BARIS. Kedua kondisi ini artinya set_config tidak
--      jalan di transaksi ini = bug (query di luar wrapper, $queryRaw
--      lepas, worker lupa set context) — dan justru di situlah lapisan
--      RLS harus menutup, bukan membuka. JANGAN pernah menulis policy
--      dengan cabang "IS NULL → boleh semua" — itu fail-open: bug yang
--      seharusnya ditangkap RLS malah dapat akses lintas unit penuh.
--    current_setting(name, true) — missing_ok, TANPA ini GUC yang belum
--    pernah di-SET akan THROW, bukan mengembalikan NULL.
--    Policy tanpa WITH CHECK memakai ekspresi USING untuk write juga —
--    insert dengan GUC kosong ikut tertolak. Ini yang membuat klaim
--    §4.1 "RLS satu-satunya pengaman untuk raw query & nested write"
--    benar-benar berlaku.
ALTER TABLE "LedgerEntry" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "LedgerEntry" FORCE ROW LEVEL SECURITY;  -- lihat poin 4
CREATE POLICY unit_isolation ON "LedgerEntry"
  USING (
    "unitId" = current_setting('app.current_unit_id', true)
    OR current_setting('app.current_unit_id', true) = '__ALL__'
  );
-- Konsekuensi migrasi: eos_migrator kena FORCE RLS juga untuk DML.
-- Migration/backfill yang menyentuh data wajib mengawali dengan
-- SELECT set_config('app.current_unit_id', '__ALL__', false); -- session-scope
-- DDL tidak terpengaruh RLS.
```

**4) Role terpisah + FORCE RLS — tanpa ini seluruh lapisan RLS adalah no-op diam-diam.**
PostgreSQL **tidak menerapkan RLS ke table owner** kecuali tabel diberi `FORCE ROW LEVEL SECURITY`. Setup Prisma umum memakai satu `DATABASE_URL` untuk migrasi dan runtime — artinya aplikasi connect sebagai owner, semua policy dilewati, dan semua test terlihat hijau. Wajib:
- **Dua role:** `eos_migrator` (owner, menjalankan `prisma migrate deploy`) dan `eos_app` (runtime, non-owner, **bukan** superuser, **tanpa** `BYPASSRLS`). Dua `DATABASE_URL` berbeda.
- `FORCE ROW LEVEL SECURITY` tetap dipasang di semua tabel ber-RLS (sabuk pengaman kalau suatu saat ada yang connect sebagai owner).
- Test integrasi §11 wajib connect sebagai `eos_app`, set GUC unit A, assert baris unit B tidak terlihat — test yang jalan sebagai owner tidak membuktikan apa-apa.

**Penting:** keputusan "siapa boleh cross-unit" ditegakkan di kode aplikasi lewat role check + `@CrossUnit()` di guard — **bukan** diserahkan ke RLS. Dari sisi database, "GUC kosong karena admin konsolidasi" dan "GUC kosong karena bug" terlihat identik; pengecekan `undefined` di poin 1 adalah satu-satunya tempat keduanya bisa dibedakan.

### 4.3 Modular Monolith + Event Contract + Outbox
Komunikasi antar modul dibedakan berdasarkan jenis operasi:
- **Write / mutation / side-effect asinkron** (misal: Modul 3 Perpustakaan membuat denda → Modul 0 Ledger mencatat journal) — **wajib** lewat event contract, dengan **transactional outbox**:
  1. Modul sumber menulis record domain (misal denda) **dan** baris event ke tabel `OutboxEvent` **dalam satu transaksi Postgres yang sama**.
  2. Relay (worker polling / LISTEN-NOTIFY) mem-publish baris outbox ke BullMQ, menandai published.
  3. Konsumen memproses job — **wajib idempoten**, karena BullMQ at-least-once (lihat idempotency internal §5.1).

  Alasan outbox: Redis tidak ikut transaksi Postgres. Tanpa outbox, crash di antara commit domain dan enqueue = denda tercatat tapi journal tidak pernah tercipta — dan job reconciliation **tidak bisa** mendeteksi transaksi yang tidak pernah ditulis.
- **Pengecualian sinkron yang sah — debit point-of-sale:** pembayaran kantin (scan QR di kasir) butuh jawaban terima/tolak saat itu juga; alurnya validasi QR → panggil service Ledger **langsung, sinkron, satu transaksi database** (row lock §5.1). Event contract dipakai untuk efek turunannya (notifikasi, update antrian), bukan untuk debitnya sendiri.
- **Read/query sinkron** (misal: Modul 5 Finance baca saldo dari Modul 0 Ledger) — **boleh** import service/repository modul lain langsung, asal lewat interface publik modul (`exports` di NestJS module). Memaksa read lewat event cuma menambah kompleksitas dan latency.

Definisikan payload event di satu tempat (`/apps/api/src/events/contracts/*.ts`). Setiap payload event **wajib membawa `unitId`** (worker butuh untuk set context — §4.2) dan, untuk event yang menulis Ledger, **idempotency key deterministik** (§5.1).

### 4.4 Partitioning — Dikoreksi (v1.5)
Keputusan lama ("partisi `unitId` + `tahun_ajaran` sejak Phase 1, didefinisikan di `schema.prisma`") **dibatalkan** karena tiga fakta:
1. **Prisma tidak mendukung partitioning deklaratif** di `schema.prisma` — tidak ada sintaks `PARTITION BY` (feature request terbuka sejak 2020). Satu-satunya jalur: `prisma migrate dev --create-only` lalu edit SQL migration manual.
2. **Postgres mewajibkan semua PK/unique constraint di tabel partisi menyertakan partition key** — `@@unique([source, idempotencyKey])` global di `JournalEntry` tidak bisa eksis di tabel yang dipartisi. Idempotency pembayaran lebih penting daripada partisi.
3. **Volume tidak menuntutnya:** ± beberapa ribu siswa → ledger ± 2 juta baris/tahun, presensi per-periode ± 5 juta baris/tahun. Postgres nyaman puluhan juta baris di satu tabel ber-index. Partisi `unitId` (3 partisi) tidak memberi apa-apa di atas index biasa.

Kebijakan sekarang:
- **Tabel Ledger (`JournalEntry`, `LedgerEntry`) TIDAK dipartisi.** Titik.
- Tabel presensi per-periode menyertakan kolom `tahunAjaran` sejak awal (siap-partisi), index `(unitId, tahunAjaran, ...)`. Partisi RANGE per `tahunAjaran` **boleh ditambahkan nanti** lewat SQL migration manual yang di-review (§4.8) bila volume/arsip menuntut — bukan requirement Phase 1.
- Arsip alumni (§10) dilayani proses arsip eksplisit, bukan partition detach.

### 4.5 Naming Convention & Code Style
- **Naming:** `camelCase` untuk variable/function/kolom (termasuk `tahunAjaran` — bukan `tahun_ajaran`), `PascalCase` untuk class, prefix `unitId` konsisten di semua model operasional.
- **Folder structure per modul:** `/modules/<nama-modul>/` (misal `/modules/attendance`, `/modules/ledger`) berisi `controller.ts`, `service.ts`, `repository.ts` (kalau ada), `dto/`, `events/`, `*.spec.ts` — konsisten di semua modul.
- **Error handling:** exception filter terpusat (`AllExceptionsFilter` global) + custom exception class per domain (misal `InsufficientLedgerBalanceException`) daripada throw generic `Error`/`HttpException` bertebaran.
- **Enum, bukan String berkomentar:** nilai closed-set di tabel finansial (`refType`, `ownerType`, `source`) wajib Prisma enum — typo `"DEBET"` yang diterima diam-diam lalu lolos dari semua filter adalah kelas bug pembukuan. Enum bisa ditambah nilai lewat migration (`ALTER TYPE ... ADD VALUE`) — **tapi nilai baru tidak bisa dipakai di transaksi yang sama dengan penambahannya**: migration Prisma jalan dalam satu transaksi, jadi tambah-nilai-enum dan penggunaan pertamanya (backfill/insert) wajib dipecah jadi dua migration terpisah.

### 4.6 Logging & Monitoring
Semua operasi kritis (mutasi Ledger, submit presensi, transaksi payment) wajib pakai **structured logging** (bukan string log bebas), minimal menyertakan `correlationId` (request tracing), `unitId`, dan `actorId` (siapa yang melakukan aksi) — supaya investigasi insiden produksi bisa ditelusuri, bukan tebak-tebakan dari log yang tidak konsisten.

### 4.7 Environment & Configuration
Konfigurasi yang genuinely per-deployment (connection string database — **dua**: migrator & app role §4.2, Redis URL, JWT secret, kredensial + shared key signature DOKU) lewat environment variable standar (`.env` + validasi schema saat startup, misal `@nestjs/config` + Zod/Joi).

**Catatan penting:** `unitId`/unit context **bukan** environment variable — itu context dinamis per-request (§4.2), karena satu deployment API melayani semua unit sekaligus.

### 4.8 Versioning & Migration
- Prisma migration **wajib di-review manual** sebelum merge, terutama yang menyentuh tabel dengan RLS policy — jangan cuma percaya hasil generate mentah. RLS DDL (`ENABLE/FORCE ROW LEVEL SECURITY`, `CREATE POLICY`, `REVOKE`) ditulis manual di file migration (`prisma migrate dev --create-only` lalu edit).
- **Jangan** jalankan `prisma migrate dev` di production (bisa reset shadow database). Production pakai `prisma migrate deploy` — sebagai role `eos_migrator` (§4.2 poin 4).

---

## 5. Core Shared Services (Modul 0) — Bangun Sekali di Phase 1

### 5.1 Ledger Terpadu (Unified Ledger) — skema journal-based (v1.5)
Semua saldo (SPP, kantin, denda perpustakaan) mengalir lewat satu Ledger double-entry. **Tidak ada** tabel `Wallet` atau field `balance` mandiri di model lain.

**Kenapa didesain ulang:** skema lama (satu baris `LedgerTransaction` dengan `accountId` + `counterpartyAccountId` + `direction`) adalah single-entry dengan pointer — tidak ada grouping journal, jadi invariant zero-sum tidak bisa diekspresikan, statement per-akun harus membalik arah manual di tiap consumer, transaksi multi-leg (kantin: debit siswa → pendapatan vendor + fee yayasan) mustahil, dan `idempotencyKey @unique` menolak insert kaki keduanya sendiri.

```prisma
enum JournalSource {
  DOKU_VA
  DOKU_QRIS
  DOKU_SETTLEMENT // journal settlement/fee dari laporan settlement DOKU (key: settlement:{dokuBatchId})
  INTERNAL        // denda, reversal, journal manual, carry-forward
}

enum JournalRefType {
  LIBRARY_FINE
  CANTEEN_PAYMENT
  SPP_PAYMENT
  TOPUP
  REVERSAL
  SETTLEMENT       // dana DOKU-Clearing cair ke bank
  FEE              // biaya payment gateway
  REFUND
  OPENING_BALANCE  // carry-forward saat arsip (§10)
}

enum AccountOwnerType {
  STUDENT
  INTERNAL   // "Pendapatan Denda", "DOKU Clearing", "Bank Yayasan", "Beban Fee PG", dll.
}

model LedgerAccount {
  id          String           @id @default(uuid(7)) @db.Uuid
  unitId      String           // unit pemilik; akun level-yayasan memakai unit khusus YAYASAN (lihat catatan)
  ownerType   AccountOwnerType
  ownerId     String?          // studentId, null kalau akun internal
  accountCode String?          // kode stabil akun internal: "DOKU_CLEARING", "BANK_YAYASAN", "FEE_PG", "REVENUE_FINE", ... null untuk akun STUDENT
  label       String
  balance     Decimal          @default(0) @db.Decimal(18, 2) // cache saldo efektif — lihat aturan di bawah
  createdAt   DateTime         @default(now())

  entries LedgerEntry[]

  @@unique([unitId, ownerType, ownerId]) // HANYA melindungi akun STUDENT — Postgres: NULL distinct, (unit, INTERNAL, NULL) bisa duplikat!
  @@index([unitId])
}
// Wajib via SQL migration manual (tidak bisa di schema.prisma):
//   CREATE UNIQUE INDEX ledger_account_internal_code
//     ON "LedgerAccount"("unitId", "accountCode") WHERE "ownerType" = 'INTERNAL';
//   + CHECK (("ownerType" = 'INTERNAL') = ("accountCode" IS NOT NULL))
// Tanpa ini, dua akun "DOKU Clearing" bisa tercipta di unit yang sama —
// callback debit yang satu, settlement kredit yang lain, rekonsiliasi
// tidak pernah tie out. Label bebas bukan identitas; accountCode iya.

model JournalEntry {
  id                  String         @id @default(uuid(7)) @db.Uuid
  unitId              String         // unit peristiwa bisnis; journal settlement/fee lintas unit memakai unit YAYASAN
  source              JournalSource
  refType             JournalRefType
  refId               String?
  idempotencyKey      String
  reversalOfJournalId String?        @db.Uuid // terisi kalau refType = REVERSAL
  createdAt           DateTime       @default(now())

  reversalOf JournalEntry?  @relation("Reversal", fields: [reversalOfJournalId], references: [id])
  reversals  JournalEntry[] @relation("Reversal")
  entries    LedgerEntry[]

  @@unique([source, idempotencyKey]) // scoped per sumber — key DOKU VA / QRIS / internal tidak berbagi namespace
  @@index([unitId, createdAt])
  @@index([refType, refId])
}

model LedgerEntry {
  id        String   @id @default(uuid(7)) @db.Uuid
  journalId String   @db.Uuid
  unitId    String   // denormalisasi sengaja untuk RLS & index — wajib = account.unitId (BUKAN journal.unitId; kaki journal lintas unit ikut unit akunnya)
  accountId String   @db.Uuid
  amount    Decimal  @db.Decimal(18, 2) // SIGNED: positif = debit, negatif = kredit. TIDAK ADA kolom direction.
  createdAt DateTime @default(now())

  journal JournalEntry  @relation(fields: [journalId], references: [id])
  account LedgerAccount @relation(fields: [accountId], references: [id])

  @@index([accountId, createdAt]) // statement per-akun & reconciliation SUM — tanpa ini sequential scan
  @@index([unitId, createdAt])
}
```

Catatan skema:
- **PK `uuid(7)`** (time-ordered, Prisma ≥ 5.19, simpan `@db.Uuid` 16 byte) — bukan `cuid()`: key acak di tabel append-heavy = insert nyasar ke halaman index acak, bloat + cache miss.
- **Amount signed, tanpa kolom `direction`** — menghapus seluruh kelas bug dobel-negasi dan membuat invariant sejalan aritmetika: **`SUM(amount)` per `journalId` = 0**, dan `amount` tidak pernah nol. Tambahkan `CHECK (amount <> 0)` via SQL migration.
- **IDR tidak punya subunit** → `Decimal(18,2)` dipin eksplisit (default Prisma `decimal(65,30)` cuma buang ruang).
- FK + `@@index([accountId, createdAt])` bukan opsional — job reconciliation dan statement per-akun query lewat situ.
- **Konvensi tanda & "saldo siswa":** `amount` positif = debit, negatif = kredit (konvensi akuntansi: debit menambah aset/beban, kredit menambah kewajiban/pendapatan). Akun siswa adalah **kewajiban yayasan** (uang titipan siswa) — top-up = kredit (SUM makin negatif), jajan = debit. Karena itu **"saldo siswa" yang ditampilkan/dicek business rule = `-SUM(amount)`** (saldo efektif). Semua aturan "saldo negatif → blokir pinjam buku" (PRD Modul 3) mengacu ke **saldo efektif** ini, bukan SUM mentah — kolom `balance` di `LedgerAccount` menyimpan saldo efektif (sudah dinormalisasi per `ownerType`), dan service Ledger satu-satunya yang tahu normalisasi itu. Jangan pernah SUM mentah langsung dibandingkan nol di modul konsumen.
- **Unit YAYASAN (level yayasan):** akun "Bank Yayasan", "DOKU Clearing", "Beban Fee PG" bukan milik SD/SMP/SMA — mereka hidup di **unit khusus `YAYASAN`** (baris di tabel unit, bukan `unitId` nullable — semua constraint & RLS tetap seragam). Konsekuensi: (a) settlement DOKU yang satu batch mencakup pembayaran lintas jenjang dicatat sebagai journal ber-`unitId` YAYASAN, kakinya boleh menyentuh akun unit lain — makanya `LedgerEntry.unitId` mengikuti **akunnya**, bukan journalnya; (b) journal lintas unit membuat trial balance **per unit** tidak nol dengan sendirinya — zero-sum invariant berlaku **per journal (global)**; laporan per unit yang butuh balance memakai pasangan akun **inter-unit (due-to/due-from)** yang di-generate service Ledger otomatis untuk journal lintas unit; (c) akses baca/tulis unit YAYASAN hanya lewat context cross-unit (`__ALL__`) atau membership eksplisit Bendahara/Yayasan Admin; (d) operasi Ledger yang menyentuh akun YAYASAN (settlement, fee, top-up via clearing) dijalankan **system worker finansial** dengan context `__ALL__` — bukan context unit request — supaya row lock & RLS melihat semua akun yang terlibat (lock yang tidak melihat akunnya = akun tidak ter-lock, lihat aturan lock di bawah).

Aturan wajib:
- **Append-only.** Tidak ada `deletedAt`/soft-delete di `JournalEntry`/`LedgerEntry`. Koreksi = **reversing journal** (journal baru `refType: REVERSAL`, kaki-kaki bernilai negasi, `reversalOfJournalId` diisi, idempotency key `reversal:{journalId}:{n}` — komponen urutan `n` karena satu journal secara sah bisa dibalik lagi setelah reversal-nya sendiri dibalik; aturan bisnis "maksimal satu reversal aktif" ditegakkan service, bukan oleh unique key). Enforce juga di DB: `REVOKE UPDATE, DELETE ON "JournalEntry", "LedgerEntry" FROM eos_app` — sama seperti `AuditLog`.
- **Zero-sum per journal.** Service Ledger adalah satu-satunya penulis journal dan wajib menolak journal yang kakinya tidak berjumlah nol atau kakinya < 2. Job reconciliation memverifikasi ulang invariant ini. **Enforce juga di DB** (service-only-writer itu konvensi, `$executeRaw` tetap ada): `CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED` yang memvalidasi `SUM(amount) = 0` dan jumlah kaki ≥ 2 per journal saat COMMIT — via SQL migration manual; menangkap penulis buggy/bypass saat tulis, bukan saat reconciliation berikutnya (jendela di mana journal timpang sudah meracuni balance cache dan statement).
- **Concurrency control — satu model saja:** Read Committed + `SELECT ... FOR UPDATE` semua akun yang terlibat, **di-lock berurutan sort by account id** (dua transfer A→B dan B→A tanpa urutan deterministik = deadlock). **Jangan** tambah Serializable di atasnya — dobel biaya, plus abort 40001 yang Prisma tidak auto-retry; jam sibuk kantin akan jadi abort storm di akun pendapatan vendor yang hot.
  ```typescript
  await prisma.$transaction(async (tx) => {
    const ids = [debitAccountId, ...creditAccountIds].sort();
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "LedgerAccount" WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`;
    // WAJIB: verifikasi locked.length === ids.length. Baris yang tidak ada
    // (typo id) ATAU tersaring RLS (akun di luar unit context — misal akun
    // YAYASAN dari context unit biasa) tidak error, cuma DIAM-DIAM tidak
    // ter-lock. Kurang satu baris = abort transaksi, jangan lanjut.
    if (locked.length !== ids.length) throw new LedgerAccountLockException(ids, locked);
    // validasi saldo → insert JournalEntry + LedgerEntry[] → UPDATE balance
    // SEMUA di transaksi ini. Balance yang di-update di luar transaksi = drift by design.
  });
  ```
- **Balance cache.** `balance` di `LedgerAccount` adalah cache — di-update **dalam transaksi yang sama** dengan insert kaki journal (lihat blok di atas), dan job BullMQ harian merekalkulasi dari `SUM(LedgerEntry.amount)` per akun lalu membandingkan. Selisih = **alert, jangan auto-silent-correct**. Akun panas (dipakai blokir layanan: **saldo efektif** negatif → tolak pinjam buku; SPP telat → blokir kantin) boleh diverifikasi lebih sering dari harian.
- **Webhook DOKU — autentikasi DULU, idempotency KEDUA:**
  1. **Verifikasi signature HMAC-SHA256** (komponen: Client-Id, Request-Id, Request-Timestamp, **Request-Target** (path endpoint — tanpa ini callback QRIS ber-signature sah bisa di-replay ke handler VA), digest body — spesifikasi final dikonfirmasi ke DOKU, §13) + tolak timestamp stale. Idempotency men-dedup, **tidak** mengautentikasi — tanpa signature check, URL webhook yang bocor = mesin cetak saldo, dan forgery yang membawa idempotency key asli membuat callback sah di-drop sebagai "duplikat".
  2. **`WebhookInbox`** (tabel biasa, non-partisi): simpan payload mentah + signature + `status` (`RECEIVED`/`PROCESSED`/`FAILED`) **sebelum** diproses jadi journal. **Key unik inbox = key bisnis** (nomor invoice/VA + amount — field pasti dikonfirmasi ke DOKU §13), **bukan Request-Id** — sebagian gateway menerbitkan Request-Id baru per retry, yang membuat dedup by Request-Id bolong. Perilaku wajib:
     - Insert kena unique violation **dan baris lama `PROCESSED`** → duplikat sejati, **balas HTTP 200** (DOKU terus me-retry non-2xx).
     - Insert kena unique violation tapi baris lama `RECEIVED`/`FAILED` (crash setelah insert, sebelum journal) → **proses ulang baris itu sekarang**, jangan balas 200 kosong.
     - **Re-processor internal** (BullMQ repeat job) menyapu baris `RECEIVED`/`FAILED` yang menua dan me-retry-nya — outbox (§4.3) meng-cover arah domain→event; re-processor ini meng-cover arah inbox→journal. Tanpa dia, crash sesudah insert = pembayaran sah yang hilang diam-diam dan DOKU sudah berhenti me-retry karena terlanjur dijawab 200. Journal creation tetap idempoten via `@@unique([source, idempotencyKey])`, jadi re-process ganda aman.
     - Payload mentah = bukti sengketa.
- **Idempotency internal.** BullMQ at-least-once — setiap event yang menulis Ledger bawa key deterministik: `fine:{loanId}:{tanggal}`, `reversal:{journalId}:{n}`, `settlement:{dokuBatchId}`. Kena `@@unique([source, idempotencyKey])` → job dianggap sukses (bukan retry). **Journal manual/adjustment** (bookkeeper) tidak punya key alami — key **wajib di-mint client-side sekali di form submission** (UUID di hidden field) dan dibawa di semua retry HTTP; men-generate key random di server saat write memenuhi constraint tapi memberi nol idempotency.
- **Settlement & clearing.** Callback DOKU = uang di DOKU, belum di yayasan. Callback valid → journal `[+DOKU-Clearing, −saldo siswa/piutang]`; settlement cair → journal `[+Bank, +Beban Fee, −DOKU-Clearing]` (`SETTLEMENT` + `FEE`). Tanpa akun clearing, rekonsiliasi rekening koran tidak akan pernah tie out.

### 5.2 QrEngineModule
Satu modul terpusat generate & validasi QR/barcode, kebijakan berbeda per `type` — **jangan** diimplementasi ulang per modul.

```typescript
export const QR_POLICY: Record<QrType, { mode: 'STATIC' | 'SINGLE_USE'; ttlSeconds?: number; store: 'REDIS' | 'POSTGRES' }> = {
  GATE_ATTENDANCE: { mode: 'SINGLE_USE', ttlSeconds: 30, store: 'REDIS' },    // TTL DAN consumed-on-validate
  CANTEEN_PAYMENT: { mode: 'SINGLE_USE', ttlSeconds: 30, store: 'REDIS' },    // scan dobel ≠ debit dobel
  LIBRARY_BOOK:    { mode: 'STATIC' },                                        // barcode/ISBN fisik
  GATE_PASS:       { mode: 'SINGLE_USE', store: 'POSTGRES' },                 // lihat catatan — BUKAN Redis
};
```

Hardening (v1.5):
- **TTL saja tidak cukup** — token 30 detik yang tidak dikonsumsi bisa di-replay dalam jendelanya (scan dobel di kasir, QR difoto dari layar anak). Token dinamis dikonsumsi **atomik** saat validasi pertama: Redis `GETDEL` (satu operasi, tidak ada race dua scanner).
- Token dari **CSPRNG, ≥ 128 bit** — model lookup-Redis tidak butuh signing hanya kalau token tidak bisa ditebak.
- **Type binding di key Redis, bukan hanya payload:** key = `qr:{type}:{token}`, scanner hanya boleh `GETDEL` namespace type-nya sendiri. Kalau type cuma dicek di payload SETELAH `GETDEL`, scan salah-type (kasir memindai QR gerbang anak) **mengonsumsi** token yang kemudian ditolak — token gerbang hangus sia-sia dalam jendela 30 detiknya. Dengan namespace di key, scan salah-type miss total dan tidak mengonsumsi apa-apa. Payload tetap menyimpan `{ studentId, type }` untuk validasi lapis kedua.
- **GATE_PASS TIDAK di Redis.** Token tanpa TTL di Redis hilang saat restart dan bisa ter-evict di maxmemory — gate pass yang sudah di-approve orang tua lenyap sebelum anak sampai gerbang, dan "invalid permanen" yang hanya berupa ketiadaan key tidak meninggalkan jejak kapan/di mana pass dikonsumsi. Gate pass = fitur child-safety ber-audit, volume rendah, umur panjang → simpan di **Postgres** (kolom `status ISSUED/CONSUMED/EXPIRED` + `consumedAt`/`consumedBy`, konsumsi via `UPDATE ... SET status='CONSUMED' WHERE id=... AND status='ISSUED'` atomik), masuk Audit Trail. Redis hanya untuk token 30-detik frekuensi tinggi.
- `/qr/validate` **bukan endpoint publik** — hanya device scanner ter-autentikasi (role scanner khusus per fungsi: gerbang, kasir, perpus).

Endpoint tunggal `/qr/validate` men-decode payload, cek `type`, lalu dispatch ke service terkait (pola Command/Query Handler) — debit kantin sinkron (§4.3), sisanya via event.

---

## 6. Peta Modul (ringkas — detail lengkap ada di PRD §4; fase mengikuti roadmap v1.5, PRD §6)
| # | Modul | Fase | Catatan kritis |
|---|---|---|---|
| 0 | Core Shared Services | 1 | Ledger journal-based + WebhookInbox + outbox + QrEngineModule, wajib pertama |
| 1 | Yayasan & Unit Management | 1 | Audit Trail append-only, REVOKE di level DB |
| 2 | Academic Management | 1, 4 | Timetabling semi-otomatis v1; presensi 2 lapis offline-first; rapor per-jenjang; **CBT → post-pilot** |
| 3 | Library Management | 2 | Denda via Ledger + outbox, job denda idempoten |
| 4 | Smart Canteen | 3 | Debit sinkron single-use QR; **pre-order + antrian realtime → post-pilot** |
| 5 | Finance & Billing | 2 | DOKU VA + signature + clearing/settlement |
| 6 | HRIS | 4 | Teacher Unit Conversion rate per mapel/jenjang, guru many-to-many unit |
| 7 | Student Wellbeing (BK/UKS) | 4 (UKS), 6 (BK/psychometric) | Tabel terpisah + DTO whitelist + audit READ; UU PDP; psychometric belum diputuskan |
| 8 | Parent & Student Engagement | 4 | Gate pass + jalur darurat; broadcast/FAQ; **chat 2 arah → post-pilot** |
| 9 | Admissions CRM (PPDB) | 6 | Kriteria ranking harus didefinisikan Yayasan dulu |
| 10 | Business Intelligence | 6 | Predictive flag wajib explainable, rule-based di v1 |

---

## 7. Non-Negotiable Rules — Jangan Dilanggar Tanpa Diskusi Ulang
Ini keputusan yang sudah lewat beberapa putaran review teknis. Kalau kamu (agent) merasa perlu menyimpang dari salah satu ini, berhenti dan tanya ke manusia dulu — jangan diam-diam diubah.

1. 🚫 **Jangan** pakai Prisma Middleware (`$use`) — deprecated v4.16, dihapus v6.14. Pakai Client Extensions (`$extends`) + RLS.
2. 🚫 **Jangan** tambahkan `deletedAt`/soft-delete ke `JournalEntry`/`LedgerEntry`/`AuditLog`. Koreksi = reversing journal. `REVOKE UPDATE, DELETE` dari role app di level DB.
3. 🚫 **Jangan** mutasi saldo tanpa `SELECT ... FOR UPDATE` semua akun terlibat, di-lock **urutan sort by id**, dengan insert journal + update balance **dalam transaksi yang sama**. Jangan pula pakai Serializable global di atasnya (§5.1).
4. 🚫 **Jangan** proses webhook payment gateway tanpa **verifikasi signature + cek timestamp** DULU, baru idempotency (WebhookInbox). Idempotency men-dedup, tidak mengautentikasi. Duplikat dijawab HTTP 200.
5. 🚫 **Jangan** bikin field saldo/wallet baru di model manapun selain Ledger.
6. 🚫 **Jangan** bangun proctoring webcam/screenshot untuk CBT sebelum ada keputusan eksplisit soal parental consent & kebijakan retensi (subjeknya anak-anak).
7. 🚫 **Jangan** hardcode rate konversi JP → Equivalent Unit — wajib konfigurabel per mata pelajaran/jenjang.
8. 🚫 **Jangan** modelkan relasi Guru↔Unit sebagai one-to-one — wajib many-to-many; JWT bawa **daftar membership**, bukan satu `unitId` (§4.2).
9. 🚫 **Jangan** bangun full constraint-solver timetabling otomatis untuk v1 — cukup semi-otomatis (draft + finalisasi manual TU).
10. 🚫 **Jangan** perlakukan presensi sebagai satu record harian — skema wajib granular per periode/mata pelajaran, cross-check dengan presensi gerbang, kolom `tahunAjaran` sejak awal.
11. 🚫 **Jangan** buat Gate Pass Approval terkunci total pada respons orang tua — wajib ada jalur darurat manual (UKS/wali kelas + konfirmasi telepon).
12. 🚫 **Jangan** ship Predictive Student Flag sebagai skor yang tidak bisa dijelaskan — setiap flag harus bisa ditelusuri ke faktor konkret.
13. 🚫 **Jangan** lewatkan conflict-resolution logic saat membangun sync offline-first presensi (kebijakan: submission pertama menang, submission berikutnya dapat prompt override).
14. 🚫 **Jangan** asumsikan kriteria ranking PPDB — tanya eksplisit ke Yayasan sebelum implementasi algoritma ranking.
15. 🚫 **Jangan** import service antar modul untuk write/side-effect **asinkron** — wajib event contract + **transactional outbox** untuk event yang menyentuh Ledger (§4.3). ✅ Read/query sinkron boleh import langsung lewat interface publik modul. ✅ Debit point-of-sale (kantin) sinkron via service Ledger adalah pengecualian yang disengaja.
16. 🚫 **Jangan** treat `unitId` sebagai environment variable statis, dan **jangan** samakan `undefined` (context belum pernah di-set — bug) dengan `null` (cross-unit disengaja) di request context (§4.2). Context hilang wajib fail-closed.
17. 🚫 **Jangan** jalankan aplikasi runtime dengan role pemilik tabel/superuser/`BYPASSRLS` — RLS tidak berlaku untuk owner tanpa `FORCE ROW LEVEL SECURITY`, dan policy yang tidak pernah dievaluasi tetap hijau di test yang salah role (§4.2 poin 4).
18. 🚫 **Jangan** tulis journal yang kakinya tidak berjumlah nol, kakinya < 2, atau ber-`amount` 0 — service Ledger satu-satunya penulis dan wajib menolak (§5.1).
19. 🚫 **Jangan** terbitkan event penulis-Ledger tanpa idempotency key deterministik — BullMQ at-least-once; job denda yang di-retry tanpa key = siswa didenda dua kali (§5.1).
20. 🚫 **Jangan** buat QR pembayaran/gerbang yang bisa divalidasi lebih dari sekali — consumed-on-validate atomik (Redis `GETDEL`), terikat `studentId` + `type` (§5.2).

---

## 8. Keamanan & RBAC
| Role | Scope akses |
|---|---|
| Yayasan Admin | Lintas unit HANYA di endpoint ber-`@CrossUnit()` (konsolidasi); scoped di endpoint lain. MFA wajib |
| Unit Admin (TU) | Hanya unit yang ditugaskan |
| Teacher | Unit-unit yang ditugaskan (many-to-many, membership di JWT), input nilai/presensi/CBT/BK |
| Student | Data milik sendiri |
| Parent | SSO, multi-anak lintas unit — unit context di-resolve dari anak yang diakses setelah verifikasi relasi |
| Staff | Sesuai peran (bendahara — MFA wajib, pustakawan, kantin, UKS, satpam) |
| Scanner device | Role mesin khusus per fungsi (gerbang/kasir/perpus), satu-satunya yang boleh panggil `/qr/validate` |

Tambahan khusus:
- **Password:** Argon2id (m=19 MiB, t=2, p=1 minimum). **Rate limiting + lockout** di endpoint login. **MFA (TOTP)** untuk Yayasan Admin & Bendahara.
- Data BK/UKS: **tabel terpisah** milik modul Wellbeing (satu-satunya exporter — sejalan §4.3), DTO whitelist di semua read path, enkripsi kolom naratif konseling, dan **audit atas READ** catatan anak (bukan hanya write) masuk Audit Trail. RLS itu row-level dan Prisma select semua kolom default — "field-level" tidak gratis, harus dibangun begini.
- **UU PDP No. 27/2022 (requirement desain, bukan asersi):** data anak & kesehatan = data pribadi spesifik. Model consent orang tua (capture + withdrawal), enkripsi at-rest BK/UKS, foto siswa di bucket private + presigned URL pendek, runbook breach 3×24 jam, kebijakan retensi & hak hapus (arsip ≠ hapus).
- Audit Trail: append-only **di-enforce DB** (`REVOKE UPDATE, DELETE` dari `eos_app`), kebijakan siapa-boleh-lihat dan retensi didefinisikan eksplisit sebelum go-live.

## 9. Reliability — UI Lapangan
UI Presensi Per-Jam Pelajaran (dipakai guru berkali-kali sehari di ruang kelas berbeda-beda) **wajib offline-first**: submit disimpan lokal, sync otomatis saat ada koneksi, dengan conflict-resolution eksplisit (§7 poin 13). Catatan platform: mobile app hanya untuk siswa & orang tua (§2) — UI guru ini berjalan di web Astro, artinya offline-first = service worker + IndexedDB; ini subsistem terbesar Phase 4, uji lapangan (WiFi sekolah fluktuatif, dobel-submit guru piket vs wali kelas, clock skew) sejak awal.

## 10. Backup & Retention
- PITR — managed service (AWS RDS/Aurora) kalau dipakai sudah otomatis; kalau self-hosted, pakai pgBackRest/WAL-G, jangan rakit manual.
- Data alumni (>5 tahun) pindah ke tabel/database arsip terpisah (cold storage) — beda fungsi dari read replica (yang baru diprovisikan post-pilot untuk offload query BI, PRD Modul 10 — bukan infra Phase 1).
- **Arsip Ledger:** sebelum memindahkan `JournalEntry`/`LedgerEntry` lama, tulis journal **carry-forward** (`refType: OPENING_BALANCE`) per akun — tanpa ini aturan "balance selalu bisa direkonstruksi dari transaksi" (§5.1) rusak begitu arsip pertama jalan, dan job reconciliation alert palsu selamanya.

## 11. Testing — Prioritas Coverage
Area berikut butuh test paling ketat karena riwayat review menandai risikonya tinggi:
- **Concurrency Ledger:** debit bersamaan ke akun sama (request paralel), transfer silang A→B vs B→A (deadlock — harus selesai karena lock terurut, bukan timeout), zero-sum ditolak service DAN constraint trigger (uji lewat `$executeRaw` yang mem-bypass service), **lock count mismatch abort** (satu accountId tak terlihat RLS/tak ada → transaksi gagal, bukan lanjut diam-diam).
- **Webhook DOKU:** (a) signature invalid → ditolak, tidak ada journal; (b) signature valid dikirim 2× setelah PROCESSED → satu journal, respons kedua HTTP 200; (c) forgery membawa idempotency key asli → ditolak di tahap signature **sebelum** menyentuh dedup; (d) **crash setelah insert inbox, sebelum journal** → retry DOKU memproses ulang baris RECEIVED (bukan 200 kosong), dan re-processor menyapu baris menua — pembayaran tidak pernah hilang diam-diam; (e) callback QRIS ber-signature sah di-replay ke handler VA → ditolak (Request-Target di HMAC).
- **Idempotency internal:** job BullMQ penulis-Ledger di-replay (denda, reversal) → satu journal. Reversal di-replay → tidak membalik dua kali; reversal-of-reversal lalu reversal ulang → boleh (key ber-`{n}`).
- **QrEngineModule per-`type`:** TTL expired; **dua scanner validasi token sama bersamaan → tepat satu sukses** (GETDEL atomik); scanner kasir memindai token `GATE_ATTENDANCE` → **miss tanpa mengonsumsi** (namespace key per type); `/qr/validate` tanpa auth scanner → ditolak; static barcode tanpa expiry; gate pass: invalid permanen setelah 1x, **survive restart Redis** (Postgres-backed), konsumsi tercatat di Audit Trail.
- **Isolasi `unitId`:** test connect sebagai **`eos_app`** (bukan owner — test sebagai owner tidak membuktikan apa-apa): GUC unit A → baris unit B tak terlihat; `undefined` context ditolak (§4.2/§7.16); **GUC unset ATAU empty-string → NOL baris (fail-closed), termasuk INSERT ditolak**; cross-unit hanya via sentinel `__ALL__` yang di-set guard `@CrossUnit()`; create tanpa `unitId` di data ditolak/terinjeksi benar (§4.1 caveat); `$queryRaw` tanpa set_config → nol baris (RLS menutup, bukan membuka).
- **Outbox:** crash di antara commit domain dan publish → relay tetap menerbitkan setelah restart; tidak ada event hilang.
- **Reconciliation:** drift balance cache terdeteksi & alert (bukan auto-correct); SUM per journal ≠ 0 terdeteksi; **saldo efektif** (tanda dinormalisasi per ownerType) yang dipakai aturan blokir, bukan SUM mentah.
- **Conflict resolution presensi offline-first:** submit ganda periode sama → pertama menang, kedua dapat prompt override.

## 12. Rollout
- Pilot di satu unit dulu (SMP) selama satu semester sebelum full rollout ke SD+SMA. Target MVP pilot: 8–10 bulan (PRD §6 v1.5) — bukan 6 bulan.
- UAT melibatkan pengguna non-teknis sejak awal (guru, TU, satpam, orang tua) — banyak fitur (scan QR, roll call, gate pass) dioperasikan langsung oleh mereka. Alokasikan ± 20% kapasitas per fase untuk siklus feedback UAT.
- Onboarding merchant DOKU + sandbox dimulai **minggu 1** — berjalan di clock DOKU; billing dibangun terhadap gateway interface yang di-mock sampai sandbox siap.

## 13. Belum Diputuskan (Jangan Diasumsikan Agent)
- Build vs integrasi provider psychometric test pihak ketiga (Modul 7).
- Target load test spesifik untuk Smart Canteen dan CBT (butuh proyeksi jumlah siswa riil per unit).
- Integrasi Dapodik/SIAKAD (tergantung apakah Yayasan berpartisipasi BOS/Dapodik — konfirmasi ke stakeholder dulu).
- Kriteria & bobot ranking PPDB (harus didefinisikan Yayasan).
- Spesifikasi final signature webhook DOKU (header, algoritme digest, semantik retry, field key bisnis untuk unique key WebhookInbox), jadwal settlement VA, breakdown per transaksi di laporan settlement (untuk alokasi per unit), kebijakan VA closed vs open amount (pembayaran parsial/lebih), dan kebijakan refund per kanal — konfirmasi ke tim DOKU Bulan 1.
- Parental consent & kebijakan retensi untuk proctoring CBT (webcam/screenshot) — prasyarat rule #6 di atas; keputusan yayasan, kejar sebelum CBT post-pilot dibangun.

Kalau agent sampai ke salah satu area ini, **wajib bikin ticket/issue** yang merangkum konteks dan pertanyaan yang perlu dijawab, lalu berhenti — jangan menebak atau lanjut implementasi sebelum ada keputusan stakeholder.

---

*Referensi lengkap requirement bisnis: `PRD.md` (v1.5). Dokumen ini akan di-update secara berkala — setiap update besar sebaiknya direview bersama PRD supaya keduanya tidak saling menyimpang.*
