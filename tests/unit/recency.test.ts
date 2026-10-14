/**
 * 近期权重：越早越低、有下限、强烈表态的老片保留权重；锚点取自记录本身（确定性）。
 */
import { describe, expect, it } from 'vitest'
import { insertTasteProfile } from '@/db/repo/taste'
import { updateUserSettings, upsertUserByEmail } from '@/db/repo/users'
import { DEFAULT_PREFS } from '@/db/types'
import type { Film } from '@/db/schema'
import { needsRebuild } from '@/taste/profile'
import { recencyAnchor, recencyWeight, RECENCY_PRESETS } from '@/taste/recency'
import { serializeWatchLog } from '@/taste/serialize'
import { computeTasteStats } from '@/taste/stats'
import { sortViewerFilms, type ViewerFilm } from '@/taste/viewer'

const ANCHOR = '2026-09-15'
const w = (lastWatched: string | null, o: { rating10?: number | null; liked?: boolean } = {}, level: Parameters<typeof recencyWeight>[2] = 'moderate') =>
  recencyWeight({ lastWatched, rating10: o.rating10 ?? null, liked: o.liked ?? false }, ANCHOR, level)

describe('recencyWeight', () => {
  it('is 1 for the latest entry and decays by half-life toward the floor', () => {
    expect(w('2026-09-01')).toBe(1)
    expect(w('2022-09-01')).toBe(0.7) // 4 年 = 一个半衰期：0.4 + 0.6 / 2
    expect(w('2018-09-01')).toBe(0.55)
    expect(w('1990-01-01')).toBeGreaterThanOrEqual(RECENCY_PRESETS.moderate!.floor)
    expect(w('1990-01-01')).toBeLessThan(0.41)
  })

  it('never increases with age', () => {
    let prev = 1
    for (let y = 2026; y >= 1995; y--) {
      const x = w(`${y}-06-01`, { rating10: 7 })
      expect(x).toBeLessThanOrEqual(prev)
      prev = x
    }
  })

  it('keeps most of the weight for strongly felt old films, some for 8/10', () => {
    const neutral = w('2014-01-01', { rating10: 6 })
    expect(w('2014-01-01', { rating10: 10 })).toBeGreaterThanOrEqual(0.75)
    expect(w('2014-01-01', { rating10: 2 })).toBeGreaterThanOrEqual(0.75)
    expect(w('2014-01-01', { liked: true })).toBeGreaterThanOrEqual(0.75)
    const eight = w('2014-01-01', { rating10: 8 })
    expect(eight).toBeGreaterThan(neutral)
    expect(eight).toBeLessThan(w('2014-01-01', { rating10: 10 }))
  })

  it('treats undated entries as old, and off as uniform', () => {
    expect(w(null)).toBe(RECENCY_PRESETS.moderate!.floor)
    expect(w('2001-01-01', {}, 'off')).toBe(1)
    expect(w(null, {}, 'off')).toBe(1)
    expect(w('2018-01-01', {}, 'strong')).toBeLessThan(w('2018-01-01', {}, 'moderate'))
    expect(w('2018-01-01', {}, 'moderate')).toBeLessThan(w('2018-01-01', {}, 'light'))
  })

  it('anchors on the latest entry in the log, not on today', () => {
    expect(recencyAnchor([{ lastWatched: '2019-01-02' }, { lastWatched: null }, { lastWatched: '2024-05-06' }])).toBe('2024-05-06')
    expect(recencyAnchor([{ lastWatched: null }])).toBeNull()
  })
})

const film = (tmdbId: number, director: string): Film =>
  ({
    tmdbId,
    titleEn: `Film ${tmdbId}`,
    year: 2000,
    directors: [{ tmdb_person_id: tmdbId, name: director }],
    countries: ['FR'],
    genres: ['Drama'],
    languages: ['fr'],
    castTop: [],
    keywords: [],
    runtimeMin: 100,
    voteCount: 100,
  }) as unknown as Film

const vf = (tmdbId: number, director: string, lastWatched: string, rating10: number): ViewerFilm => ({
  key: `t${tmdbId}`,
  tmdbId,
  title: `Film ${tmdbId}`,
  year: 2000,
  directors: [director],
  countries: ['FR'],
  rating10,
  liked: false,
  rewatch: false,
  views: 1,
  lastWatched,
  film: film(tmdbId, director),
})

// 三部 12 年前看的 Old Master vs 两部去年看的 New Voice，评分一样
const LOG = [
  vf(1, 'Old Master', '2014-03-01', 7),
  vf(2, 'Old Master', '2014-04-01', 7),
  vf(3, 'Old Master', '2014-05-01', 7),
  vf(4, 'New Voice', '2025-10-01', 7),
  vf(5, 'New Voice', '2026-09-01', 7),
]
const NOW = new Date('2026-10-01T00:00:00Z')

describe('weighted taste stats', () => {
  it('ranks recent directors above older ones with the same ratings, keeping raw counts', () => {
    const off = computeTasteStats(LOG, NOW, { recency: 'off' })
    expect(off.directors.map((d) => d.name)).toEqual(['Old Master', 'New Voice'])
    const on = computeTasteStats(LOG, NOW, { recency: 'moderate' })
    expect(on.directors.map((d) => d.name)).toEqual(['New Voice', 'Old Master'])
    const old = on.directors.find((d) => d.name === 'Old Master')!
    expect(old.n).toBe(3)
    expect(old.avg10).toBe(7)
    expect(old.w).toBeLessThan(1.5)
    expect(on.recency).toEqual({ level: 'moderate', half_life_years: 4, floor: 0.4 })
  })

  it('lets a strongly loved old body of work hold its place', () => {
    const loved = LOG.map((f) => (f.directors[0] === 'Old Master' ? { ...f, rating10: 10 } : f))
    const on = computeTasteStats(loved, NOW, { recency: 'moderate' })
    expect(on.directors[0]!.name).toBe('Old Master')
  })
})

describe('weighted watch log', () => {
  it('appends a weight column and explains it in the format line; off keeps the 6.3 format', () => {
    const s = serializeWatchLog(sortViewerFilms([...LOG]), [], { recency: 'moderate' })
    expect(s.text).toContain('|last watched YYYY-MM|weight. weight (0–1)')
    expect(s.text).toContain('\n5|Film 5 (2000)|New Voice|FR|7|-|2026-09|1\n')
    expect(s.text).toMatch(/\n1\|Film 1 \(2000\)\|Old Master\|FR\|7\|-\|2014-03\|0\.4\d\n/)
    expect(s.text).not.toMatch(/20\d\d-\d\d-\d\d/) // 不含完整日期（锚点不进 prompt）

    const off = serializeWatchLog(sortViewerFilms([...LOG]), [], { recency: 'off' })
    expect(off.text).toContain('\n5|Film 5 (2000)|New Voice|FR|7|-|2026-09\n')
    expect(off.hash).not.toBe(s.hash)
    expect(serializeWatchLog(sortViewerFilms([...LOG].reverse()), [], { recency: 'moderate' }).hash).toBe(s.hash)
  })
})

describe('changing the setting', () => {
  it('defaults to moderate and asks for a rebuild when the level changes', () => {
    expect(DEFAULT_PREFS.recency_weighting).toBe('moderate')
    const user = upsertUserByEmail('recency@test')
    const films = sortViewerFilms([...LOG])
    const stats = computeTasteStats(films, NOW, { recency: 'moderate' })
    const log = serializeWatchLog(films, [], { recency: 'moderate' })
    const profile = insertTasteProfile({ userId: user.id, watchLogHash: log.hash, watchLogCount: films.length, stats, memo: null, memoMd: null, model: null, inputTokens: null, outputTokens: null })
    expect(needsRebuild(profile, { films, log, recency: 'moderate' }, NOW).needed).toBe(false)

    updateUserSettings(user.id, { prefs: { ...DEFAULT_PREFS, recency_weighting: 'strong' } })
    const strongLog = serializeWatchLog(films, [], { recency: 'strong' })
    expect(needsRebuild(profile, { films, log: strongLog, recency: 'strong' }, NOW)).toEqual({ needed: true, reason: '近期权重设置变了' })
  })
})
