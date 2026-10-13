/**
 * 片库相关查询：films（全局缓存）、film_aliases（外部条目 → TMDB）、watch_log / watchlist（按用户隔离）。
 */
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, notInArray, or, sql, type SQL } from 'drizzle-orm'
import { getDb, tx } from '../client'
import {
  filmAliases,
  films,
  watchLog,
  watchlist,
  type Film,
  type FilmAlias,
  type MatchCandidate,
} from '../schema'
import { nowIso } from '@/lib/time'

type FilmInsert = typeof films.$inferInsert
type Provider = FilmAlias['provider']

// ───────────────────────────── films ─────────────────────────────

export function getFilm(tmdbId: number): Film | undefined {
  return getDb().select().from(films).where(eq(films.tmdbId, tmdbId)).get()
}

export function getFilms(ids: readonly number[]): Film[] {
  if (!ids.length) return []
  const out: Film[] = []
  for (let i = 0; i < ids.length; i += 500) {
    out.push(...getDb().select().from(films).where(inArray(films.tmdbId, ids.slice(i, i + 500))).all())
  }
  return out
}

/** 只有搜索结果时的占位行；已存在则不动（富化会整体覆盖）。 */
export function insertFilmStub(f: Pick<FilmInsert, 'tmdbId' | 'titleEn' | 'originalTitle'> & Partial<FilmInsert>): void {
  getDb()
    .insert(films)
    .values({ ...f, enrichedAt: null })
    .onConflictDoNothing({ target: films.tmdbId })
    .run()
}

/** 富化结果整体写入。 */
export function upsertFilm(f: FilmInsert): void {
  const { tmdbId: _id, createdAt: _c, ...rest } = f
  getDb()
    .insert(films)
    .values(f)
    .onConflictDoUpdate({ target: films.tmdbId, set: { ...rest, updatedAt: nowIso() } })
    .run()
}

// ───────────────────────────── aliases ─────────────────────────────

export function getAlias(id: number): FilmAlias | undefined {
  return getDb().select().from(filmAliases).where(eq(filmAliases.id, id)).get()
}

export function upsertAlias(input: {
  provider: Provider
  externalId: string
  titleRaw: string
  yearRaw?: number | null
  imdbIdRaw?: string | null
}): FilmAlias {
  const db = getDb()
  const existing = db
    .select()
    .from(filmAliases)
    .where(and(eq(filmAliases.provider, input.provider), eq(filmAliases.externalId, input.externalId)))
    .get()
  if (existing) {
    // 标题 / 年份可能在来源侧被修正；已解析的不重置匹配状态
    const patch: Partial<typeof filmAliases.$inferInsert> = {}
    if (existing.titleRaw !== input.titleRaw) patch.titleRaw = input.titleRaw
    if ((input.yearRaw ?? null) !== existing.yearRaw && input.yearRaw != null) patch.yearRaw = input.yearRaw
    if (input.imdbIdRaw && input.imdbIdRaw !== existing.imdbIdRaw) patch.imdbIdRaw = input.imdbIdRaw
    if (!Object.keys(patch).length) return existing
    return db.update(filmAliases).set(patch).where(eq(filmAliases.id, existing.id)).returning().get()
  }
  return db
    .insert(filmAliases)
    .values({
      provider: input.provider,
      externalId: input.externalId,
      titleRaw: input.titleRaw,
      yearRaw: input.yearRaw ?? null,
      imdbIdRaw: input.imdbIdRaw ?? null,
    })
    .returning()
    .get()
}

export function setAliasMatch(
  aliasId: number,
  m: {
    status: FilmAlias['matchStatus']
    tmdbId: number | null
    confidence: number | null
    candidates: MatchCandidate[] | null
  },
): void {
  const db = getDb()
  tx(() => {
    db.update(filmAliases)
      .set({ matchStatus: m.status, tmdbId: m.tmdbId, matchConfidence: m.confidence, candidates: m.candidates })
      .where(eq(filmAliases.id, aliasId))
      .run()
    // 回填冗余的 tmdb_id
    db.update(watchLog).set({ tmdbId: m.tmdbId }).where(eq(watchLog.aliasId, aliasId)).run()
    db.update(watchlist).set({ tmdbId: m.tmdbId }).where(eq(watchlist.aliasId, aliasId)).run()
  })
}

/** 用户条目引用到、且尚未解析（pending）的 alias。 */
export function pendingAliasesForUser(userId: string): FilmAlias[] {
  const db = getDb()
  const fromLog = db.select({ id: watchLog.aliasId }).from(watchLog).where(eq(watchLog.userId, userId))
  const fromList = db.select({ id: watchlist.aliasId }).from(watchlist).where(eq(watchlist.userId, userId))
  return db
    .select()
    .from(filmAliases)
    .where(
      and(
        eq(filmAliases.matchStatus, 'pending'),
        or(inArray(filmAliases.id, fromLog), inArray(filmAliases.id, fromList)),
      ),
    )
    .orderBy(asc(filmAliases.id))
    .all()
}

/** 用户引用到的 alias 中，需要人工处理的（ambiguous / unmatched）。 */
export function unresolvedAliasesForUser(userId: string): (FilmAlias & { watched: boolean })[] {
  const db = getDb()
  const fromLog = db.select({ id: watchLog.aliasId }).from(watchLog).where(eq(watchLog.userId, userId))
  const fromList = db.select({ id: watchlist.aliasId }).from(watchlist).where(eq(watchlist.userId, userId))
  const rows = db
    .select()
    .from(filmAliases)
    .where(
      and(
        inArray(filmAliases.matchStatus, ['ambiguous', 'unmatched']),
        or(inArray(filmAliases.id, fromLog), inArray(filmAliases.id, fromList)),
      ),
    )
    .orderBy(asc(filmAliases.matchStatus), asc(filmAliases.titleRaw))
    .all()
  const watchedIds = new Set(
    db
      .select({ id: watchLog.aliasId })
      .from(watchLog)
      .where(and(eq(watchLog.userId, userId), inArray(watchLog.aliasId, rows.map((r) => r.id).length ? rows.map((r) => r.id) : [-1])))
      .all()
      .map((r) => r.id),
  )
  return rows.map((r) => ({ ...r, watched: watchedIds.has(r.id) }))
}

export function userReferencesAlias(userId: string, aliasId: number): boolean {
  const db = getDb()
  return Boolean(
    db.select({ id: watchLog.id }).from(watchLog).where(and(eq(watchLog.userId, userId), eq(watchLog.aliasId, aliasId))).get() ??
      db.select({ id: watchlist.id }).from(watchlist).where(and(eq(watchlist.userId, userId), eq(watchlist.aliasId, aliasId))).get(),
  )
}

// ───────────────────────────── watch_log / watchlist ─────────────────────────────

export type WatchEntryInput = {
  userId: string
  sourceId: string | null
  aliasId: number
  tmdbId: number | null
  provider: (typeof watchLog.$inferInsert)['provider']
  externalEntryId: string
  watchedAt?: string | null
  loggedAt?: string | null
  rating10?: number | null
  liked?: boolean
  rewatch?: boolean
  reviewText?: string | null
  tags?: string[]
  raw?: unknown
}

export function upsertWatchEntry(e: WatchEntryInput): void {
  const values = {
    userId: e.userId,
    sourceId: e.sourceId,
    aliasId: e.aliasId,
    tmdbId: e.tmdbId,
    provider: e.provider,
    externalEntryId: e.externalEntryId,
    watchedAt: e.watchedAt ?? null,
    loggedAt: e.loggedAt ?? null,
    rating10: e.rating10 ?? null,
    liked: e.liked ?? false,
    rewatch: e.rewatch ?? false,
    reviewText: e.reviewText ?? null,
    tags: e.tags ?? [],
    raw: e.raw ?? null,
  }
  const { userId: _u, provider: _p, externalEntryId: _x, ...set } = values
  getDb()
    .insert(watchLog)
    .values(values)
    .onConflictDoUpdate({
      target: [watchLog.userId, watchLog.provider, watchLog.externalEntryId],
      set: { ...set, updatedAt: nowIso() },
    })
    .run()
}

export function upsertWatchlistEntry(e: {
  userId: string
  sourceId: string | null
  aliasId: number
  tmdbId: number | null
  provider: (typeof watchlist.$inferInsert)['provider']
  addedAt?: string | null
}): void {
  getDb()
    .insert(watchlist)
    .values({ ...e, addedAt: e.addedAt ?? null })
    .onConflictDoUpdate({
      target: [watchlist.userId, watchlist.aliasId],
      set: { sourceId: e.sourceId, tmdbId: e.tmdbId, addedAt: e.addedAt ?? null, updatedAt: nowIso() },
    })
    .run()
}

/** 是否已有同一次观看（同 tmdb_id + 同观看日期，但来自另一条记录）——RSS 与 ZIP 去重用。 */
export function hasOtherViewing(userId: string, tmdbId: number, watchedAt: string, externalEntryId: string): boolean {
  return Boolean(
    getDb()
      .select({ id: watchLog.id })
      .from(watchLog)
      .where(
        and(
          eq(watchLog.userId, userId),
          eq(watchLog.tmdbId, tmdbId),
          eq(watchLog.watchedAt, watchedAt),
          sql`${watchLog.externalEntryId} <> ${externalEntryId}`,
        ),
      )
      .get(),
  )
}

/** 全量同步后清理：该来源下本次没再出现的条目（用户在来源侧删除了）。 */
export function pruneSourceEntries(sourceId: string, keepLogEntryIds: string[], keepListAliasIds: number[]): { log: number; list: number } {
  const db = getDb()
  const logWhere: SQL[] = [eq(watchLog.sourceId, sourceId)]
  if (keepLogEntryIds.length) logWhere.push(notInArray(watchLog.externalEntryId, keepLogEntryIds))
  const listWhere: SQL[] = [eq(watchlist.sourceId, sourceId)]
  if (keepListAliasIds.length) listWhere.push(notInArray(watchlist.aliasId, keepListAliasIds))
  const log = db.delete(watchLog).where(and(...logWhere)).run().changes
  const list = db.delete(watchlist).where(and(...listWhere)).run().changes
  return { log, list }
}

/** 用户已看过的全部 tmdb_id（P5：候选片不得在其中）。 */
export function seenTmdbIds(userId: string): Set<number> {
  return new Set(
    getDb()
      .selectDistinct({ id: watchLog.tmdbId })
      .from(watchLog)
      .where(and(eq(watchLog.userId, userId), isNotNull(watchLog.tmdbId)))
      .all()
      .map((r) => r.id!),
  )
}

export function watchlistTmdbIds(userId: string): Set<number> {
  return new Set(
    getDb()
      .selectDistinct({ id: watchlist.tmdbId })
      .from(watchlist)
      .where(and(eq(watchlist.userId, userId), isNotNull(watchlist.tmdbId)))
      .all()
      .map((r) => r.id!),
  )
}

/** 需要富化的片：用户引用到、且 enriched_at 为空或早于 staleBefore。 */
export function filmsNeedingEnrichment(userId: string, staleBefore: string): number[] {
  const db = getDb()
  const ids = db
    .selectDistinct({ id: watchLog.tmdbId })
    .from(watchLog)
    .where(and(eq(watchLog.userId, userId), isNotNull(watchLog.tmdbId)))
    .union(
      db
        .selectDistinct({ id: watchlist.tmdbId })
        .from(watchlist)
        .where(and(eq(watchlist.userId, userId), isNotNull(watchlist.tmdbId))),
    )
    .all()
    .map((r) => r.id!)
  if (!ids.length) return []
  const out: number[] = []
  for (let i = 0; i < ids.length; i += 500) {
    out.push(
      ...db
        .select({ id: films.tmdbId })
        .from(films)
        .where(and(inArray(films.tmdbId, ids.slice(i, i + 500)), or(isNull(films.enrichedAt), lt(films.enrichedAt, staleBefore))))
        .all()
        .map((r) => r.id),
    )
  }
  return out.sort((a, b) => a - b)
}

// ───────────────────────────── /library 列表 ─────────────────────────────

export type LibraryRow = {
  aliasId: number
  tmdbId: number | null
  title: string
  titleZh: string | null
  originalTitle: string | null
  year: number | null
  directors: string[]
  countries: string[]
  runtimeMin: number | null
  posterPath: string | null
  matchStatus: FilmAlias['matchStatus']
  providers: string[]
  views: number
  lastWatched: string | null
  rating10: number | null
  liked: boolean
  rewatched: boolean
}

export type LibraryQuery = {
  q?: string
  minRating?: number
  yearFrom?: number
  yearTo?: number
  limit?: number
  offset?: number
}

/**
 * 观影记录（按片聚合：同一 tmdb_id 跨来源合并；未匹配的按 alias）。
 */
export function listLibrary(userId: string, query: LibraryQuery = {}): { rows: LibraryRow[]; total: number } {
  const db = getDb()
  const filmKey = sql<string>`coalesce('t' || ${watchLog.tmdbId}, 'a' || ${watchLog.aliasId})`
  const where: SQL[] = [eq(watchLog.userId, userId)]
  if (query.q) {
    const like = `%${query.q.toLowerCase()}%`
    where.push(
      sql`(lower(${filmAliases.titleRaw}) like ${like} or lower(coalesce(${films.titleEn}, '')) like ${like}
           or lower(coalesce(${films.titleZh}, '')) like ${like} or lower(coalesce(${films.originalTitle}, '')) like ${like})`,
    )
  }
  if (query.yearFrom) where.push(gte(sql`coalesce(${films.year}, ${filmAliases.yearRaw})`, query.yearFrom))
  if (query.yearTo) where.push(lte(sql`coalesce(${films.year}, ${filmAliases.yearRaw})`, query.yearTo))

  const ratingAgg = sql<number | null>`(select w2.rating10 from ${watchLog} w2
      where w2.user_id = ${userId} and coalesce('t' || w2.tmdb_id, 'a' || w2.alias_id) = ${filmKey}
        and w2.rating10 is not null
      order by coalesce(w2.watched_at, w2.logged_at, '') desc, w2.id desc limit 1)`
  const having = query.minRating ? sql`${ratingAgg} >= ${query.minRating}` : undefined

  const base = db
    .select({
      key: filmKey,
      aliasId: sql<number>`min(${watchLog.aliasId})`,
      tmdbId: watchLog.tmdbId,
      titleRaw: sql<string>`min(${filmAliases.titleRaw})`,
      yearRaw: sql<number | null>`min(${filmAliases.yearRaw})`,
      matchStatus: sql<FilmAlias['matchStatus']>`min(${filmAliases.matchStatus})`,
      providers: sql<string>`group_concat(distinct ${watchLog.provider})`,
      views: sql<number>`max(1, count(distinct ${watchLog.watchedAt}))`,
      lastWatched: sql<string | null>`max(coalesce(${watchLog.watchedAt}, ${watchLog.loggedAt}))`,
      rating10: ratingAgg,
      liked: sql<number>`max(${watchLog.liked})`,
      rewatched: sql<number>`max(${watchLog.rewatch})`,
    })
    .from(watchLog)
    .innerJoin(filmAliases, eq(filmAliases.id, watchLog.aliasId))
    .leftJoin(films, eq(films.tmdbId, watchLog.tmdbId))
    .where(and(...where))
    .groupBy(filmKey)
    .having(having)

  const total = db.$with('lib').as(base)
  const totalRow = db.with(total).select({ n: sql<number>`count(*)` }).from(total).get()

  const rows = base
    .orderBy(desc(sql`max(coalesce(${watchLog.watchedAt}, ${watchLog.loggedAt}, ''))`), asc(sql`min(${filmAliases.titleRaw})`))
    .limit(query.limit ?? 100)
    .offset(query.offset ?? 0)
    .all()

  const filmMap = new Map(getFilms(rows.map((r) => r.tmdbId).filter((x): x is number => x != null)).map((f) => [f.tmdbId, f]))
  return {
    total: totalRow?.n ?? 0,
    rows: rows.map((r) => {
      const f = r.tmdbId != null ? filmMap.get(r.tmdbId) : undefined
      return {
        aliasId: r.aliasId,
        tmdbId: r.tmdbId,
        title: f?.titleEn ?? r.titleRaw,
        titleZh: f?.titleZh ?? null,
        originalTitle: f?.originalTitle ?? null,
        year: f?.year ?? r.yearRaw,
        directors: (f?.directors ?? []).map((d) => d.name),
        countries: f?.countries ?? [],
        runtimeMin: f?.runtimeMin ?? null,
        posterPath: f?.posterPath ?? null,
        matchStatus: r.matchStatus,
        providers: r.providers.split(','),
        views: r.views,
        lastWatched: r.lastWatched,
        rating10: r.rating10,
        liked: Boolean(r.liked),
        rewatched: Boolean(r.rewatched),
      }
    }),
  }
}

export function libraryCounts(userId: string): { entries: number; films: number; unresolved: number; watchlist: number } {
  const db = getDb()
  const entries = db.select({ n: sql<number>`count(*)` }).from(watchLog).where(eq(watchLog.userId, userId)).get()?.n ?? 0
  const filmsN =
    db
      .select({ n: sql<number>`count(distinct coalesce('t' || ${watchLog.tmdbId}, 'a' || ${watchLog.aliasId}))` })
      .from(watchLog)
      .where(eq(watchLog.userId, userId))
      .get()?.n ?? 0
  const wl = db.select({ n: sql<number>`count(*)` }).from(watchlist).where(eq(watchlist.userId, userId)).get()?.n ?? 0
  return { entries, films: filmsN, unresolved: unresolvedAliasesForUser(userId).length, watchlist: wl }
}

/** 匹配率：用户引用到的 alias 中已 matched/confirmed 的比例。 */
export function matchStats(userId: string): Record<FilmAlias['matchStatus'], number> {
  const db = getDb()
  const ids = db.selectDistinct({ id: watchLog.aliasId }).from(watchLog).where(eq(watchLog.userId, userId))
  const rows = db
    .select({ s: filmAliases.matchStatus, n: sql<number>`count(*)` })
    .from(filmAliases)
    .where(inArray(filmAliases.id, ids))
    .groupBy(filmAliases.matchStatus)
    .all()
  const out = { pending: 0, matched: 0, ambiguous: 0, unmatched: 0, confirmed: 0 }
  for (const r of rows) out[r.s] = r.n
  return out
}
