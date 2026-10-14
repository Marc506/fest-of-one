/**
 * Resolver（5.4）：外部条目 → TMDB。
 *
 *   1. alias.tmdb_id 已有（RSS）          → matched 1.0（在同步时直接写入）
 *   2. imdb_id 已有                        → TMDB find → matched 0.98
 *   3. search/movie → 对前 10 个候选打分：
 *        score = 0.6·titleSim + 0.25·yearMatch + 0.15·min(1, ln(vote_count+1)/10)
 *      ≥ 0.85 且领先第二名 ≥ 0.1 → matched；0.6–0.85 或差距小 → ambiguous；< 0.6 → unmatched
 *   4. 用户手工选择 → confirmed（永不自动覆盖）
 *
 * 豆瓣导出没有年份、混着剧集（M7 之后补充）：
 *   - 候选按「最晚一次看过的年份 + 1」截断：不可能看过还没上映的片
 *   - 没对上时取前 3 个候选的 TMDB 别名 / 各语言译名重新打分（港台译名、旧译名）；标题比较前繁转简
 *   - 没有年份时，候选里只有一部标题完全一致（且没有同名剧集）→ 视为匹配
 *   - 标题带「第 N 季」，或 TMDB 剧集库里有同名剧而电影库里没有 → not_film（不进待确认）
 */
import type { FilmAlias, MatchCandidate } from '@/db/schema'
import { fillAliasRaw, insertFilmStub, setAliasMatch } from '@/db/repo/library'
import { ensureFilm } from './enrich'
import { isCjk, splitAltTitles, titleSim } from './normalize'
import { yearOf, type TmdbClient, type TmdbLang, type TmdbMovieSummary, type TmdbTvSummary } from './tmdb'
import type { DoubanHint } from './wikidata'

export const MATCH_THRESHOLD = 0.85
export const MATCH_MARGIN = 0.1
export const AMBIGUOUS_THRESHOLD = 0.6

export type PoolEntry = TmdbMovieSummary & { title_en?: string; title_zh?: string; aka?: string[] }

/** 精确同名的阈值（规范化后完全相同 = 1；去冠词相同 = 0.98） */
export const EXACT_TITLE = 0.98
/** 「第 N 季」「Season N」：豆瓣剧集条目的标题后缀 */
export const SEASON_RE = /第\s*[一二三四五六七八九十百\d]+\s*季|\bseason\s*\d+\b/i

export type ResolveHints = {
  /** 最晚一次「看过」的年份（豆瓣：标记日期）。候选上映年份不能晚于它 + 1（电影节首映 / 日期误差的宽限）。 */
  watchedYearMax?: number | null
  /** 豆瓣条目在 Wikidata 上的编号（有就不用模糊匹配） */
  wikidata?: DoubanHint
}

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
  const titles = [e.title, e.original_title, e.title_en ?? '', e.title_zh ?? '', ...(e.aka ?? [])].filter(Boolean)
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

export function withinYearBound<T extends { release_date?: string | null; first_air_date?: string | null }>(xs: T[], watchedYearMax: number | null | undefined): T[] {
  if (!watchedYearMax) return xs
  return xs.filter((x) => {
    const y = yearOf(x.release_date ?? x.first_air_date ?? null)
    return y == null || y <= watchedYearMax + 1
  })
}

/** 前 3 个标题不够像的候选，补上 TMDB 别名 / 译名后重新打分。 */
async function addAltTitles(client: TmdbClient, queries: string[], year: number | null | undefined, pool: PoolEntry[]): Promise<boolean> {
  const top = pool
    .map((e) => scoreCandidate(queries, year, e))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .filter((s) => s.titleSim < 0.95)
  if (!top.length) return false
  const akas = await Promise.all(top.map((s) => client.movieAltTitles(s.entry.id)))
  top.forEach((s, i) => (s.entry.aka = akas[i]))
  return true
}

/** 年份未知时：候选里恰好一部标题完全一致、其余都明显不像 → 采信它。 */
export function uniqueExactTitle(scored: Scored[]): Scored | null {
  const exact = scored.filter((s) => s.titleSim >= EXACT_TITLE)
  if (exact.length !== 1) return null
  return scored.some((s) => s !== exact[0] && s.titleSim >= 0.9) ? null : exact[0]!
}

/** 剧集库里与标题最像的一部（同样受观看年份约束）。 */
async function bestTvMatch(client: TmdbClient, queries: string[], watchedYearMax: number | null | undefined) {
  let best: { tv: TmdbTvSummary; sim: number } | null = null
  for (const q of queries) {
    const lang: TmdbLang = isCjk(q) ? 'zh-CN' : 'en-US'
    const rs = withinYearBound(await client.searchTv(q, { language: lang }), watchedYearMax).slice(0, 5)
    for (const tv of rs) {
      const sim = Math.max(titleSim(q, tv.name), titleSim(q, tv.original_name))
      if (!best || sim > best.sim || (sim === best.sim && tv.vote_count > best.tv.vote_count)) best = { tv, sim }
    }
  }
  return best
}

function markNotFilm(alias: FilmAlias, candidates: MatchCandidate[]): ResolveResult {
  setAliasMatch(alias.id, { status: 'not_film', tmdbId: null, confidence: null, candidates })
  return { status: 'not_film', tmdbId: null, confidence: null }
}

/** 解析一个 alias 并落库（含回填 watch_log / watchlist 的 tmdb_id）。 */
export async function resolveAlias(alias: FilmAlias, client: TmdbClient, hints: ResolveHints = {}): Promise<ResolveResult> {
  if (alias.matchStatus === 'confirmed') return { status: 'confirmed', tmdbId: alias.tmdbId, confidence: 1 }
  const wd = hints.wikidata
  if (wd?.tmdbMovie && !alias.tmdbId) {
    const film = await ensureFilm(client, wd.tmdbMovie)
    if (film) {
      setAliasMatch(alias.id, { status: 'matched', tmdbId: film.tmdbId, confidence: 0.99, candidates: null })
      return { status: 'matched', tmdbId: film.tmdbId, confidence: 0.99 }
    }
  }
  if (wd?.tv && !alias.tmdbId) return markNotFilm(alias, [])
  if (wd && ((wd.year && !alias.yearRaw) || (wd.imdb && !alias.imdbIdRaw))) {
    fillAliasRaw(alias.id, { yearRaw: wd.year, imdbIdRaw: wd.imdb })
    alias = { ...alias, yearRaw: alias.yearRaw ?? wd.year ?? null, imdbIdRaw: alias.imdbIdRaw ?? wd.imdb ?? null }
  }
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
  const douban = alias.provider === 'douban'
  if (douban && queries.some((q) => SEASON_RE.test(q))) return markNotFilm(alias, [])

  const pool = withinYearBound(await searchPool(client, queries, alias.yearRaw), hints.watchedYearMax)
  const rescore = () => pool.map((e) => scoreCandidate(queries, alias.yearRaw, e))
  let d = decide(rescore())
  if (d.status !== 'matched' && pool.length && (await addAltTitles(client, queries, alias.yearRaw, pool))) d = decide(rescore())

  // 豆瓣没有年份：先看剧集库，再考虑「唯一同名」
  if (douban && !alias.yearRaw) {
    const tv = await bestTvMatch(client, queries, hints.watchedYearMax)
    if (tv && tv.sim >= EXACT_TITLE) {
      const film = rescore().sort((a, b) => b.titleSim - a.titleSim || b.entry.vote_count - a.entry.vote_count)[0]
      const filmVotes = film && film.titleSim >= EXACT_TITLE ? film.entry.vote_count : -1
      // 电影库里没有同名片，或同名剧的热度远高于同名片 → 剧集
      if (filmVotes < 0 || tv.tv.vote_count > 3 * filmVotes + 5) return markNotFilm(alias, d.candidates)
      // 同名的电影和剧热度相当：交给用户（待确认里有「不是电影」按钮）
      if (!(filmVotes > 3 * tv.tv.vote_count + 5)) {
        if (d.best) d = { status: 'ambiguous', best: d.best, candidates: d.candidates }
        return persist(alias, d)
      }
    }
    if (d.status !== 'matched') {
      const unique = uniqueExactTitle(rescore())
      if (unique) d = { status: 'matched', best: unique, candidates: d.candidates }
    }
  }
  return persist(alias, d)
}

function persist(alias: FilmAlias, d: Decision): ResolveResult {
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
