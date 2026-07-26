-- Role split AGENTS.md §4.2 poin 4: migrator = owner, app = runtime non-owner.
-- Jalankan sekali sebagai superuser (postgres) setelah container up.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'eos_migrator') THEN
    CREATE ROLE eos_migrator LOGIN PASSWORD 'eos_migrator_dev';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'eos_app') THEN
    CREATE ROLE eos_app LOGIN PASSWORD 'eos_app_dev' NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;

ALTER DATABASE eos OWNER TO eos_migrator;
GRANT ALL ON SCHEMA public TO eos_migrator;
ALTER SCHEMA public OWNER TO eos_migrator;

-- eos_app: DML dasar; REVOKE spesifik (JournalEntry/LedgerEntry/AuditLog UPDATE,DELETE)
-- terjadi di migration setelah tabel ada.
GRANT USAGE ON SCHEMA public TO eos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE eos_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO eos_app;
ALTER DEFAULT PRIVILEGES FOR ROLE eos_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO eos_app;
