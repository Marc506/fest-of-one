/**
 * 离线开发用 fixture：把 446 部离线片目写进 films，并写出 data/fixtures/catalog.json（供 TMDB_FIXTURE_CATALOG）；
 * 建 3 个 fixture 画像用户；可选把某个画像的观影记录复制给一个已有用户（例如 dev@local）。
 *
 *   pnpm tsx scripts/seed-fixtures.ts                         片目 + 3 个 fixture 用户
 *   pnpm tsx scripts/seed-fixtures.ts --as dev@local --persona slow
 *
 * 之后：TMDB_FIXTURE_CATALOG=data/fixtures/catalog.json LLM_TRANSPORT=mock pnpm dev / pnpm worker
 */
import '@/lib/load-env'
import { parseArgs } from 'node:util'
import { runMigrations } from '@/db/migrate'
import { upsertUserByEmail } from '@/db/repo/users'
import { getDb } from '@/db/client'
import { users } from '@/db/schema'
import { eq } from 'drizzle-orm'
import { PERSONAS, personaEmail, seedCatalogFilms, seedPersona, writeCatalogJson } from '@/fixtures/seed'

const { values } = parseArgs({ options: { as: { type: 'string' }, persona: { type: 'string', default: 'slow' } } })

async function main() {
  runMigrations()
  const path = writeCatalogJson()
  console.log(`catalog → ${path}`)
  console.log(`films: ${await seedCatalogFilms()}`)
  for (const p of PERSONAS) {
    const u = seedPersona(p)
    console.log(`persona ${p.key} → ${u.email} (${u.id})`)
  }
  if (values.as) {
    const p = PERSONAS.find((x) => x.key === values.persona)
    if (!p) throw new Error(`unknown persona ${values.persona}`)
    // 先确保目标用户存在，再把 persona 的记录写到它名下
    const target = upsertUserByEmail(values.as)
    const tmp = { ...p, key: '__tmp__' }
    const seeded = seedPersona(tmp)
    // seedPersona 按 email 建用户；这里把临时用户的数据迁到目标用户
    const db = getDb()
    const sqlite = (db as unknown as { $client: import('better-sqlite3').Database }).$client
    sqlite.prepare('delete from watch_log where user_id = ? and external_entry_id like ?').run(target.id, 'fixture:%')
    sqlite.prepare('delete from watchlist where user_id = ?').run(target.id)
    sqlite.prepare('update watch_log set user_id = ? where user_id = ?').run(target.id, seeded.id)
    sqlite.prepare('update watchlist set user_id = ? where user_id = ?').run(target.id, seeded.id)
    db.delete(users).where(eq(users.email, personaEmail('__tmp__'))).run()
    console.log(`copied persona ${p.key} log → ${target.email}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
