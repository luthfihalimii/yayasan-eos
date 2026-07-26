import { z } from 'zod';

// AGENTS.md §4.7 — validasi schema saat startup; fail-fast kalau env bolong.
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  MIGRATOR_DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(16),
  DOKU_CLIENT_ID: z.string().default(''),
  DOKU_SECRET_KEY: z.string().default(''),
  APP_ENCRYPTION_KEY: z.string().min(16),
  WEB_URL: z.string().url().default('http://127.0.0.1:4321'),
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().default(465),
  SMTP_USER: z.string().default(''),
  SMTP_PASS: z.string().default(''),
  SMTP_FROM: z.string().default('Yayasan EOS <noreply@trigunabhakti.or.id>'),
  TURNSTILE_SECRET_KEY: z.string().default(''),
  PORT: z.coerce.number().default(3000),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  return envSchema.parse(raw);
}
