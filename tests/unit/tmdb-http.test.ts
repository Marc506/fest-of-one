import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { detailsToFilm } from '@/resolver/enrich'
import { HttpTmdbClient, type TmdbMovieDetails } from '@/resolver/tmdb'
import { FIXTURES } from '../helpers'

const fixture = (name: string) => readFileSync(join(FIXTURES, 'tmdb', name), 'utf8')

describe('HttpTmdbClient', () => {
  it('sends Bearer auth, retries 429, parses search results', async () => {
    const calls: string[] = []
    let first = true
    const fakeFetch = async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input))
      calls.push(url.pathname + url.search)
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok')
      if (first) {
        first = false
        return new Response('slow down', { status: 429, headers: { 'retry-after': '0' } })
      }
      return new Response(fixture('search-parasite.json'), { status: 200 })
    }
    const client = new HttpTmdbClient('tok', fakeFetch)
    const results = await client.searchMovie('Parasite', { year: 2019, language: 'en-US' })
    expect(results.map((r) => r.id)).toEqual([496243, 613302])
    expect(calls).toHaveLength(2)
    expect(calls[1]).toContain('/3/search/movie?query=Parasite&year=2019&language=en-US')
  })

  it('returns null on 404 movie', async () => {
    const client = new HttpTmdbClient('tok', async () => new Response('{}', { status: 404 }))
    expect(await client.getMovie(1, 'en-US')).toBeNull()
  })
})

describe('detailsToFilm', () => {
  it('maps TMDB details (en + zh) to a films row', () => {
    const en = JSON.parse(fixture('movie-496243-en.json')) as TmdbMovieDetails
    const zh = JSON.parse(fixture('movie-496243-zh.json')) as TmdbMovieDetails
    const row = detailsToFilm(en, zh)
    expect(row).toMatchObject({
      tmdbId: 496243,
      imdbId: 'tt6751668',
      titleEn: 'Parasite',
      titleZh: '寄生虫',
      originalTitle: '기생충',
      year: 2019,
      runtimeMin: 133,
      countries: ['KR'],
      languages: ['ko', 'en'],
      genres: ['Comedy', 'Thriller', 'Drama'],
      directors: [{ tmdb_person_id: 21684, name: 'Bong Joon-ho' }],
      keywords: ['independent film', 'class differences', 'basement', 'black comedy', 'rain'],
    })
    expect(row.castTop[0]).toEqual({ tmdb_person_id: 20738, name: 'Song Kang-ho', character: 'Kim Ki-taek', order: 0 })
    expect(row.overviewZh).toMatch(/基宇/)
    expect(row.enrichedAt).toBeTruthy()
  })

  it('does not take a non-Chinese original title as title_zh', () => {
    const en = JSON.parse(fixture('movie-496243-en.json')) as TmdbMovieDetails
    const zhFallback = { ...en, title: '기생충' }
    expect(detailsToFilm(en, zhFallback).titleZh).toBeNull()
  })
})
