/**
 * 观影记录序列化（6.3）——给 prompt 用，必须确定性：
 * 按 tmdb_id 升序、字段固定、不含时间戳或随机 ID；未匹配的条目也要进（tmdb_id 写 `?`）。
 *
 *   {tmdb_id}|{title_en} ({year})|{directors joined by &}|{countries joined by ,}|{rating10 or -}|{flags}|{last_watched YYYY-MM or -}
 *
 * > 6000 行时分两段：FULL（有评分 / liked / 近 3 年）保留完整行，INDEX 只留 `tmdb_id|title (year)`。
 * 「近 3 年」以记录里最晚的观看日期为锚点（而不是今天），保证同一份记录永远序列化成同样的字节。
 *
 * 偏离 6.3：开启近期权重（recency.ts，默认「适中」）时，FULL 行末尾多一列 `|weight`（0–1）。
 * 权重同样以记录内最晚日期为锚点，所以仍然确定性；关闭时格式与 6.3 完全一致。
 *
 * 偏离 6.3：TA 自己写的短评（豆瓣短评 / Letterboxd review）单列一段「In the viewer's own words」，
 * 每条截到 REVIEW_MAX_CHARS、总量不超过 REVIEW_BUDGET_CHARS（超出时按权重、再按观看时间挑，输出仍按 tmdb_id 排序）；
 * 设置里贴的长文（writing sample）再单列一段。两者都是确定性的。
 */
import { createHash } from 'node:crypto'
import { describeRecency, recencyAnchor, recencyWeight, type RecencyLevelT } from './recency'
import type { ViewerFilm, WatchlistFilm } from './viewer'

export const SPLIT_THRESHOLD = 6000
export const REVIEW_MAX_CHARS = 300
export const REVIEW_BUDGET_CHARS = 24_000
export const WRITING_SAMPLE_MAX_CHARS = 8_000

const clean = (s: string) => s.replace(/[|\r\n]+/g, ' / ').replace(/\s+/g, ' ').trim()

export function flagsOf(f: Pick<ViewerFilm, 'liked' | 'rewatch' | 'views' | 'rating10'>): string {
  return `${f.liked ? 'L' : ''}${f.rewatch ? 'R' : ''}${f.views > 1 ? 'W' : ''}${f.rating10 != null && f.rating10 <= 4 ? 'D' : ''}`
}

function titleYear(f: { title: string; year: number | null }): string {
  return `${clean(f.title)} (${f.year ?? '?'})`
}

export function fullLine(f: ViewerFilm, weight?: number): string {
  const cols: (string | number)[] = [
    f.tmdbId ?? '?',
    titleYear(f),
    f.directors.map(clean).join(' & ') || '-',
    f.countries.join(',') || '-',
    f.rating10 ?? '-',
    flagsOf(f) || '-',
    f.lastWatched ? f.lastWatched.slice(0, 7) : '-',
  ]
  if (weight !== undefined) cols.push(weight)
  return cols.join('|')
}

export function indexLine(f: { tmdbId: number | null; title: string; year: number | null }): string {
  return `${f.tmdbId ?? '?'}|${titleYear(f)}`
}

export type SerializedLog = { text: string; lines: number; split: boolean; hash: string }

const cut = (t: string, max: number) => {
  const chars = [...t]
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : t
}

/** 短评段：总量有上限；超出时优先权重高、再看得近的，输出顺序跟随 films（tmdb_id 升序）。 */
function reviewSection(films: ViewerFilm[], weightOf: (f: ViewerFilm) => number): string[] {
  const all = films.map((f, i) => ({ f, i, text: f.review ? cut(clean(f.review), REVIEW_MAX_CHARS) : '' })).filter((x) => x.text)
  if (!all.length) return []
  const ranked = [...all].sort(
    (a, b) => weightOf(b.f) - weightOf(a.f) || (b.f.lastWatched ?? '').localeCompare(a.f.lastWatched ?? '') || a.i - b.i,
  )
  const keep = new Set<number>()
  let used = 0
  for (const r of ranked) {
    const cost = r.text.length + 30
    if (used + cost > REVIEW_BUDGET_CHARS) continue
    used += cost
    keep.add(r.i)
  }
  const shown = all.filter((x) => keep.has(x.i))
  const scope = shown.length < all.length ? `; the ${shown.length} most telling of ${all.length}` : ''
  return [
    '',
    `## In the viewer's own words (${shown.length} short reviews they wrote${scope}; quoted as written, long ones cut with …)`,
    'tmdb_id|title (year)|their review',
    ...shown.map((x) => `${x.f.tmdbId ?? '?'}|${titleYear(x.f)}|${x.text}`),
  ]
}

function writingSection(sample: string | null | undefined): string[] {
  const text = (sample ?? '').replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  if (!text) return []
  return ['', '## Writing the viewer chose to share (their own reviews or notes, in full)', cut(text, WRITING_SAMPLE_MAX_CHARS)]
}

export function serializeWatchLog(
  films: ViewerFilm[],
  watchlist: WatchlistFilm[] = [],
  opts: { splitThreshold?: number; recency?: RecencyLevelT; nonFilm?: ViewerFilm[]; writingSample?: string | null } = {},
): SerializedLog {
  const threshold = opts.splitThreshold ?? SPLIT_THRESHOLD
  const recency = opts.recency ?? 'off'
  const weighting = describeRecency(recency)
  const recencyAt = recencyAnchor(films)
  const line = (f: ViewerFilm) => fullLine(f, weighting ? recencyWeight(f, recencyAt, recency) : undefined)
  const out: string[] = []
  const header =
    'Format: tmdb_id|title (year)|directors|countries|rating10 (1–10, - = unrated)|flags (L liked, R rewatch, W watched more than once, D disliked ≤4)|last watched YYYY-MM' +
    (weighting ? `|weight. ${weighting}` : '.') +
    ' tmdb_id ? = not matched to TMDB.'
  if (films.length <= threshold) {
    out.push(`## Complete watch log (${films.length} films)`, header, ...films.map(line))
  } else {
    const anchor = recencyAt ?? ''
    const cutoff = anchor ? `${Number(anchor.slice(0, 4)) - 3}${anchor.slice(4)}` : ''
    const isFull = (f: ViewerFilm) => f.rating10 != null || f.liked || (cutoff !== '' && (f.lastWatched ?? '') >= cutoff)
    const full = films.filter(isFull)
    const index = films.filter((f) => !isFull(f))
    out.push(
      `## Complete watch log (${films.length} films; ${full.length} in FULL, ${index.length} in INDEX — together they are every film the viewer has seen)`,
      `### FULL (rated, liked, or watched within 3 years of their latest entry)`,
      header,
      ...full.map(line),
      `### INDEX (seen, unrated; tmdb_id|title (year) only)`,
      ...index.map(indexLine),
    )
  }
  out.push(...reviewSection(films, (f) => (weighting ? recencyWeight(f, recencyAt, recency) : 1)))
  out.push(...writingSection(opts.writingSample))
  if (opts.nonFilm?.length) {
    // 剧集 / 综艺等：不是电影、也不会被排片，只留标题，让策展人知道 TA 还看这些
    out.push('', `## Also logged, not films (${opts.nonFilm.length} TV series, variety shows, stage recordings…; titles only)`)
    out.push(opts.nonFilm.map((f) => clean(f.title)).join(' · '))
  }
  out.push('', `## Watchlist (${watchlist.length} films they have said they want to see; may be programmed, not required)`, 'WATCHLIST: tmdb_id|title (year)|directors')
  for (const w of watchlist) out.push(`WATCHLIST: ${indexLine(w)}|${w.directors.map(clean).join(' & ') || '-'}`)
  const text = out.join('\n')
  return { text, lines: films.length, split: films.length > threshold, hash: createHash('sha256').update(text).digest('hex') }
}
