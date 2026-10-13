/**
 * Resolver（5.4）：外部条目 → TMDB。
 *
 *   1. alias.tmdb_id 已有（RSS）          → matched 1.0（在同步时直接写入）
 *   2. imdb_id 已有                        → TMDB find → matched 0.98
 *   3. search/movie → 对前 10 个候选打分：
 *        score = 0.6·titleSim + 0.25·yearMatch + 0.15·min(1, ln(vote_count+1)/10)
 *      ≥ 0.85 且领先第二名 ≥ 0.1 → matched；0.6–0.85 或差距小 → ambiguous；< 0.6 → unmatched
 *   4. 用户手工选择 → confirmed（永不自动覆盖）
 */
import type { FilmAlias, MatchCandidate } from '@/db/schema'
import { insertFilmStub, setAliasMatch } from '@/db/repo/library'
import { isCjk, splitAltTitles, titleSim } from './normalize'
import { yearOf, type TmdbClient, type TmdbLang, type TmdbMovieSummary } from './tmdb'

export const MATCH_THRESHOLD = 0.85
export const MATCH_MARGIN = 0.1
export const AMBIGUOUS_THRESHOLD = 0.6

export type PoolEntry = TmdbMovieSummary & { title_en?: string; title_zh?: string }

export type Scored = { entry: PoolEntry; score: number; titleSim: number; yearMatch: number }

export function yearMatchScore(queryYear: number | null | undefined, candidateYear: number | null): number {
  if (!queryYear || !candidateYear) return 0
  const d = Math.abs(queryYear - candidateYear)
  return d === 0 ? 1 : d === 1 ? 0.6 : 0
}

export function popularityScore(voteCount: number): number {
  return Math.min(1, Math.log(Math.max(0, voteCount) + 1) / 10)
}

/**
 * 打分。年份未知时（部分豆瓣条目），年份权重按比例分给标题与热度，否则永远到不了 0.85。
 */
export function scoreCandidate(queries: string[], year: number | null | undefined, e: PoolEntry): Scored {
  const titles = [e.title, e.original_title, e.title_en ?? '', e.title_zh ?? ''].filter(Boolean)
  const ts = Math.max(0, ...queries.flatMap((q) => titles.map((t) => titleSim(q, t))))
  const ym = yearMatchScore(year, yearOf(e.release_date))
  const pop = popularityScore(e.vote_count)
  const score = year ? 0.6 * ts + 0.25 * ym + 0.15 * pop : (0.6 * ts + 0.15 * pop) / 0.75
  return { entry: e, score: round3(score), titleSim: round3(ts), yearMatch: ym }
}

function round3(n: number) {
  return Math.round(n * 1000) / 1000
}

export type Decision =
  | { status: 'matched'; best: Scored; candidates: MatchCandidate[] }
  | { status: 'ambiguous'; best: Scored; candidates: MatchCandidate[] }
  | { status: 'unmatched'; best: Scored | null; candidates: MatchCandidate[] }

export function decide(scored: Scored[]): Decision {
  const sorted = [...scored].sort((a, b) => b.score - a.score || b.entry.vote_count - a.entry.vote_count)
  const candidates: MatchCandidate[] = sorted.slice(0, 5).map((s) => ({
    tmdb_id: s.entry.id,
    title: s.entry.title_en ?? s.entry.title,
    year: yearOf(s.entry.release_date),
    score: s.score,
    original_title: s.entry.original_title,
    vote_count: s.entry.vote_count,
  }))
  const best = sorted[0]
  if (!best) return { status: 'unmatched', best: null, candidates }
  const second = sorted[1]?.score ?? 0
  if (best.score >= MATCH_THRESHOLD && best.score - second >= MATCH_MARGIN) return { status: 'matched', best, candidates }
  if (best.score >= AMBIGUOUS_THRESHOLD) return { status: 'ambiguous', best, candidates }
  return { status: 'unmatched', best, candidates }
}

/** 搜索候选池：每个标题按语言搜一次（带年份）；不够好再不带年份搜一次。按 tmdb_id 合并，取前 10。 */
export async function searchPool(client: TmdbClient, queries: string[], year: number | null): Promise<PoolEntry[]> {
  const pool = new Map<number, PoolEntry>()
  const add = (rs: TmdbMovieSummary[], lang: TmdbLang) => {
    for (const r of rs.slice(0, 10)) {
      const cur = pool.get(r.id) ?? { ...r }
      if (lang === 'zh-CN') cur.title_zh = r.title
      else cur.title_en = r.title
      pool.set(r.id, cur)
    }
  }
  for (const q of queries) {
    const lang: TmdbLang = isCjk(q) ? 'zh-CN' : 'en-US'
    add(await client.searchMovie(q, { year, language: lang }), lang)
    const best = Math.max(0, ...[...pool.values()].map((e) => scoreCandidate(queries, year, e).score))
    if (year && best < MATCH_THRESHOLD) add(await client.searchMovie(q, { language: lang }), lang)
  }
  return [...pool.values()]
}

function stubFromSummary(e: PoolEntry) {
  return {
    tmdbId: e.id,
    titleEn: e.title_en ?? (isCjk(e.title) ? e.original_title : e.title),
    titleZh: e.title_zh ?? null,
    originalTitle: e.original_title,
    year: yearOf(e.release_date),
    releaseDate: e.release_date || null,
    posterPath: e.poster_path,
    voteAvg: e.vote_average,
    voteCount: e.vote_count,
    popularity: e.popularity,
  }
}

export type ResolveResult = { status: FilmAlias['matchStatus']; tmdbId: number | null; confidence: number | null }

/** 解析一个 alias 并落库（含回填 watch_log / watchlist 的 tmdb_id）。 */
export async function resolveAlias(alias: FilmAlias, client: TmdbClient): Promise<ResolveResult> {
  if (alias.matchStatus === 'confirmed') return { status: 'confirmed', tmdbId: alias.tmdbId, confidence: 1 }
  if (alias.tmdbId) {
    setAliasMatch(alias.id, { status: 'matched', tmdbId: alias.tmdbId, confidence: 1, candidates: null })
    return { status: 'matched', tmdbId: alias.tmdbId, confidence: 1 }
  }
  if (alias.imdbIdRaw) {
    const hit = await client.findByImdb(alias.imdbIdRaw)
    if (hit) {
      insertFilmStub(stubFromSummary(hit))
      setAliasMatch(alias.id, { status: 'matched', tmdbId: hit.id, confidence: 0.98, candidates: null })
      return { status: 'matched', tmdbId: hit.id, confidence: 0.98 }
    }
  }
  const queries = splitAltTitles(alias.titleRaw)
  const pool = await searchPool(client, queries, alias.yearRaw)
  const d = decide(pool.map((e) => scoreCandidate(queries, alias.yearRaw, e)))
  if (d.status === 'matched') {
    insertFilmStub(stubFromSummary(d.best.entry))
    setAliasMatch(alias.id, { status: 'matched', tmdbId: d.best.entry.id, confidence: d.best.score, candidates: null })
    return { status: 'matched', tmdbId: d.best.entry.id, confidence: d.best.score }
  }
  setAliasMatch(alias.id, {
    status: d.status,
    tmdbId: null,
    confidence: d.best?.score ?? null,
    candidates: d.candidates,
  })
  return { status: d.status, tmdbId: null, confidence: d.best?.score ?? null }
}
