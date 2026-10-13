import { z } from 'zod'

const flag = z
  .string()
  .optional()
  .transform((v) => v === '1' || v === 'true')

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  DATABASE_URL: z.string().default('file:./data/fest.db'),
  AUTH_SECRET: z.string().optional(),
  AUTH_GOOGLE_ID: z.string().optional(),
  AUTH_GOOGLE_SECRET: z.string().optional(),
  DEV_LOGIN: flag,
  ANTHROPIC_API_KEY: z.string().optional(),
  LLM_ENABLE_FALLBACKS: flag,
  TMDB_READ_TOKEN: z.string().optional(),
  APP_ENCRYPTION_KEY: z.string().optional(),
  APP_BASE_URL: z.string().default('http://localhost:3000'),
})

export type Env = z.infer<typeof EnvSchema>

let cached: Env | undefined

/** 读取并校验环境变量（惰性，便于测试里改 process.env 后 resetEnv()）。 */
export function env(): Env {
  if (!cached) cached = EnvSchema.parse(process.env)
  return cached
}

export function resetEnv(): void {
  cached = undefined
}

export function requireEnv<K extends keyof Env>(key: K): NonNullable<Env[K]> {
  const v = env()[key]
  if (v === undefined || v === null || v === '') {
    throw new Error(`Missing required env ${String(key)}`)
  }
  return v as NonNullable<Env[K]>
}
