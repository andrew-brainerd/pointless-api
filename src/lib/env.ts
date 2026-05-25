import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(5003),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  MONGO_URI: z.string().url().default('mongodb://localhost:27017'),
  MONGO_DB_NAME: z.string().min(1).default('pointless'),
  CORS_ALLOWLIST: z.string().default('http://localhost:5173'),
  FRONTEND_URL: z.string().url().default('http://localhost:5173'),
  GOOGLE_APPLICATION_CREDENTIALS: z.string().optional(),
  PUSHER_APP_ID: z.string().optional(),
  PUSHER_KEY: z.string().optional(),
  PUSHER_SECRET: z.string().optional(),
  PUSHER_CLUSTER: z.string().optional(),
  SENDGRID_API_KEY: z.string().optional(),
  SENDGRID_FROM_EMAIL: z.string().email().optional(),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

export const loadEnv = (): Env => {
  if (cached) return cached;
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues.map(i => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  cached = result.data;
  return cached;
};

export const corsOrigins = (env: Env): string[] =>
  env.CORS_ALLOWLIST.split(',')
    .map(o => o.trim())
    .filter(Boolean);
