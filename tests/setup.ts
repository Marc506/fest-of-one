import { beforeEach } from 'vitest'
import { closeDb, getDb } from '@/db/client'
import { runMigrations } from '@/db/migrate'
import { resetEnv } from '@/lib/env'

process.env.DATABASE_URL = ':memory:'
// 测试里绝不打真实外部 API
delete process.env.ANTHROPIC_API_KEY
delete process.env.TMDB_READ_TOKEN

/** 每个测试一个全新的内存库。 */
beforeEach(() => {
  closeDb()
  resetEnv()
  runMigrations(getDb())
})
