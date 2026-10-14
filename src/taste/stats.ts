/**
 * 统计层 TasteStats（6.1）——纯代码、确定性（同样的输入 + now 得到同样的输出）。
 *
 * register 三项是近似指标（仅作参考）：
 * - high_popularity：TMDB vote_count ≥ 4000（拿不到「该年 popularity 分位」时的代理）
 * - festival_core：vote_count < 1500 且非美国出品，或 vote_count < 800 的剧情片
 *
 * 近期权重（recency.ts）：每部片带一个 0–1 的权重。导演 / 演员按 Σw ×（加权均分）排序，
 * 国别 / 类型 / 语言 / 关键词按 Σw 排序；`n`、`avg10` 仍是原始计数与原始均分（事实），`w` 是折算后的有效部数。
 * 关闭时 w 恒为 1，排序与原来一致。
 */
import { recencyAnchor, recencyWeight, RECENCY_PRESETS, type RecencyLevelT } from './recency'
import type { TasteStatsT } from './types'
import type { ViewerFilm } from './viewer'

export const HIGH_POP_VOTES = 4000

const round = (n: number, d = 2) => Math.round(n * 10 ** d) / 10 ** d

type Acc = { n: number; sum: number; rated: number; liked: number; evidence: number[]; w: number; wsum: number; wrated: number }
const acc = (): Acc => ({ n: 0, sum: 0, rated: 0, liked: 0, evidence: [], w: 0, wsum: 0, wrated: 0 })

function add(m: Map<string, Acc>, key: string, f: ViewerFilm, w: number) {
  const a = m.get(key) ?? acc()
  a.n++
  a.w += w
  if (f.rating10 != null) {
    a.sum += f.rating10
    a.rated++
    a.wsum += w * f.rating10
    a.wrated += w
  }
  if (f.liked) a.liked++
  if (f.tmdbId != null) a.evidence.push(f.tmdbId)
  m.set(key, a)
}

const avg = (a: Acc) => (a.rated ? round(a.sum / a.rated) : null)
/** Σw ×（加权均分）排序；没有评分的按 5.5（中性）计。权重全为 1 时即原来的 n·avg。 */
const score = (a: Acc) => a.w * (a.wrated ? a.wsum / a.wrated : 5.5)

function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]!
}

export function computeTasteStats(films: ViewerFilm[], now: Date = new Date(), opts: { recency?: RecencyLevelT } = {}): TasteStatsT {
  const recency = opts.recency ?? 'off'
  const anchor = recencyAnchor(films)
  const day = 86400_000
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10)
  const d90 = iso(now.getTime() - 90 * day)
  const d180 = iso(now.getTime() - 180 * day)

  const directors = new Map<string, Acc>()
  const countries = new Map<string, Acc>()
  const decades = new Map<string, Acc>()
  const genres = new Map<string, Acc>()
  const languages = new Map<string, Acc>()
  const actors = new Map<string, Acc>()
  const keywords = new Map<string, Acc>()
  const ratingDist: Record<string, number> = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [String(i + 1), 0]))

  let rated = 0
  let liked = 0
  let rewatched = 0
  let last90 = 0
  let last180 = 0
  const runtimes: number[] = []
  let highPop = 0
  let highPopSum = 0
  let highPopRated = 0
  let festivalCore = 0
  let matched = 0

  for (const f of films) {
    if (f.rating10 != null) {
      rated++
      ratingDist[String(f.rating10)] = (ratingDist[String(f.rating10)] ?? 0) + 1
    }
    if (f.liked) liked++
    if (f.rewatch || f.views > 1) rewatched++
    if (f.lastWatched && f.lastWatched >= d90) last90++
    if (f.lastWatched && f.lastWatched >= d180) last180++
    const film = f.film
    if (!film) continue
    matched++
    const w = recencyWeight(f, anchor, recency)
    for (const d of film.directors) add(directors, d.name, f, w)
    for (const c of film.countries) add(countries, c, f, w)
    if (film.year) add(decades, String(Math.floor(film.year / 10) * 10), f, w)
    for (const g of film.genres) add(genres, g, f, w)
    if (film.languages[0]) add(languages, film.languages[0], f, w)
    // 只算主演（前 5 位），避免配角刷量
    for (const c of film.castTop.filter((c) => c.order < 5)) add(actors, c.name, f, w)
    for (const k of film.keywords) add(keywords, k, f, w)
    if (film.runtimeMin) runtimes.push(film.runtimeMin)
    const votes = film.voteCount ?? 0
    if (votes >= HIGH_POP_VOTES) {
      highPop++
      if (f.rating10 != null) {
        highPopSum += f.rating10
        highPopRated++
      }
    }
    if ((votes < 1500 && !film.countries.includes('US')) || (votes < 800 && film.genres.includes('Drama'))) festivalCore++
  }

  const ranked = (m: Map<string, Acc>, minN: number, limit: number) =>
    [...m.entries()].filter(([, a]) => a.n >= minN).sort((x, y) => score(y[1]) - score(x[1]) || y[1].n - x[1].n || x[0].localeCompare(y[0])).slice(0, limit)
  const byCount = (m: Map<string, Acc>) => [...m.entries()].sort((x, y) => y[1].w - x[1].w || y[1].n - x[1].n || x[0].localeCompare(y[0]))
  const ew = (a: Acc) => round(a.w, 1)

  return {
    counts: { films: films.length, rated, liked, rewatched, last90d: last90 },
    rating_dist: ratingDist,
    directors: ranked(directors, 2, 40).map(([name, a]) => ({
      name,
      n: a.n,
      w: ew(a),
      avg10: avg(a),
      liked: a.liked,
      evidence: [...a.evidence].sort((x, y) => x - y),
    })),
    countries: byCount(countries).map(([code, a]) => ({ code, n: a.n, w: ew(a), avg10: avg(a) })),
    decades: [...decades.entries()].sort((x, y) => Number(x[0]) - Number(y[0])).map(([d, a]) => ({ decade: Number(d), n: a.n, w: ew(a), avg10: avg(a) })),
    genres: byCount(genres).map(([name, a]) => ({ name, n: a.n, w: ew(a), avg10: avg(a) })),
    languages: byCount(languages).map(([code, a]) => ({ code, n: a.n, w: ew(a) })),
    actors: ranked(actors, 3, 40).map(([name, a]) => ({ name, n: a.n, w: ew(a), avg10: avg(a) })),
    keywords: byCount(keywords)
      .slice(0, 60)
      .map(([kw, a]) => ({ kw, n: a.n, w: ew(a) })),
    loved: films.filter((f) => f.tmdbId != null && ((f.rating10 ?? 0) >= 9 || f.liked)).map((f) => f.tmdbId!),
    disliked: films.filter((f) => f.tmdbId != null && f.rating10 != null && f.rating10 <= 4).map((f) => f.tmdbId!),
    register: {
      share_high_popularity: matched ? round(highPop / matched) : 0,
      avg10_high_popularity: highPopRated ? round(highPopSum / highPopRated) : null,
      share_festival_core: matched ? round(festivalCore / matched) : 0,
    },
    pace_per_week: round(last180 / (180 / 7), 1),
    runtime_tolerance_p90: percentile(runtimes, 0.9),
    recency: { level: recency, ...(RECENCY_PRESETS[recency] ?? { half_life_years: null, floor: null }) },
  }
}
