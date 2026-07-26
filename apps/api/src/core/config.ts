import { z } from 'zod';

// AGENTS.md §4.7 — validasi schema saat startup; fail-fast kalau env bolong.
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  MIGRATOR_DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  JWT_SECRET: z.string().min(16),
  DOKU_CLIENT_ID: z.string().default(''),
  DOKU_SECRET_KEY: z.string().default(''),
  PORT: z.coerce.number().default(3000),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(raw: Record<string, unknown>): Env {
  return envSchema.parse(raw);
}
