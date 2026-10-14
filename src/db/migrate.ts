import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import nextEnv from '@next/env'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { getDb, resolveDbPath, type DB } from './client'

export const MIGRATIONS_FOLDER = resolve(process.cwd(), 'drizzle')

export function runMigrations(db: DB = getDb()): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  nextEnv.loadEnvConfig(process.cwd(), process.env.NODE_ENV !== 'production')
  runMigrations()
  console.log(`[db] migrated ${resolveDbPath()}`)
}
