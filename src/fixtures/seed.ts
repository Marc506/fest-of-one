/**
 * fixture 画像落库（M3 的 3 个合成画像 + 离线片目）。幂等：重复执行只会更新。
 * 片目数据来自 tests/fixtures/catalog，仅用于测试与离线开发。
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { and, eq, like } from 'drizzle-orm'
import { getDb, tx } from '@/db/client'
import { setAliasMatch, upsertAlias, upsertFilm, upsertWatchEntry, upsertWatchlistEntry } from '@/db/repo/library'
import { updateUserSettings, upsertUserByEmail } from '@/db/repo/users'
import { watchLog, watchlist, type User } from '@/db/schema'
import { detailsToFilm } from '@/resolver/enrich'
import { CatalogTmdbClient, type CatalogFilm } from '@/resolver/tmdb'
import { FILMS } from '../../tests/fixtures/catalog/films'
import { PERSONAS } from '../../tests/fixtures/catalog/personas'
import type { Persona } from '../../tests/fixtures/catalog/build'

export { PERSONAS }

export const FIXTURE_CATALOG_PATH = resolve('data/fixtures/catalog.json')

export function catalogFilms(): CatalogFilm[] {
  return FILMS
}

export function writeCatalogJson(path = FIXTURE_CATALOG_PATH): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(FILMS))
  return path
}

export function fixtureClient(): CatalogTmdbClient {
  return new CatalogTmdbClient(FILMS)
}

/** 片目全部写进 films（已富化），省去离线运行时的逐部富化。 */
export async function seedCatalogFilms(client = fixtureClient()): Promise<number> {
  let n = 0
  for (const f of FILMS) {
    const en = await client.getMovie(f.tmdb_id, 'en-US')
    const zh = await client.getMovie(f.tmdb_id, 'zh-CN')
    if (en) {
      upsertFilm(detailsToFilm(en, zh))
      n++
    }
  }
  return n
}

export function personaEmail(key: string) {
  return `${key}@fixture.local`
}

export function seedPersona(p: Persona): User {
  const user = upsertUserByEmail(personaEmail(p.key), p.name)
  updateUserSettings(user.id, { locale: p.locale })
  const db = getDb()
  const byId = new Map(FILMS.map((f) => [f.tmdb_id, f]))
  tx(() => {
    db.delete(watchLog).where(and(eq(watchLog.userId, user.id), like(watchLog.externalEntryId, 'fixture:%'))).run()
    db.delete(watchlist).where(eq(watchlist.userId, user.id)).run()
    const aliasFor = (id: number) => {
      const f = byId.get(id)!
      const alias = upsertAlias({ provider: 'manual', externalId: `tmdb:${id}`, titleRaw: f.title_en, yearRaw: f.year })
      if (alias.matchStatus !== 'confirmed') setAliasMatch(alias.id, { status: 'confirmed', tmdbId: id, confidence: 1, candidates: null })
      return alias
    }
    for (const [id, rating, flags, date] of p.log) {
      const alias = aliasFor(id)
      upsertWatchEntry({
        userId: user.id,
        sourceId: null,
        aliasId: alias.id,
        tmdbId: id,
        provider: 'manual',
        externalEntryId: `fixture:${id}`,
        watchedAt: date,
        loggedAt: date,
        rating10: rating,
        liked: flags.includes('L'),
        rewatch: flags.includes('R'),
      })
    }
    for (const id of p.watchlist) {
      const alias = aliasFor(id)
      upsertWatchlistEntry({ userId: user.id, sourceId: null, aliasId: alias.id, tmdbId: id, provider: 'manual' })
    }
  })
  return user
}
