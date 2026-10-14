import { describe, expect, it } from 'vitest'
import { decide, popularityScore, scoreCandidate, yearMatchScore, type PoolEntry } from '@/resolver/match'

const entry = (id: number, title: string, year: number, votes: number, extra: Partial<PoolEntry> = {}): PoolEntry => ({
  id,
  title,
  original_title: title,
  release_date: `${year}-05-01`,
  popularity: 1,
  vote_count: votes,
  vote_average: 7,
  poster_path: null,
  genre_ids: [],
  original_language: 'en',
  overview: '',
  ...extra,
})

describe('resolver scoring (5.4)', () => {
  it('year and popularity components', () => {
    expect(yearMatchScore(2000, 2000)).toBe(1)
    expect(yearMatchScore(2000, 2001)).toBe(0.6)
    expect(yearMatchScore(2000, 2003)).toBe(0)
    expect(popularityScore(0)).toBe(0)
    expect(popularityScore(1e6)).toBe(1)
  })

  it('matches an exact title+year with a clear lead', () => {
    const s = [entry(1091, 'The Thing', 1982, 7400), entry(60935, 'The Thing', 2011, 3000)].map((e) => scoreCandidate(['The Thing'], 1982, e))
    const d = decide(s)
    expect(d.status).toBe('matched')
    expect(d.best?.entry.id).toBe(1091)
    expect(d.best!.score).toBeGreaterThanOrEqual(0.85)
  })

  it('marks same-title same-year films ambiguous', () => {
    const s = [entry(251, 'Ghost', 1990, 5600), entry(9, 'Ghost', 1990, 3800)].map((e) => scoreCandidate(['Ghost'], 1990, e))
    const d = decide(s)
    expect(d.status).toBe('ambiguous')
    expect(d.candidates.map((c) => c.tmdb_id)).toEqual([251, 9])
  })

  it('unmatched when nothing is close', () => {
    expect(decide([]).status).toBe('unmatched')
    const s = [scoreCandidate(['An Obscure Student Short'], 2015, entry(5, 'Shortbus', 2006, 900))]
    expect(decide(s).status).toBe('unmatched')
  })

  it('uses zh / original titles for CJK queries and redistributes weight without a year', () => {
    const e = entry(843, 'In the Mood for Love', 2000, 3200, { original_title: '花樣年華', title_zh: '花样年华' })
    const s = scoreCandidate(['花样年华'], null, e)
    expect(s.titleSim).toBe(1)
    expect(s.score).toBeGreaterThanOrEqual(0.85)
  })
})
