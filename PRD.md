# 📄 PRODUCT REQUIREMENTS DOCUMENT (PRD) - REVISED
**Nama Produk:** Yayasan Education Operating System (Yayasan EOS)
**Versi:** 1.5
**Tipe Produk:** Private Internal System (Multi-Tier, Single Foundation)

---

## 1. Ringkasan Produk (Product Overview)
Yayasan EOS adalah platform manajemen pendidikan terpusat yang dirancang khusus untuk mengelola seluruh operasional di bawah satu Yayasan. Sistem ini mampu menangani multi-jenjang pendidikan (SD, SMP, SMA) dalam satu basis data terintegrasi.

Tujuan utama sistem ini adalah mengotomatisasi proses akademik, keuangan, SDM, dan operasional harian (Perpustakaan, Kantin, UKS), serta memberikan transparansi penuh kepada orang tua/wali siswa untuk memantau aktivitas anak.

Sistem dibagi menjadi 3 layer aplikasi:
1. **NestJS API:** Backend pusat yang menangani logika bisnis kompleks dan arsitektur multi-unit.
2. **Astro Web App:** Dashboard administrasi untuk Yayasan, Admin Unit (TU), Guru, dan Staf.
3. **Flutter Mobile App:** Aplikasi mobile khusus untuk Siswa dan Orang Tua/Wali.

**Riwayat Revisi:**
- **v1.1** — Wallet sederhana diganti Ledger terpadu (double-entry) & QrEngineModule; isolasi unit dikoreksi dari Prisma Middleware ke Client Extensions.
- **v1.2** — Presensi dipecah dua lapis (gerbang + per-periode) untuk deteksi bolos pelajaran spesifik; CBT dapat safeguard anti-cheating; Gate Pass dapat jalur darurat; Audit Trail jadi append-only.
- **v1.3** — PostgreSQL RLS sebagai defense-in-depth; rapor per-jenjang; strategi partitioning & event contract diformalkan; Predictive Flag wajib explainable; strategi rollout bertahap ditambahkan.
- **v1.4** — Payment gateway diganti ke DOKU (Virtual Account untuk SPP, QRIS/e-wallet untuk top-up kantin), menggantikan Xendit/Midtrans karena pertimbangan biaya dan kecepatan settlement.
- **v1.5** — Hasil review teknis panel: (1) skema Ledger didesain ulang jadi journal-based double-entry sejati (`JournalEntry` + `LedgerEntry`, invariant zero-sum per journal) — skema lama satu-baris-dengan-pointer terbukti single-entry terselubung; (2) **verifikasi signature webhook DOKU jadi wajib** — idempotency saja tidak mengautentikasi pengirim; (3) strategi partitioning dikoreksi — Prisma tidak mendukung partitioning deklaratif di `schema.prisma`, partisi `unitId` dibatalkan (volume tidak membutuhkan), ledger tidak dipartisi; (4) RLS di-hardening (`FORCE ROW LEVEL SECURITY`, role aplikasi terpisah dari role migrasi, penanganan empty-string GUC); (5) QR pembayaran kantin jadi single-use (anti-replay); (6) transactional outbox untuk event yang menyentuh Ledger; (7) model settlement & clearing account DOKU; (8) Argon2id menggantikan Bcrypt; kepatuhan UU PDP dinaikkan dari asersi jadi requirement desain; (9) roadmap direkalibrasi ke target realistis (MVP pilot 8–10 bulan untuk tim 2–4 dev).

## 2. Arsitektur Sistem & Tech Stack
* **Backend:** NestJS (Modular Monolith), WebSocket (Socket.io) untuk real-time.
* **Database:** PostgreSQL (Relasional, ACID compliant).
* **ORM:** Prisma ORM. Skema menggunakan strategi *Multi-Tenancy melalui `unitId`* (Row-Level Security). Setiap tabel operasional mengandung `unitId` untuk memisahkan data SD, SMP, dan SMA. Enforcement isolasi dilakukan lewat **Prisma Client Extensions** (lihat NFR §5.1) — bukan Middleware, yang sudah dihapus dari Prisma (deprecated v4.16, dihapus v6.14).
* **Strategi Partitioning (dikoreksi v1.5):** Prisma **tidak mendukung** definisi partitioning di `schema.prisma` — partisi hanya bisa dibuat lewat SQL migration yang di-edit manual (`prisma migrate dev --create-only`). Estimasi volume riil (± beberapa ribu siswa): presensi per-periode ± 5 juta baris/tahun, ledger ± 2 juta baris/tahun — PostgreSQL menangani puluhan juta baris di satu tabel ber-index dengan nyaman. Keputusan: **tabel Ledger TIDAK dipartisi** (menjaga unique constraint idempotency tetap global — lihat §0.1); presensi per-periode **boleh** di-partisi RANGE per `tahunAjaran` lewat SQL migration manual bila volume menuntut, dan skemanya disiapkan agar kompatibel (kolom `tahunAjaran` ada sejak awal). Partisi per `unitId` dibatalkan — 3 partisi tidak memberi manfaat di atas index `unitId` biasa, tapi memaksa semua PK/unique constraint menyertakan partition key.
* **Event Contract Antar Modul:** Komunikasi write/side-effect antar modul (misal Modul 3 Perpustakaan memicu Modul 0 Ledger saat denda tercipta) memakai skema event yang terdefinisi eksplisit via BullMQ — bukan pemanggilan langsung ad-hoc antar service. **Wajib pola transactional outbox** untuk event yang menyentuh Ledger: event ditulis ke tabel outbox **dalam transaksi database yang sama** dengan write domain-nya, relay terpisah yang mem-publish ke BullMQ — karena Redis tidak ikut transaksi PostgreSQL, tanpa outbox ada jendela crash di mana denda tercatat tapi transaksi ledger tidak pernah tercipta (dan job reconciliation tidak bisa mendeteksi transaksi yang tidak pernah ditulis). Konsumen event wajib idempoten (lihat §0.1 — idempotency key internal). **Pengecualian sinkron:** debit finansial yang butuh jawaban saat itu juga (pembayaran kantin di kasir) memanggil service Ledger langsung dalam satu transaksi database — detail di AGENTS.md §4.3.
* **Caching & Message Broker:** Redis (Caching, WebSocket Adapter, BullMQ untuk job queue seperti denda dan generate rapor).
* **Web Frontend:** Astro (SSR) + TailwindCSS.
* **Mobile App:** Flutter (Target: iOS & Android, State Management: Riverpod/Bloc).
* **Integrasi Pihak Ketiga:** Payment Gateway **DOKU** (PJP Kategori Izin 1 berlisensi Bank Indonesia, PCI DSS + ISO 27001 — verifikasi silang ke daftar PJP resmi di bi.go.id sebelum kontrak) — Virtual Account untuk SPP/tagihan nominal besar (flat Rp4.000/transaksi, belum termasuk PPN), QRIS/e-wallet untuk top-up kantin nominal kecil (MDR pendidikan 0,6% — pastikan merchant terdaftar di kategori pendidikan); Cloud Storage (AWS S3/Cloudinary); FCM (Firebase Cloud Messaging).

## 3. User Roles (Manajemen Hak Akses)
Sistem menggunakan Role-Based Access Control (RBAC) yang ketat berdasarkan hierarki Yayasan:
1. **Yayasan Admin:** Akses penuh lintas jenjang (SD, SMP, SMA). Melihat laporan konsolidasi keuangan, HR, dan akademik gabungan.
2. **Unit Admin (TU):** Akses manajemen penuh hanya pada unitnya (misal: TU SMP hanya mengelola data SMP).
3. **Teacher (Guru):** Mengajar, input nilai, presensi, CBT, dan BK. Relasi guru-unit bersifat **many-to-many** — satu guru bisa ditugaskan mengajar di lebih dari satu jenjang sekaligus.
4. **Student (Siswa):** Melihat jadwal, nilai, e-wallet (via Ledger), antrian kantin, pinjam buku.
5. **Parent (Orang Tua):** *Fitur Single Sign-On (SSO)*. 1 akun orang tua bisa memantau banyak anak dalam yayasan yang sama dalam satu aplikasi.
6. **Staff (Staf Operasional):** Bendahara, Petugas Perpustakaan, Petugas Kantin, Perawat UKS, Satpam.

**Catatan v1.5 — konsekuensi arsitektural relasi multi-unit:** Guru (many-to-many unit) dan Orang Tua (multi-anak lintas unit) **tidak bisa** direpresentasikan satu `unitId` skalar di JWT. Desain: JWT membawa **daftar membership unit**; setiap request mendeklarasikan satu *active unit* yang divalidasi guard terhadap membership; nilai tervalidasi itulah yang masuk ke unit context & RLS. Endpoint orang tua me-resolve unit dari anak yang sedang diakses (setelah verifikasi relasi orang tua–anak). Detail teknis di AGENTS.md §4.2.

---

## 4. Functional Requirements (Modul Sistem)

### Modul 0: Core Shared Services
Dua layanan ini dipakai lintas modul dan dibangun sekali di Phase 1, supaya modul lain tinggal konsumsi.

**0.1 Ledger Terpadu (Unified Ledger) — didesain ulang v1.5**
Mengganti model `Wallet` sederhana. Struktur journal-based double-entry sejati:
* `LedgerAccount`: rekening per entitas (siswa, dan akun internal seperti "Pendapatan Denda Perpustakaan", "Pendapatan Kantin", **"DOKU Clearing/Receivable"**, "Bank Yayasan", "Beban Fee Payment Gateway"). Akun internal ber-**kode stabil** (`accountCode`, unik per unit — label bebas bukan identitas; dua akun "DOKU Clearing" di unit yang sama = rekonsiliasi tidak pernah tie out). Akun level-yayasan (Bank, Clearing, Fee) hidup di **unit khusus `YAYASAN`** — bukan milik SD/SMP/SMA; journal settlement lintas jenjang tercatat di unit ini dan kakinya boleh menyentuh akun unit lain (detail teknis + konsekuensi trial balance per unit: AGENTS.md §5.1).
* `JournalEntry` (header): satu baris per **peristiwa bisnis** (satu pembayaran SPP, satu top-up, satu denda). Menyimpan `refType`, `refId`, dan **idempotency key ber-scope sumber** (`@@unique([source, idempotencyKey])` — key DOKU VA, DOKU QRIS, dan key internal tidak berbagi satu namespace, mencegah tabrakan/dedup keliru lintas kanal).
* `LedgerEntry` (kaki/leg): ≥ 2 baris per journal, masing-masing menunjuk satu `LedgerAccount` dengan **amount bertanda** (signed). **Invariant: `SUM(amount)` per journal = 0** — di-enforce di service layer, **di database** (constraint trigger deferred saat COMMIT), dan diverifikasi job reconciliation. Ini yang membuat multi-leg mungkin (contoh Phase 3: satu pembayaran kantin pecah jadi debit siswa, kredit pendapatan vendor, kredit fee yayasan) dan laporan per-akun tidak perlu inversi arah manual.
* **Konvensi "saldo siswa":** akun siswa adalah kewajiban yayasan (uang titipan) — dengan konvensi signed, top-up membuat SUM makin negatif. Semua tampilan & aturan bisnis ("saldo negatif → blokir pinjam buku" Modul 3, cek saldo kantin Modul 4) memakai **saldo efektif** yang sudah dinormalisasi service Ledger (`balance` di `LedgerAccount`), **bukan** SUM mentah — modul konsumen dilarang membandingkan SUM mentah dengan nol (AGENTS.md §5.1).
* **Append-only** — koreksi lewat **reversing journal** (journal baru berisi kaki-kaki bernilai negasi, dengan FK `reversalOfJournalId` menunjuk journal yang dibalik), bukan soft-delete atau edit. Reversal punya idempotency key sendiri (reversal yang di-replay tidak boleh membalik dua kali).
* **Settlement & clearing (baru v1.5):** callback DOKU = uang sampai di DOKU, **bukan** di rekening yayasan. Alur: saat callback valid → journal `[debit DOKU-Clearing, kredit saldo siswa/piutang SPP]`; saat dana settle ke bank (T+1 / sesuai kontrak) → journal `[debit Bank, debit Beban Fee, kredit DOKU-Clearing]`. `refType` mencakup `SETTLEMENT`, `FEE`, `REFUND` — tanpa ini rekonsiliasi rekening koran vs ledger (Modul 5) tidak akan pernah tie out.
* **Concurrency control:** satu model saja — **Read Committed + `SELECT ... FOR UPDATE`** pada semua akun yang terlibat, di-lock dalam **urutan deterministik** (sort by account id) untuk mencegah deadlock. Bukan Serializable global (biaya ganda + abort storm 40001 di jam sibuk kantin tanpa strategi retry).
* **Autentikasi, inbox, dan idempotency webhook — tiga hal berbeda, tiga-tiganya wajib:**
  1. **Verifikasi signature** — setiap callback DOKU wajib diverifikasi HMAC-SHA256 (Client-Id, Request-Id, Request-Timestamp, **Request-Target**, digest body) dan timestamp-nya dicek stale/replay **sebelum** diproses. Idempotency hanya mencegah duplikat; tanpa verifikasi signature, siapapun yang tahu URL webhook bisa memalsukan "top-up sukses"/"SPP lunas" — dan lebih buruk, forgery yang membawa idempotency key asli membuat callback DOKU yang sah di-drop sebagai duplikat.
  2. **WebhookInbox** — payload mentah + signature + status disimpan dulu (insert-first, tabel non-partisi, **key unik = key bisnis** seperti nomor invoice — bukan Request-Id, yang bisa berganti per retry), baru diproses jadi `JournalEntry`. Duplikat yang **sudah** diproses dijawab HTTP 200 ke DOKU; duplikat yang baris lamanya **belum** diproses (crash setelah insert) diproses ulang saat itu juga; plus re-processor internal menyapu baris menua yang belum berhasil — tanpa ini, crash di tengah = pembayaran sah hilang diam-diam padahal DOKU sudah berhenti me-retry. Payload mentah jadi bukti sengketa. Detail: AGENTS.md §5.1.
  3. **Idempotency internal** — job BullMQ bersifat at-least-once; setiap event internal yang menulis ke Ledger (denda, reversal) wajib membawa key deterministik (misal `fine:{loanId}:{tanggal}`), bukan hanya webhook eksternal.

**0.2 QrEngineModule**
Satu modul terpusat untuk generate & validasi semua QR/barcode, dengan kebijakan berbeda per `type`:

| Use case | Jenis kode | Masa berlaku & penyimpanan |
|---|---|---|
| Presensi gerbang & bayar kantin | Token dinamis (lookup Redis) | Short-lived (± 30 detik) **DAN single-use — dikonsumsi atomik saat validasi pertama (Redis `GETDEL`)** |
| Sirkulasi buku (Modul 3) | Barcode/ISBN statis | Tidak ada masa berlaku |
| Gate pass (Modul 8) | Token sekali pakai — **disimpan di PostgreSQL, bukan Redis** (umur panjang + butuh jejak audit; token tanpa TTL di Redis bisa hilang saat restart/eviction) | Invalid permanen setelah 1x scan, konsumsi (kapan/oleh siapa) tercatat di Audit Trail |

**Hardening v1.5:** TTL saja tidak cukup — token 30 detik yang tidak dikonsumsi bisa di-replay (scan dobel = debit dobel; QR anak yang difoto/di-screenshot jadi alat bayar 30 detik). Tambahan wajib: token dari CSPRNG ≥ 128 bit entropi; token terikat `studentId` + `type` **di namespace key Redis-nya** (`qr:{type}:{token}`) — scanner hanya membaca namespace type-nya sendiri, jadi token gerbang tidak bisa dipakai bayar DAN scan salah-type tidak ikut mengonsumsi token (dispatcher `/qr/validate` yang shared membuat type-confusion risiko nyata); endpoint `/qr/validate` hanya bisa dipanggil device scanner ter-autentikasi (role khusus), bukan endpoint publik.

Catatan: QR pembayaran kantin (§Modul 4) di-generate lewat QrEngineModule seperti biasa, lalu di baliknya memicu pembayaran internal Ledger — dua hal terpisah (QrEngineModule untuk identifikasi transaksi internal, QRIS DOKU hanya untuk rel top-up).

Endpoint `/qr/validate` men-decode payload, melihat `type`, lalu memanggil *event*/*service* modul terkait (pola Command/Query Handler).

### Modul 1: Yayasan & Unit Management
* **Master Data Yayasan:** Pengaturan profil yayasan, logo, dan struktur unit di bawahnya.
* **User & SSO Management:** Pendaftaran akun guru, staf, siswa, dan orang tua (relasi *Many-to-Many*).
* **Audit Trail:** Pencatatan log aktivitas kritis, bersifat **append-only** — tidak bisa diedit/dihapus siapapun termasuk Yayasan Admin. **Enforcement di level database, bukan hanya policy:** `REVOKE UPDATE, DELETE` pada tabel audit dari role aplikasi runtime (kode aplikasi tidak bisa menjanjikan append-only; database bisa). Kebijakan akses & retensi didefinisikan eksplisit.

### Modul 2: Academic Management (Akademik)
* **Master Data Akademik:** Kelas, Tingkat, Tahun Ajaran, Mata Pelajaran per unit.
* **Automated Timetabling:** v1 men-generate **draft jadwal semi-otomatis**, difinalisasi manual oleh TU; full constraint solver otomatis (setara combinatorial optimization problem) jadi item roadmap lanjutan.
* **Presensi Gerbang (harian):** Siswa scan token dinamis QrEngineModule di titik gerbang. Notifikasi ke orang tua saat siswa tercatat masuk/pulang.
* **Presensi Per-Jam Pelajaran (per periode):** Guru mengambil presensi tiap mata pelajaran/jam pelajaran, mencegah bolos pelajaran spesifik.
  1. Roster otomatis dari jadwal saat periode dimulai.
  2. Default "Hadir"; guru tap pengecualian (Sakit/Izin/Alpa).
  3. Submit — UI **offline-first** (simpan lokal, sync saat ada koneksi). **Conflict resolution**: submission pertama yang diterima server yang berlaku; kalau ada submission kedua untuk periode yang sama (misal dari guru piket dan wali kelas), sistem menampilkan prompt konfirmasi override, bukan menimpa otomatis secara diam-diam.
  4. Cross-check otomatis dengan Presensi Gerbang untuk mendeteksi bolos pelajaran spesifik.
  5. Notifikasi instan ke orang tua begitu ada Alpa di periode manapun.
* **CBT (Computer Based Test)** *(dipindah ke post-pilot — lihat §6)*: Bank soal, randomisasi soal, auto-grading. Safeguard: sesi terikat satu device, deteksi tab-switching (dicatat sebagai log untuk ditinjau guru), auto-submit saat waktu habis.
* **Digital Report Card (Rapor):** Perhitungan nilai otomatis, generate PDF massal via Queue (BullMQ). Template rapor **dapat dikonfigurasi per unit/jenjang** — SD, SMP, dan SMA punya format asesmen berbeda (misal SD lebih deskriptif/naratif untuk kelas rendah, ada komponen asesmen P5 berbasis proyek di Kurikulum Merdeka).

### Modul 3: Library Management (Perpustakaan)
* **Cataloging:** Manajemen buku per unit.
* **Circulation & Reservation:** Peminjaman/pengembalian via scan barcode ISBN statis (§0.2).
* **Automated Fines System:** Denda dihitung otomatis (BullMQ job tiap 00:00, **dengan idempotency key deterministik per denda** — job yang di-retry setelah partial failure tidak boleh mendenda dua kali), dicatat sebagai `JournalEntry` di Ledger Terpadu via outbox. Blokir peminjaman baru jika **saldo efektif** Ledger siswa negatif (§0.1 — bukan SUM mentah).

### Modul 4: Smart Canteen & Cashless System (Kantin)
* **E-Wallet Top-up:** Top-up via **DOKU — QRIS/e-wallet** (MDR persentase lebih murah untuk nominal kecil dibanding VA flat), lewat alur WebhookInbox + signature + idempotency (§0.1), tercatat sebagai journal kredit saldo siswa terhadap DOKU-Clearing.
* **Cashless Payment:** Scan QR dinamis single-use (§0.2), debit **sinkron** dalam satu transaksi database dengan row lock urutan deterministik (§0.1) — kasir butuh jawaban terima/tolak saat itu juga, alur ini pengecualian sah dari event contract (lihat §2).
* **Real-time Queueing System** *(dipindah ke post-pilot — lihat §6)*: Pre-order via Flutter, status antrian real-time via WebSocket di TV kantin dan HP siswa.
* **Canteen Vendor Portal:** Rekonsiliasi penjualan otomatis dari Ledger — dimungkinkan struktur multi-leg journal (pendapatan vendor vs fee yayasan terpisah per transaksi).

### Modul 5: Finance & Billing (Keuangan Yayasan)
* **Bill Generator:** Tagihan SPP, Sarpras, Kegiatan otomatis tiap bulan.
* **Payment Tracking:** Integrasi **Virtual Account via DOKU** (flat fee Rp4.000/transaksi — cocok untuk nominal SPP yang besar), status "Lunas" otomatis **hanya setelah callback lolos verifikasi signature**. Tentukan eksplisit: VA closed-amount (nominal pas) vs open-amount — "Lunas otomatis" diam-diam mengasumsikan pembayaran penuh persis; kebijakan pembayaran parsial/lebih harus diputuskan bersama DOKU (§8).
* **Aging Report & Penalty:** Blokir akses kantin/perpustakaan jika SPP telat > 30 hari.
* **Consolidated Payroll:** Penggajian guru & staf lintas unit.
* Rekonsiliasi lintas modul (SPP, kantin, denda) otomatis karena semua tercatat di Ledger yang sama — **termasuk rekonsiliasi settlement**: rekening koran vs akun DOKU-Clearing (§0.1), bukan hanya antar modul internal.

### Modul 6: HRIS (Manajemen Guru & Staf)
* **Leave Management, Performance Appraisal, Teaching Journal:** seperti semula.
* **Teacher Unit Conversion:** JP → "Equivalent Unit" untuk honor guru, rate **konfigurabel per mata pelajaran/jenjang**.

### Modul 7: Student Wellbeing (BK & UKS)
* **UKS/Clinic Logs:** Notifikasi instan ke aplikasi Orang Tua.
* **BK Case Management:** Proteksi akses level-field terpisah dari RBAC umum. **Mekanisme eksplisit (v1.5):** RLS itu row-level dan Prisma men-select semua kolom secara default — "field-level" tidak terjadi otomatis. Wajib: data BK/UKS di **tabel terpisah** yang dimiliki modul Wellbeing (satu-satunya exporter), DTO whitelist di semua read path, enkripsi kolom naratif konseling, dan **audit atas READ** (siapa melihat catatan konseling anak — untuk data sensitif anak, membaca sama layak-auditnya dengan menulis) masuk Audit Trail append-only.
* **Psychometric & Career Test:** Keputusan build vs integrasi provider tervalidasi masih perlu diselesaikan sebelum implementasi.

### Modul 8: Parent & Student Engagement (Mobile App Focus)
* **Parent Dashboard:** Rekap absensi (gerbang & per-periode), nilai, tagihan, riwayat UKS/BK. *Switch profile* multi-anak (lintas unit — lihat catatan §3).
* **Gate Pass Approval:** QR sekali-pakai (§0.2). **Jalur darurat:** jika orang tua tidak merespons dalam waktu tertentu, Perawat UKS/Wali Kelas override manual dengan konfirmasi telepon — approval digital dicatat menyusul.
* **Broadcast/Pengumuman + FAQ template** untuk wali kelas. *(Chat asinkron dua arah dipindah ke post-pilot — WhatsApp sudah menjadi kanal de-facto komunikasi orang tua; broadcast satu arah memberi 80% nilai dengan sebagian kecil usaha.)*

### Modul 9: Admissions CRM (PPDB) *(post-pilot — lihat §6)*
* **Online Registration & Selection:** Ranking otomatis — **kriteria dan bobot penilaian harus didefinisikan eksplisit oleh Yayasan** (nilai rapor vs tes vs wawancara, kuota per jalur) sebelum fitur ini dibangun.
* **Daftar Ulang:** Siswa yang diterima **otomatis ter-provision** akun siswa + orang tua di Modul Akademik. Pembayaran uang pangkal via DOKU VA, sama seperti alur SPP.

### Modul 10: Business Intelligence (Dashboard Analytics) *(post-pilot — lihat §6)*
* **Yayasan Consolidated Dashboard:** Query lintas unit berat sebaiknya bersumber dari read replica/materialized view begitu volume data membesar. Selama pilot, kebutuhan Yayasan Admin dilayani export SQL/spreadsheet.
* **Predictive Student Flag:** v1 menggunakan **rule-based scoring** yang **transparan dan bisa dijelaskan** — setiap flag harus bisa ditelusuri ke faktor konkret pemicunya (misal "X hari alpa dalam sebulan + rata-rata nilai turun Y poin"), bukan skor "black box" yang tidak bisa dipertanggungjawabkan ke orang tua/guru.

---

## 5. Non-Functional Requirements
1. **Security:**
   * Password di-hash menggunakan **Argon2id** (parameter minimum OWASP: m=19 MiB, t=2, p=1) — pilihan pertama OWASP saat ini; Bcrypt hanya untuk sistem legacy dan proyek ini greenfield. Bila ada dependensi yang memaksa bcrypt, wajib cost factor ≥ 12 dan penanganan eksplisit limit 72-byte.
   * **Rate limiting** pada endpoint login (ribuan akun siswa/orang tua = target credential stuffing) + lockout policy.
   * **MFA (TOTP) wajib** untuk role Yayasan Admin dan Bendahara — akun yang bisa lintas unit, menyetujui payroll, dan menyentuh Ledger.
   * Enforced Multi-Unit Isolation: **Prisma Client Extensions** (`$extends`) di level aplikasi.
   * **Defense-in-depth:** isolasi `unitId` juga di-enforce lewat **PostgreSQL Row-Level Security (RLS)** sebagai lapisan kedua. **Prasyarat agar lapisan ini benar-benar hidup (v1.5):** (a) koneksi runtime aplikasi memakai **role non-owner terpisah** dari role migrasi — PostgreSQL tidak menerapkan RLS ke table owner kecuali `FORCE ROW LEVEL SECURITY`; setup umum Prisma (satu `DATABASE_URL` untuk migrasi & runtime) membuat seluruh policy jadi no-op diam-diam; (b) `FORCE ROW LEVEL SECURITY` tetap dipasang di semua tabel ber-RLS sebagai sabuk pengaman; (c) role aplikasi tidak boleh superuser/`BYPASSRLS`; (d) **policy fail-closed**: GUC yang unset ATAU empty string (sisa transaksi lama di connection pooling) = **tolak semua baris** — kondisi itu berarti bug (query di luar wrapper context), dan justru di situ RLS harus menutup; akses cross-unit memakai **sentinel positif eksplisit** (`'__ALL__'`) yang hanya di-set guard endpoint konsolidasi, bukan cabang "NULL = boleh semua" yang membuat bug jadi akses penuh. Detail di AGENTS.md §4.2.
   * Data BK/UKS: akses dibatasi field-level dengan mekanisme eksplisit (§Modul 7), kepatuhan UU PDP.
   * **Kepatuhan UU PDP No. 27/2022 sebagai requirement desain, bukan asersi (v1.5):** data kesehatan (UKS), data anak secara umum, dan catatan konseling BK adalah data pribadi spesifik. Wajib didesain sebelum go-live: (a) model **consent** orang tua (capture + withdrawal) untuk pemrosesan data anak — notifikasi lokasi scan gerbang, foto, log kesehatan; (b) enkripsi at-rest untuk catatan BK/UKS; (c) foto siswa di S3/Cloudinary: bucket private + **presigned URL berumur pendek**, tidak pernah public; (d) runbook notifikasi breach 3×24 jam sesuai UU; (e) kebijakan retensi & **hak penghapusan** — arsip alumni (§5.4) bukan penghapusan.
   * Audit Trail append-only dengan enforcement level database (§Modul 1) dan kebijakan akses & retensi eksplisit.
2. **Performance:**
   * API Response time < 200ms.
   * WebSocket (Antrian Kantin, post-pilot) handle minimal 1000 koneksi konkuren, latency < 100ms.
3. **Scalability:**
   * Backend NestJS stateless, siap di-scale horizontal.
   * Job berat wajib menggunakan Queue.
   * Skema tabel volume tinggi menyertakan `tahunAjaran` sejak awal agar siap dipartisi RANGE bila diperlukan (lihat §2 Strategi Partitioning — partisi bukan requirement Phase 1).
4. **Backup & Data Retention:**
   * PITR (managed RDS/Aurora atau pgBackRest/WAL-G self-hosted).
   * Data alumni (>5 tahun) dipindahkan ke tabel/database arsip terpisah — berbeda dari read replica. **Catatan Ledger (v1.5):** sebelum memindahkan `JournalEntry`/`LedgerEntry` lama, wajib tulis **journal carry-forward saldo pembuka** per akun per tahun ajaran — tanpa ini, aturan "balance harus selalu bisa direkonstruksi dari transaksi" rusak begitu arsip pertama jalan.
5. **Reliability (UI Lapangan):**
   * UI Presensi Per-Jam Pelajaran wajib offline-first dengan conflict resolution eksplisit (lihat §Modul 2).

---

## 6. Development Phases & Milestones (Roadmap) — direkalibrasi v1.5

**Asumsi tim: 2–4 developer.** Roadmap 6-bulan v1.4 adalah urutan dependency yang benar tapi bukan jadwal — estimasi panel review: 2,5–3× terlalu optimis (Phase 1 lama saja ± satu kuartal kerja; Flutter app utuh tidak mungkin satu bulan; Phase 3 lama butuh Flutter yang baru dibangun Phase 5). Target baru: **MVP pilot SMP dalam 8–10 bulan**, scope dipangkas ke inti cash-flow + nilai yang terlihat orang tua. Fitur yang ditunda tidak dibatalkan — masuk backlog post-pilot.

### Phase 1: Foundation & Core (Bulan 1–3)
* Setup infra (Monorepo, Database, Redis). **Minggu 1: mulai onboarding merchant DOKU + akses sandbox** — KYC PJP berjalan mingguan di clock DOKU, bukan clock tim; modul billing dibangun terhadap interface gateway yang di-mock supaya tidak terblokir.
* Skema Prisma Multi-Unit Yayasan & Auth (JWT dengan membership list + active unit, RBAC via Client Extensions + RLS ter-hardening, SSO Orang Tua, Argon2id, rate limiting, MFA role finansial).
* **Ledger Terpadu (JournalEntry/LedgerEntry) + WebhookInbox + outbox + QrEngineModule** — termasuk test prioritas AGENTS.md §11 (race debit paralel, replay webhook & BullMQ, QR per-type, isolasi unit termasuk kasus GUC empty-string dan koneksi table-owner).
* Modul Master Data Akademik — termasuk UI jadwal semi-otomatis.
* Web Astro: Login & Manajemen Master Data.
* **Mulai Flutter app skeleton (auth, profil multi-anak)** — mobile adalah klien semua modul berikutnya, harus jalan paralel sejak awal, bukan fase terakhir.

### Phase 2: Keuangan & Perpustakaan (Bulan 3–5)
* Modul Keuangan & SPP — integrasi **DOKU Virtual Account** riil (signature, WebhookInbox, clearing account, settlement) begitu sandbox tersedia; kebijakan closed/open-amount VA diputuskan bersama DOKU.
* Modul Perpustakaan (Peminjaman + Denda via Ledger, job denda idempoten).

### Phase 3: Smart Canteen (Bulan 5–7)
* Modul Smart Canteen: E-Wallet via Ledger + **DOKU QRIS/e-wallet** top-up, pembayaran QR single-use sinkron, vendor portal dengan journal multi-leg.
* Flutter: fitur siswa (saldo, riwayat, QR bayar). *(Pre-order + antrian real-time WebSocket → post-pilot.)*

### Phase 4: Academic Process (Bulan 7–9)
* Modul Presensi Gerbang & Per-Jam Pelajaran (cross-check bolos, offline-first + conflict resolution — **subsistem terbesar fase ini, uji lapangan sejak awal**).
* Modul Rapor Digital (template per jenjang).
* Modul HRIS (Teacher Unit Conversion).
* Modul UKS: clinic logs + notifikasi orang tua (BK case management & psychometric tetap post-pilot — data yang ditampilkan Parent Dashboard "riwayat UKS" diproduksi fase ini).
* Flutter: fitur orang tua (rekap absensi, nilai, tagihan, riwayat UKS, gate pass + jalur darurat, broadcast, FCM).

### Phase 5: Stabilisasi & Pilot (Bulan 9–10)
* UAT terstruktur dengan guru, TU, satpam, orang tua (fitur lapangan: scan gerbang, roll call, gate pass).
* Rilis app store (siapkan 2–4 minggu kalender untuk review Play Store/App Store + signing).
* Go-live pilot di satu unit (SMP) — satu semester.

### Phase 6: Post-Pilot Backlog (setelah pilot stabil)
Urutan berdasarkan nilai bisnis, dibangun setelah pilot memvalidasi fondasi:
* **CBT + safeguard anti-cheating** (sekolah masih bisa ujian kertas/Google Form selama pilot; load spike ujian serentak butuh target load test yang belum ada — §8).
* **Pre-order kantin + antrian real-time WebSocket.**
* **In-app chat asinkron dua arah** (broadcast satu arah sudah jalan sejak Phase 4).
* **PPDB** (kriteria ranking didefinisikan dulu — §8) + auto-provisioning akun.
* **BK & Psychometric Test** (keputusan build vs buy — §8).
* **BI Dashboard** (predictive flag rule-based & explainable; read replica/materialized view).
* Rollout ke SD dan SMA.

### Strategi Rollout
* **Pilot bertahap:** sebelum full rollout ke semua jenjang, sistem di-pilot dulu di satu unit (SMP) selama satu semester, baru diperluas ke SD dan SMA setelah stabil.
* **UAT melibatkan pengguna non-teknis sejak awal:** guru, staf TU, satpam, dan orang tua dilibatkan dalam User Acceptance Testing sejak fase awal — banyak fitur (scan QR, roll call presensi, gate pass) dioperasikan langsung oleh mereka. **Alokasikan ± 20% kapasitas tiap fase untuk siklus feedback UAT** — tanpa alokasi eksplisit, tiap fase "selesai" akan dibuka lagi di fase berikutnya dan jadwal slip diam-diam.
* **Keputusan stakeholder yang murah tapi makan kalender (kejar di Bulan 1–2):** kriteria ranking PPDB dan build-vs-buy psychometric — keduanya post-pilot, tapi jawabannya butuh rapat yayasan, bukan jam developer.

---

## 7. Future Considerations (Belum Termasuk Scope Saat Ini)
* **Inventory & Asset Management** — ruang kelas, alat peraga, laptop lab.
* **Calendar & Event Management** — terintegrasi dengan UTS, UAS, ekstrakurikuler, rapat guru.
* **Document Management** — arsip RPP, SK, ijazah digital.

---

## 8. Belum Diputuskan / Perlu Diverifikasi
* Build vs integrasi provider psychometric test pihak ketiga (Modul 7).
* Target load test spesifik untuk Smart Canteen (butuh proyeksi jumlah siswa riil per unit) — dan untuk CBT (satu angkatan submit serentak) sebelum fitur itu dibangun post-pilot.
* Integrasi Dapodik/SIAKAD (tergantung apakah Yayasan berpartisipasi BOS/Dapodik).
* Kriteria & bobot ranking PPDB (harus didefinisikan Yayasan).
* Jadwal settlement resmi DOKU untuk Virtual Account, **spesifikasi lengkap signature & format webhook/callback** (header, algoritme digest, semantik retry), dan kebijakan **VA closed-amount vs open-amount** (pembayaran parsial/lebih) — konfirmasi langsung ke tim DOKU di Bulan 1, sebelum integrasi Phase 2.
* **Baru (v1.5):** kebijakan refund QRIS/VA (jendela waktu & aturan per kanal berbeda) — perlu keputusan bisnis kapan refund diizinkan (salah top-up, SPP dobel bayar) dan pemetaan `refType: REFUND` ke alur DOKU.
* **Baru (v1.5):** apakah laporan settlement DOKU menyediakan breakdown per transaksi/invoice (dibutuhkan untuk memecah settlement batch lintas jenjang ke jurnal per unit — kalau tidak ada, seluruh settlement dicatat di unit YAYASAN saja).
* **Baru (v1.5):** parental consent & kebijakan retensi untuk proctoring CBT (webcam/screenshot) — prasyarat rule #6 AGENTS.md; CBT sendiri post-pilot, tapi keputusan ini butuh rapat yayasan, bukan jam developer.
