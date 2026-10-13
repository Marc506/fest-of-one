/**
 * 把用户的 watch_log / watchlist 聚合成「每部片一行」的视图（同一 tmdb_id 跨来源合并）。
 * 统计层与序列化共用；输出顺序确定（tmdb_id 升序，未匹配的排最后按标题）。
 */
import { and, asc, eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { getFilms } from '@/db/repo/library'
import { filmAliases, watchLog, watchlist, type Film } from '@/db/schema'

export type ViewerFilm = {
  key: string
  tmdbId: number | null
  title: string
  year: number | null
  directors: string[]
  countries: string[]
  /** 最近一条有评分的记录的评分 */
  rating10: number | null
  liked: boolean
  rewatch: boolean
  views: number
  /** YYYY-MM-DD（watched_at，缺失时退回 logged_at） */
  lastWatched: string | null
  film: Film | null
}

export type WatchlistFilm = { key: string; tmdbId: number | null; title: string; year: number | null; directors: string[]; film: Film | null }

export function loadViewerFilms(userId: string): ViewerFilm[] {
  const db = getDb()
  const rows = db
    .select({
      id: watchLog.id,
      aliasId: watchLog.aliasId,
      tmdbId: watchLog.tmdbId,
      watchedAt: watchLog.watchedAt,
      loggedAt: watchLog.loggedAt,
      rating10: watchLog.rating10,
      liked: watchLog.liked,
      rewatch: watchLog.rewatch,
      titleRaw: filmAliases.titleRaw,
      yearRaw: filmAliases.yearRaw,
    })
    .from(watchLog)
    .innerJoin(filmAliases, eq(filmAliases.id, watchLog.aliasId))
    .where(eq(watchLog.userId, userId))
    .orderBy(asc(watchLog.id))
    .all()

  const films = new Map(getFilms([...new Set(rows.map((r) => r.tmdbId).filter((x): x is number => x != null))]).map((f) => [f.tmdbId, f]))
  const groups = new Map<string, typeof rows>()
  for (const r of rows) {
    const key = r.tmdbId != null ? `t${r.tmdbId}` : `a${r.aliasId}`
    const g = groups.get(key) ?? []
    g.push(r)
    groups.set(key, g)
  }

  const out: ViewerFilm[] = []
  for (const [key, g] of groups) {
    const when = (r: (typeof rows)[number]) => r.watchedAt ?? r.loggedAt ?? ''
    const sorted = [...g].sort((a, b) => when(b).localeCompare(when(a)) || b.id - a.id)
    const rated = sorted.find((r) => r.rating10 != null)
    const first = sorted[0]!
    const film = first.tmdbId != null ? (films.get(first.tmdbId) ?? null) : null
    const dated = sorted.map((r) => r.watchedAt ?? r.loggedAt).filter((d): d is string => Boolean(d))
    out.push({
      key,
      tmdbId: first.tmdbId,
      title: film?.titleEn ?? first.titleRaw,
      year: film?.year ?? first.yearRaw,
      directors: (film?.directors ?? []).map((d) => d.name),
      countries: film?.countries ?? [],
      rating10: rated?.rating10 ?? null,
      liked: g.some((r) => r.liked),
      rewatch: g.some((r) => r.rewatch),
      // 不同来源（ZIP / RSS / 豆瓣）可能各有一行同一次观看：按「不同的观看日期」计数
      views: Math.max(1, new Set(g.map((r) => r.watchedAt).filter(Boolean)).size),
      lastWatched: dated[0] ?? null,
      film,
    })
  }
  return sortViewerFilms(out)
}

export function sortViewerFilms<T extends { tmdbId: number | null; title: string; year: number | null; key: string }>(xs: T[]): T[] {
  return xs.sort((a, b) => {
    if (a.tmdbId != null && b.tmdbId != null) return a.tmdbId - b.tmdbId
    if (a.tmdbId != null) return -1
    if (b.tmdbId != null) return 1
    return a.title.localeCompare(b.title) || (a.year ?? 0) - (b.year ?? 0) || a.key.localeCompare(b.key)
  })
}

export function loadWatchlist(userId: string): WatchlistFilm[] {
  const db = getDb()
  const rows = db
    .select({ aliasId: watchlist.aliasId, tmdbId: watchlist.tmdbId, titleRaw: filmAliases.titleRaw, yearRaw: filmAliases.yearRaw })
    .from(watchlist)
    .innerJoin(filmAliases, eq(filmAliases.id, watchlist.aliasId))
    .where(and(eq(watchlist.userId, userId)))
    .all()
  const films = new Map(getFilms([...new Set(rows.map((r) => r.tmdbId).filter((x): x is number => x != null))]).map((f) => [f.tmdbId, f]))
  const seen = new Set<string>()
  const out: WatchlistFilm[] = []
  for (const r of rows) {
    const key = r.tmdbId != null ? `t${r.tmdbId}` : `a${r.aliasId}`
    if (seen.has(key)) continue
    seen.add(key)
    const film = r.tmdbId != null ? (films.get(r.tmdbId) ?? null) : null
    out.push({
      key,
      tmdbId: r.tmdbId,
      title: film?.titleEn ?? r.titleRaw,
      year: film?.year ?? r.yearRaw,
      directors: (film?.directors ?? []).map((d) => d.name),
      film,
    })
  }
  return sortViewerFilms(out)
}
