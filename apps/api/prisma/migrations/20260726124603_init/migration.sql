-- CreateEnum
CREATE TYPE "UnitType" AS ENUM ('SD', 'SMP', 'SMA', 'YAYASAN');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('YAYASAN_ADMIN', 'UNIT_ADMIN', 'TEACHER', 'STUDENT', 'PARENT', 'STAFF', 'SCANNER');

-- CreateEnum
CREATE TYPE "JournalSource" AS ENUM ('DOKU_VA', 'DOKU_QRIS', 'DOKU_SETTLEMENT', 'INTERNAL');

-- CreateEnum
CREATE TYPE "JournalRefType" AS ENUM ('LIBRARY_FINE', 'CANTEEN_PAYMENT', 'SPP_PAYMENT', 'TOPUP', 'REVERSAL', 'SETTLEMENT', 'FEE', 'REFUND', 'OPENING_BALANCE', 'MANUAL_ADJUSTMENT');

-- CreateEnum
CREATE TYPE "AccountOwnerType" AS ENUM ('STUDENT', 'INTERNAL');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED');

-- CreateEnum
CREATE TYPE "GatePassStatus" AS ENUM ('ISSUED', 'CONSUMED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Unit" (
    "id" UUID NOT NULL,
    "type" "UnitType" NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Unit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnitMembership" (
    "userId" UUID NOT NULL,
    "unitId" UUID NOT NULL,

    CONSTRAINT "UnitMembership_pkey" PRIMARY KEY ("userId","unitId")
);

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "ownerType" "AccountOwnerType" NOT NULL,
    "ownerId" UUID,
    "accountCode" TEXT,
    "label" TEXT NOT NULL,
    "balance" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "source" "JournalSource" NOT NULL,
    "refType" "JournalRefType" NOT NULL,
    "refId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "reversalOfJournalId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" UUID NOT NULL,
    "journalId" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookInbox" (
    "id" UUID NOT NULL,
    "channel" "JournalSource" NOT NULL,
    "businessKey" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "signature" TEXT NOT NULL,
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "journalId" UUID,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "WebhookInbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatePass" (
    "id" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "studentId" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "status" "GatePassStatus" NOT NULL DEFAULT 'ISSUED',
    "issuedBy" UUID NOT NULL,
    "issuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMP(3),
    "consumedBy" UUID,

    CONSTRAINT "GatePass_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "UnitMembership_unitId_idx" ON "UnitMembership"("unitId");

-- CreateIndex
CREATE INDEX "LedgerAccount_unitId_idx" ON "LedgerAccount"("unitId");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_unitId_ownerType_ownerId_key" ON "LedgerAccount"("unitId", "ownerType", "ownerId");

-- CreateIndex
CREATE INDEX "JournalEntry_unitId_createdAt_idx" ON "JournalEntry"("unitId", "createdAt");

-- CreateIndex
CREATE INDEX "JournalEntry_refType_refId_idx" ON "JournalEntry"("refType", "refId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_source_idempotencyKey_key" ON "JournalEntry"("source", "idempotencyKey");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_createdAt_idx" ON "LedgerEntry"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "LedgerEntry_unitId_createdAt_idx" ON "LedgerEntry"("unitId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookInbox_status_receivedAt_idx" ON "WebhookInbox"("status", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookInbox_channel_businessKey_key" ON "WebhookInbox"("channel", "businessKey");

-- CreateIndex
CREATE INDEX "OutboxEvent_publishedAt_createdAt_idx" ON "OutboxEvent"("publishedAt", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "GatePass_token_key" ON "GatePass"("token");

-- CreateIndex
CREATE INDEX "GatePass_unitId_status_idx" ON "GatePass"("unitId", "status");

-- AddForeignKey
ALTER TABLE "UnitMembership" ADD CONSTRAINT "UnitMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnitMembership" ADD CONSTRAINT "UnitMembership_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversalOfJournalId_fkey" FOREIGN KEY ("reversalOfJournalId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================
-- HAND-EDITED (AGENTS.md §4.2, §4.8, §5.1) — jangan regenerate blind.
-- ============================================================

-- CHECK: kaki journal tidak boleh nol; SET NULL FK reversal dilarang efeknya
ALTER TABLE "LedgerEntry" ADD CONSTRAINT ledger_entry_amount_nonzero CHECK ("amount" <> 0);
ALTER TABLE "JournalEntry" DROP CONSTRAINT "JournalEntry_reversalOfJournalId_fkey";
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversalOfJournalId_fkey"
  FOREIGN KEY ("reversalOfJournalId") REFERENCES "JournalEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Partial unique: akun INTERNAL diidentifikasi accountCode, bukan label bebas.
-- @@unique([unitId, ownerType, ownerId]) TIDAK melindungi (unit, INTERNAL, NULL) — NULL distinct.
CREATE UNIQUE INDEX ledger_account_internal_code
  ON "LedgerAccount"("unitId", "accountCode") WHERE "ownerType" = 'INTERNAL';
ALTER TABLE "LedgerAccount" ADD CONSTRAINT ledger_account_code_iff_internal
  CHECK (("ownerType" = 'INTERNAL') = ("accountCode" IS NOT NULL));

-- Zero-sum per journal + kaki >= 2, dicek saat COMMIT (deferred) —
-- menangkap penulis bypass ($executeRaw) saat tulis, bukan saat reconciliation.
CREATE OR REPLACE FUNCTION check_journal_balanced() RETURNS trigger AS $$
DECLARE
  s NUMERIC;
  n INTEGER;
  jid UUID;
BEGIN
  jid := COALESCE(NEW."journalId", OLD."journalId");
  SELECT COALESCE(SUM("amount"), 0), COUNT(*) INTO s, n
    FROM "LedgerEntry" WHERE "journalId" = jid;
  IF s <> 0 THEN
    RAISE EXCEPTION 'Journal % tidak balance: SUM(amount) = %', jid, s;
  END IF;
  IF n < 2 THEN
    RAISE EXCEPTION 'Journal % punya % kaki — minimal 2', jid, n;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_zero_sum
  AFTER INSERT ON "LedgerEntry"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION check_journal_balanced();

-- Append-only di level DB (rule §7.2): role app tidak bisa UPDATE/DELETE tabel finansial.
REVOKE UPDATE, DELETE ON "JournalEntry" FROM eos_app;
REVOKE UPDATE, DELETE ON "LedgerEntry" FROM eos_app;
-- (LedgerAccount tetap boleh UPDATE — kolom balance adalah cache yang di-update in-transaction.)

-- RLS fail-closed (§4.2): GUC unset/'' = DENY; cross-unit = sentinel '__ALL__'.
-- FORCE agar owner (eos_migrator) pun tunduk untuk DML.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['LedgerAccount','JournalEntry','LedgerEntry','GatePass','UnitMembership'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

CREATE POLICY unit_isolation ON "LedgerAccount"
  USING ("unitId"::text = current_setting('app.current_unit_id', true)
         OR current_setting('app.current_unit_id', true) = '__ALL__');
CREATE POLICY unit_isolation ON "JournalEntry"
  USING ("unitId"::text = current_setting('app.current_unit_id', true)
         OR current_setting('app.current_unit_id', true) = '__ALL__');
CREATE POLICY unit_isolation ON "LedgerEntry"
  USING ("unitId"::text = current_setting('app.current_unit_id', true)
         OR current_setting('app.current_unit_id', true) = '__ALL__');
CREATE POLICY unit_isolation ON "GatePass"
  USING ("unitId"::text = current_setting('app.current_unit_id', true)
         OR current_setting('app.current_unit_id', true) = '__ALL__');
CREATE POLICY unit_isolation ON "UnitMembership"
  USING ("unitId"::text = current_setting('app.current_unit_id', true)
         OR current_setting('app.current_unit_id', true) = '__ALL__');

-- WebhookInbox & OutboxEvent: infrastruktur sistem (worker __ALL__), tanpa unitId — tidak ber-RLS.
-- User/Unit: master data global (login perlu lookup lintas unit) — isolasi di level query/guard.
