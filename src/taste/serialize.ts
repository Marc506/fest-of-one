/**
 * 观影记录序列化（6.3）——给 prompt 用，必须确定性：
 * 按 tmdb_id 升序、字段固定、不含时间戳或随机 ID；未匹配的条目也要进（tmdb_id 写 `?`）。
 *
 *   {tmdb_id}|{title_en} ({year})|{directors joined by &}|{countries joined by ,}|{rating10 or -}|{flags}|{last_watched YYYY-MM or -}
 *
 * > 6000 行时分两段：FULL（有评分 / liked / 近 3 年）保留完整行，INDEX 只留 `tmdb_id|title (year)`。
 * 「近 3 年」以记录里最晚的观看日期为锚点（而不是今天），保证同一份记录永远序列化成同样的字节。
 */
import { createHash } from 'node:crypto'
import type { ViewerFilm, WatchlistFilm } from './viewer'

export const SPLIT_THRESHOLD = 6000

const clean = (s: string) => s.replace(/[|\r\n]+/g, ' / ').replace(/\s+/g, ' ').trim()

export function flagsOf(f: Pick<ViewerFilm, 'liked' | 'rewatch' | 'views' | 'rating10'>): string {
  return `${f.liked ? 'L' : ''}${f.rewatch ? 'R' : ''}${f.views > 1 ? 'W' : ''}${f.rating10 != null && f.rating10 <= 4 ? 'D' : ''}`
}

function titleYear(f: { title: string; year: number | null }): string {
  return `${clean(f.title)} (${f.year ?? '?'})`
}

export function fullLine(f: ViewerFilm): string {
  return [
    f.tmdbId ?? '?',
    titleYear(f),
    f.directors.map(clean).join(' & ') || '-',
    f.countries.join(',') || '-',
    f.rating10 ?? '-',
    flagsOf(f) || '-',
    f.lastWatched ? f.lastWatched.slice(0, 7) : '-',
  ].join('|')
}

export function indexLine(f: { tmdbId: number | null; title: string; year: number | null }): string {
  return `${f.tmdbId ?? '?'}|${titleYear(f)}`
}

export type SerializedLog = { text: string; lines: number; split: boolean; hash: string }

export function serializeWatchLog(films: ViewerFilm[], watchlist: WatchlistFilm[] = [], opts: { splitThreshold?: number } = {}): SerializedLog {
  const threshold = opts.splitThreshold ?? SPLIT_THRESHOLD
  const out: string[] = []
  const header =
    'Format: tmdb_id|title (year)|directors|countries|rating10 (1–10, - = unrated)|flags (L liked, R rewatch, W watched more than once, D disliked ≤4)|last watched YYYY-MM. tmdb_id ? = not matched to TMDB.'
  if (films.length <= threshold) {
    out.push(`## Complete watch log (${films.length} films)`, header, ...films.map(fullLine))
  } else {
    const anchor = films.reduce((m, f) => (f.lastWatched && f.lastWatched > m ? f.lastWatched : m), '')
    const cutoff = anchor ? `${Number(anchor.slice(0, 4)) - 3}${anchor.slice(4)}` : ''
    const isFull = (f: ViewerFilm) => f.rating10 != null || f.liked || (cutoff !== '' && (f.lastWatched ?? '') >= cutoff)
    const full = films.filter(isFull)
    const index = films.filter((f) => !isFull(f))
    out.push(
      `## Complete watch log (${films.length} films; ${full.length} in FULL, ${index.length} in INDEX — together they are every film the viewer has seen)`,
      `### FULL (rated, liked, or watched within 3 years of their latest entry)`,
      header,
      ...full.map(fullLine),
      `### INDEX (seen, unrated; tmdb_id|title (year) only)`,
      ...index.map(indexLine),
    )
  }
  out.push('', `## Watchlist (${watchlist.length} films they have said they want to see; may be programmed, not required)`, 'WATCHLIST: tmdb_id|title (year)|directors')
  for (const w of watchlist) out.push(`WATCHLIST: ${indexLine(w)}|${w.directors.map(clean).join(' & ') || '-'}`)
  const text = out.join('\n')
  return { text, lines: films.length, split: films.length > threshold, hash: createHash('sha256').update(text).digest('hex') }
}
