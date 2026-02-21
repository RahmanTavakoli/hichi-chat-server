import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().regex(/^\d+$/).transform(Number).default('4000' as never),
  MONGO_URI: z.string().url(),
  JWT_SECRET: z.string(),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_SECRET: z.string(),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),
  COOKIE_SECRET: z.string().min(32),
  ALLOWED_ORIGINS: z.string().transform((val) => val.split(',')),
  // In-memory store limits
  MSG_STORE_MAX_ROOMS: z.string().transform(Number).default('500' as never),
  MSG_STORE_MAX_PER_ROOM: z.string().transform(Number).default('200' as never),
  MSG_STORE_TTL_MS: z.string().transform(Number).default('3600000' as never), // 1hr
});

const _parsed = EnvSchema.safeParse(process.env);

if (!_parsed.success) {
  console.error('❌ Invalid environment variables:\n', _parsed.error.format());
  process.exit(1);
}

export const env = _parsed.data;
export type Env = z.infer<typeof EnvSchema>;