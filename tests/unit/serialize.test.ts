import { describe, expect, it } from 'vitest'
import { serializeWatchLog, fullLine, flagsOf, REVIEW_BUDGET_CHARS, REVIEW_MAX_CHARS } from '@/taste/serialize'
import { sortViewerFilms, type ViewerFilm } from '@/taste/viewer'

const vf = (tmdbId: number | null, title: string, year: number | null, o: Partial<ViewerFilm> = {}): ViewerFilm => ({
  key: tmdbId != null ? `t${tmdbId}` : `a${title}`,
  tmdbId,
  title,
  year,
  directors: [],
  countries: [],
  rating10: null,
  liked: false,
  rewatch: false,
  views: 1,
  lastWatched: null,
  film: null,
  ...o,
})

const FILMS: ViewerFilm[] = [
  vf(6977, 'No Country for Old Men', 2007, { directors: ['Joel Coen', 'Ethan Coen'], countries: ['US'], rating10: 9, liked: true, lastWatched: '2024-03-02' }),
  vf(843, 'In the Mood for Love', 2000, { directors: ['Wong Kar-wai'], countries: ['HK', 'FR'], rating10: 10, views: 2, rewatch: true, lastWatched: '2025-01-09' }),
  vf(9000900, 'Ghost | Remix', 1990, { rating10: 3, lastWatched: '2021-07-01' }),
  vf(null, 'An Obscure Student Short', 2015),
  vf(null, 'Another Unmatched', null, { lastWatched: '2021-02-02' }),
]

const shuffle = <T,>(xs: T[], seed: number) => {
  const a = [...xs]
  let s = seed
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1103515245 + 12345) % 2 ** 31
    const j = s % (i + 1)
    ;[a[i], a[j]] = [a[j]!, a[i]!]
  }
  return a
}

describe('watch log serialization (6.3)', () => {
  it('formats lines exactly as specified', () => {
    expect(fullLine(FILMS[0]!)).toBe('6977|No Country for Old Men (2007)|Joel Coen & Ethan Coen|US|9|L|2024-03')
    expect(fullLine(FILMS[1]!)).toBe('843|In the Mood for Love (2000)|Wong Kar-wai|HK,FR|10|RW|2025-01')
    expect(fullLine(FILMS[2]!)).toBe('9000900|Ghost / Remix (1990)|-|-|3|D|2021-07')
    expect(fullLine(FILMS[3]!)).toBe('?|An Obscure Student Short (2015)|-|-|-|-|-')
    expect(flagsOf({ liked: true, rewatch: true, views: 3, rating10: 2 })).toBe('LRWD')
  })

  it('is byte-identical across runs and input orders', () => {
    const a = serializeWatchLog(sortViewerFilms([...FILMS]))
    const b = serializeWatchLog(sortViewerFilms([...FILMS]))
    expect(a.text).toBe(b.text)
    for (let seed = 1; seed < 20; seed++) {
      expect(serializeWatchLog(sortViewerFilms(shuffle(FILMS, seed))).hash).toBe(a.hash)
    }
    expect(a.text).toMatchSnapshot()
  })

  it('sorts by tmdb_id with unmatched entries last', () => {
    const lines = serializeWatchLog(sortViewerFilms(shuffle(FILMS, 7))).text.split('\n').filter((l) => /^(\d+|\?)\|/.test(l))
    expect(lines.map((l) => l.split('|')[0])).toEqual(['843', '6977', '9000900', '?', '?'])
  })

  it('splits into FULL and INDEX above the threshold, still covering every film', () => {
    const s = serializeWatchLog(sortViewerFilms([...FILMS]), [], { splitThreshold: 3 })
    expect(s.split).toBe(true)
    const [full, index] = s.text.split('### INDEX')
    expect(full).toContain('6977|No Country for Old Men (2007)|Joel Coen & Ethan Coen|US|9|L|2024-03')
    // 无评分、超过锚点（2025-01-09）3 年以前 → INDEX
    expect(index).toContain('?|An Obscure Student Short (2015)')
    expect(index).toContain('?|Another Unmatched (?)')
    expect(index).not.toContain('6977')
  })

  it('includes the watchlist section', () => {
    const s = serializeWatchLog(sortViewerFilms([...FILMS]), [
      { key: 't30020', tmdbId: 30020, title: 'Taste of Cherry', year: 1997, directors: ['Abbas Kiarostami'], film: null },
    ])
    expect(s.text).toContain('WATCHLIST: 30020|Taste of Cherry (1997)|Abbas Kiarostami')
  })
})

describe("the viewer's own words", () => {
  it('lists short reviews by tmdb_id, cleaned and cut, and appends the writing sample', () => {
    const films = sortViewerFilms([
      vf(843, 'In the Mood for Love', 2000, { review: '雨里的楼梯。\n|旗袍换了二十多次', lastWatched: '2025-01-09' }),
      vf(6977, 'No Country for Old Men', 2007, { review: '长'.repeat(REVIEW_MAX_CHARS + 50), lastWatched: '2024-03-02' }),
      vf(25538, 'Yi Yi', 2000, { review: '   ' }),
    ])
    const s = serializeWatchLog(films, [], { writingSample: '第一段。\r\n\r\n\r\n\r\n第二段。' })
    expect(s.text).toContain("## In the viewer's own words (2 short reviews they wrote; quoted as written")
    expect(s.text).toContain('\n843|In the Mood for Love (2000)|雨里的楼梯。 / 旗袍换了二十多次\n')
    expect(s.text).toContain(`\n6977|No Country for Old Men (2007)|${'长'.repeat(REVIEW_MAX_CHARS)}…\n`)
    expect(s.text.indexOf('\n843|In the Mood')).toBeLessThan(s.text.indexOf('\n6977|No Country'))
    expect(s.text).toContain('## Writing the viewer chose to share (their own reviews or notes, in full)\n第一段。\n\n第二段。')
    expect(serializeWatchLog(sortViewerFilms([...films].reverse()), [], { writingSample: '第一段。\r\n\r\n\r\n\r\n第二段。' }).hash).toBe(s.hash)
  })

  it('keeps the total within budget and spreads the reviews across the years', () => {
    const n = Math.ceil(REVIEW_BUDGET_CHARS / (REVIEW_MAX_CHARS + 30)) + 40
    const films = sortViewerFilms(
      Array.from({ length: n }, (_, i) =>
        vf(1000 + i, `Film ${i}`, 2000, {
          review: '字'.repeat(REVIEW_MAX_CHARS),
          // 大部分是最近一年写的，早年只有少数几条
          lastWatched: i < 15 ? `20${String(10 + i)}-01-01` : '2026-01-01',
          rating10: i === 20 ? 10 : 6,
        }),
      ),
    )
    const s = serializeWatchLog(films)
    const section = s.text.split("## In the viewer's own words")[1]!.split('\n## ')[0]!
    const lines = section.split('\n').filter((l) => /^\d+\|/.test(l))
    expect(lines.length).toBeLessThan(n)
    expect(section.length).toBeLessThanOrEqual(REVIEW_BUDGET_CHARS + 200)
    expect(section).toContain(`of ${n}, chosen evenly across the years`)
    const kept = new Set(lines.map((l) => Number(l.split('|')[0])))
    // 每个早年的短评都在，最近一年里表态鲜明的那条优先
    for (let i = 0; i < 15; i++) expect(kept.has(1000 + i)).toBe(true)
    expect(kept.has(1020)).toBe(true)
  })

})
