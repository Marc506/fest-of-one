import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLetterboxdExport } from '@/sources/letterboxd-zip'
import { FIXTURES, zipFolder } from '../helpers'

describe('Letterboxd export parser', () => {
  const entries = parseLetterboxdExport(zipFolder(join(FIXTURES, 'letterboxd-export')))
  const watched = entries.filter((e) => e.listKind === 'watched')
  const byTitle = (t: string) => watched.filter((e) => e.title === t)

  it('one entry per diary row; films without diary get one undated entry', () => {
    expect(byTitle('Parasite')).toHaveLength(2)
    expect(byTitle('Yi Yi')).toHaveLength(1)
    expect(byTitle('Yi Yi')[0]).toMatchObject({ loggedAt: '2023-03-20', entryId: 'watched:https://boxd.it/1TOy' })
    expect(byTitle('Yi Yi')[0]!.watchedAt).toBeUndefined()
    // 8 films in watched.csv; Parasite twice
    expect(watched).toHaveLength(9)
    expect(new Set(watched.map((e) => e.externalId)).size).toBe(8)
  })

  it('diary rows link to the film URI, not the entry URI', () => {
    for (const e of byTitle('Parasite')) expect(e.externalId).toBe('https://boxd.it/hTha')
    expect(byTitle('Parasite').map((e) => e.entryId).sort()).toEqual(['https://boxd.it/e001', 'https://boxd.it/e002'])
  })

  it('maps ratings to rating10, ratings.csv overrides the latest entry only', () => {
    const [first, second] = byTitle('Parasite').sort((a, b) => a.watchedAt!.localeCompare(b.watchedAt!))
    expect(first!.rating10).toBe(8)
    expect(second!.rating10).toBe(9)
    expect(second!.rewatch).toBe(true)
    expect(second!.tags).toEqual(['cinema', 'with friends'])
    expect(byTitle('The Thing')[0]!.rating10).toBe(8)
    expect(byTitle('Ghost')[0]!.rating10).toBe(5)
    expect(byTitle('Yi Yi')[0]!.rating10).toBe(10)
  })

  it('applies likes and attaches reviews', () => {
    expect(byTitle('Yi Yi')[0]!.liked).toBe(true)
    const mood = byTitle('In the Mood for Love')[0]!
    expect(mood.liked).toBe(true)
    expect(mood.review).toMatch(/rice cooker/)
    expect(byTitle('Stalker')[0]).toMatchObject({ watchedAt: '2023-03-31', loggedAt: '2023-04-01', tags: ['tarkovsky', 'slow'] })
  })

  it('reads the watchlist and ignores deleted/', () => {
    const wl = entries.filter((e) => e.listKind === 'watchlist')
    expect(wl.map((e) => e.title)).toEqual(['Taste of Cherry', 'A City of Sadness'])
    expect(entries.some((e) => e.title === 'Deleted Movie')).toBe(false)
  })

  it('handles quoted titles with commas', () => {
    expect(byTitle('Crouching Tiger, Hidden Dragon')).toHaveLength(1)
  })

  it('rejects a ZIP without Letterboxd files', () => {
    expect(() => parseLetterboxdExport(zipFolder(join(FIXTURES, 'tmdb')))).toThrow(/watched\.csv/)
  })
})
