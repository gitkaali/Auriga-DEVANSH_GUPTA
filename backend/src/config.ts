import 'dotenv/config';
import { z } from 'zod';

const configSchema = z.object({
  DATABASE_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32),
  CORS_ORIGIN: z.string().url(),
  PORT: z.coerce.number().int().positive().default(3000),
  ESCALATION_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  CODESPACE_NAME: z.string().trim().min(1).optional(),
  GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: z.string().trim().min(1).default('app.github.dev'),
}).superRefine((value, context) => {
  if (value.NODE_ENV === 'production' && (value.SESSION_SECRET.includes('development') || value.SESSION_SECRET.length < 64)) {
    context.addIssue({ code: 'custom', path: ['SESSION_SECRET'], message: 'Production SESSION_SECRET must be a random value of at least 64 characters' });
  }
});

export const config = configSchema.parse(process.env);
