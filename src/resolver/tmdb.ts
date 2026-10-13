/**
 * TMDB API v3 客户端（附录 A）。
 *
 * - `HttpTmdbClient`：真实 HTTP，Bearer token，并发 4，429 指数退避。
 * - `CatalogTmdbClient`：基于本地 JSON 片目的离线实现，返回与 TMDB 同形的数据。
 *   用于测试、`pnpm curate` 的 fixture 画像，以及无 TMDB 网络时的本地开发（env `TMDB_FIXTURE_CATALOG`）。
 */
import { readFileSync } from 'node:fs'
import { createRateLimitedFetch, getJson, HttpError, type FetchLike } from '@/lib/http'
import { titleSim, normalizeTitle } from './normalize'

export type TmdbLang = 'en-US' | 'zh-CN'

export type TmdbMovieSummary = {
  id: number
  title: string
  original_title: string
  release_date: string | null
  popularity: number
  vote_count: number
  vote_average: number
  poster_path: string | null
  genre_ids: number[]
  original_language: string
  overview: string
}

export type TmdbCredit = { id: number; name: string }
export type TmdbCastCredit = TmdbCredit & { character: string | null; order: number }
export type TmdbCrewCredit = TmdbCredit & { job: string; department: string }

export type TmdbMovieDetails = {
  id: number
  imdb_id: string | null
  title: string
  original_title: string
  release_date: string | null
  runtime: number | null
  production_countries: { iso_3166_1: string; name: string }[]
  origin_country?: string[]
  spoken_languages: { iso_639_1: string }[]
  original_language: string
  genres: { id: number; name: string }[]
  overview: string | null
  poster_path: string | null
  vote_average: number
  vote_count: number
  popularity: number
  credits?: { cast: TmdbCastCredit[]; crew: TmdbCrewCredit[] }
  keywords?: { keywords: { id: number; name: string }[] }
  external_ids?: { imdb_id: string | null }
}

export type TmdbPerson = { id: number; name: string; known_for_department: string; popularity: number }

export type TmdbPersonCredits = {
  cast: (TmdbMovieSummary & { character: string | null })[]
  crew: (TmdbMovieSummary & { job: string })[]
}

export type TmdbDiscoverParams = {
  countries?: string[]
  yearFrom?: number | null
  yearTo?: number | null
  keywordIds?: number[]
  genreIds?: number[]
  sort: 'vote_average' | 'popularity' | 'release_date'
  voteCountGte?: number
  page?: number
}

export interface TmdbClient {
  searchMovie(query: string, opts: { year?: number | null; language: TmdbLang }): Promise<TmdbMovieSummary[]>
  findByImdb(imdbId: string): Promise<TmdbMovieSummary | null>
  getMovie(id: number, language: TmdbLang): Promise<TmdbMovieDetails | null>
  searchPerson(query: string): Promise<TmdbPerson[]>
  personMovieCredits(personId: number): Promise<TmdbPersonCredits>
  discoverMovies(params: TmdbDiscoverParams): Promise<TmdbMovieSummary[]>
  searchKeyword(query: string): Promise<{ id: number; name: string }[]>
  movieGenres(): Promise<{ id: number; name: string }[]>
}

export function yearOf(date: string | null | undefined): number | null {
  if (!date) return null
  const y = Number(date.slice(0, 4))
  return Number.isFinite(y) && y > 1800 ? y : null
}

// ───────────────────────────── HTTP 实现 ─────────────────────────────

const API = 'https://api.themoviedb.org/3'

export class HttpTmdbClient implements TmdbClient {
  private readonly f: FetchLike
  private genreCache?: Promise<{ id: number; name: string }[]>

  constructor(
    private readonly token: string,
    fetchImpl?: FetchLike,
  ) {
    this.f = createRateLimitedFetch({ concurrency: 4, retries: 5, fetchImpl })
  }

  private async get<T>(path: string, params: Record<string, string | number | boolean | undefined | null> = {}): Promise<T> {
    const url = new URL(API + path)
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v))
    return getJson<T>(this.f, url.toString(), {
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/json' },
    })
  }

  async searchMovie(query: string, opts: { year?: number | null; language: TmdbLang }) {
    const r = await this.get<{ results: TmdbMovieSummary[] }>('/search/movie', {
      query,
      year: opts.year ?? undefined,
      language: opts.language,
      include_adult: false,
    })
    return r.results
  }

  async findByImdb(imdbId: string) {
    const r = await this.get<{ movie_results: TmdbMovieSummary[] }>(`/find/${encodeURIComponent(imdbId)}`, {
      external_source: 'imdb_id',
    })
    return r.movie_results[0] ?? null
  }

  async getMovie(id: number, language: TmdbLang) {
    try {
      return await this.get<TmdbMovieDetails>(`/movie/${id}`, {
        append_to_response: 'credits,keywords,external_ids',
        language,
      })
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) return null
      throw err
    }
  }

  async searchPerson(query: string) {
    const r = await this.get<{ results: TmdbPerson[] }>('/search/person', { query, include_adult: false })
    return r.results
  }

  async personMovieCredits(personId: number) {
    return this.get<TmdbPersonCredits>(`/person/${personId}/movie_credits`, { language: 'en-US' })
  }

  async discoverMovies(p: TmdbDiscoverParams) {
    const sortBy = p.sort === 'vote_average' ? 'vote_average.desc' : p.sort === 'popularity' ? 'popularity.desc' : 'primary_release_date.desc'
    const r = await this.get<{ results: TmdbMovieSummary[] }>('/discover/movie', {
      with_origin_country: p.countries?.length ? p.countries.join('|') : undefined,
      'primary_release_date.gte': p.yearFrom ? `${p.yearFrom}-01-01` : undefined,
      'primary_release_date.lte': p.yearTo ? `${p.yearTo}-12-31` : undefined,
      with_keywords: p.keywordIds?.length ? p.keywordIds.join('|') : undefined,
      with_genres: p.genreIds?.length ? p.genreIds.join('|') : undefined,
      sort_by: sortBy,
      'vote_count.gte': p.voteCountGte ?? (p.sort === 'vote_average' ? 50 : 10),
      include_adult: false,
      page: p.page ?? 1,
      language: 'en-US',
    })
    return r.results
  }

  async searchKeyword(query: string) {
    const r = await this.get<{ results: { id: number; name: string }[] }>('/search/keyword', { query })
    return r.results
  }

  movieGenres() {
    this.genreCache ??= this.get<{ genres: { id: number; name: string }[] }>('/genre/movie/list', { language: 'en-US' }).then(
      (r) => r.genres,
    )
    return this.genreCache
  }
}

// ───────────────────────────── 离线片目实现 ─────────────────────────────

export type CatalogFilm = {
  tmdb_id: number
  imdb_id?: string | null
  title_en: string
  title_zh?: string | null
  original_title: string
  year: number
  release_date?: string | null
  runtime_min: number | null
  countries: string[]
  languages: string[]
  genres: string[]
  directors: { tmdb_person_id: number; name: string }[]
  cast_top: { tmdb_person_id: number; name: string; character: string | null; order: number }[]
  keywords: string[]
  overview_en?: string | null
  overview_zh?: string | null
  vote_avg: number
  vote_count: number
  popularity: number
  poster_path?: string | null
}

/** TMDB 的 movie genre 表（en），离线实现与 discover 共用。 */
export const TMDB_GENRES: { id: number; name: string }[] = [
  { id: 28, name: 'Action' },
  { id: 12, name: 'Adventure' },
  { id: 16, name: 'Animation' },
  { id: 35, name: 'Comedy' },
  { id: 80, name: 'Crime' },
  { id: 99, name: 'Documentary' },
  { id: 18, name: 'Drama' },
  { id: 10751, name: 'Family' },
  { id: 14, name: 'Fantasy' },
  { id: 36, name: 'History' },
  { id: 27, name: 'Horror' },
  { id: 10402, name: 'Music' },
  { id: 9648, name: 'Mystery' },
  { id: 10749, name: 'Romance' },
  { id: 878, name: 'Science Fiction' },
  { id: 10770, name: 'TV Movie' },
  { id: 53, name: 'Thriller' },
  { id: 10752, name: 'War' },
  { id: 37, name: 'Western' },
]

function hashId(s: string): number {
  let h = 0
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) | 0
  return Math.abs(h) % 1_000_000
}

export class CatalogTmdbClient implements TmdbClient {
  private readonly byId = new Map<number, CatalogFilm>()
  private readonly keywordIds = new Map<string, number>()

  constructor(readonly films: CatalogFilm[]) {
    for (const f of films) {
      this.byId.set(f.tmdb_id, f)
      for (const k of f.keywords) if (!this.keywordIds.has(k)) this.keywordIds.set(k, hashId(k))
    }
  }

  static fromFile(path: string): CatalogTmdbClient {
    return new CatalogTmdbClient(JSON.parse(readFileSync(path, 'utf8')) as CatalogFilm[])
  }

  private summary(f: CatalogFilm, language: TmdbLang = 'en-US'): TmdbMovieSummary {
    return {
      id: f.tmdb_id,
      title: language === 'zh-CN' ? (f.title_zh ?? f.title_en) : f.title_en,
      original_title: f.original_title,
      release_date: f.release_date ?? `${f.year}-01-01`,
      popularity: f.popularity,
      vote_count: f.vote_count,
      vote_average: f.vote_avg,
      poster_path: f.poster_path ?? null,
      genre_ids: f.genres.map((g) => TMDB_GENRES.find((x) => x.name === g)?.id ?? 0).filter(Boolean),
      original_language: f.languages[0] ?? 'en',
      overview: (language === 'zh-CN' ? f.overview_zh : f.overview_en) ?? '',
    }
  }

  async searchMovie(query: string, opts: { year?: number | null; language: TmdbLang }) {
    const q = normalizeTitle(query)
    if (!q) return []
    return this.films
      .filter((f) => !opts.year || f.year === opts.year)
      .map((f) => {
        const titles = [f.title_en, f.original_title, f.title_zh ?? '']
        const contains = titles.some((t) => normalizeTitle(t).includes(q))
        const sim = Math.max(...titles.map((t) => titleSim(query, t)))
        return { f, rank: contains ? 1 + sim : sim }
      })
      .filter((x) => x.rank >= 0.55)
      .sort((a, b) => b.rank - a.rank || b.f.popularity - a.f.popularity)
      .slice(0, 20)
      .map((x) => this.summary(x.f, opts.language))
  }

  async findByImdb(imdbId: string) {
    const f = this.films.find((x) => x.imdb_id === imdbId)
    return f ? this.summary(f) : null
  }

  async getMovie(id: number, language: TmdbLang): Promise<TmdbMovieDetails | null> {
    const f = this.byId.get(id)
    if (!f) return null
    return {
      id: f.tmdb_id,
      imdb_id: f.imdb_id ?? null,
      title: language === 'zh-CN' ? (f.title_zh ?? f.title_en) : f.title_en,
      original_title: f.original_title,
      release_date: f.release_date ?? `${f.year}-01-01`,
      runtime: f.runtime_min,
      production_countries: f.countries.map((c) => ({ iso_3166_1: c, name: c })),
      origin_country: f.countries.slice(0, 1),
      spoken_languages: f.languages.map((l) => ({ iso_639_1: l })),
      original_language: f.languages[0] ?? 'en',
      genres: f.genres.map((g) => ({ id: TMDB_GENRES.find((x) => x.name === g)?.id ?? 0, name: g })),
      overview: (language === 'zh-CN' ? f.overview_zh : f.overview_en) ?? null,
      poster_path: f.poster_path ?? null,
      vote_average: f.vote_avg,
      vote_count: f.vote_count,
      popularity: f.popularity,
      credits: {
        cast: f.cast_top.map((c) => ({ id: c.tmdb_person_id, name: c.name, character: c.character, order: c.order })),
        crew: f.directors.map((d) => ({ id: d.tmdb_person_id, name: d.name, job: 'Director', department: 'Directing' })),
      },
      keywords: { keywords: f.keywords.map((k) => ({ id: this.keywordIds.get(k)!, name: k })) },
      external_ids: { imdb_id: f.imdb_id ?? null },
    }
  }

  private people(): Map<number, TmdbPerson> {
    const m = new Map<number, TmdbPerson>()
    for (const f of this.films) {
      for (const d of f.directors) {
        const p = m.get(d.tmdb_person_id) ?? { id: d.tmdb_person_id, name: d.name, known_for_department: 'Directing', popularity: 0 }
        p.popularity += 1
        m.set(d.tmdb_person_id, p)
      }
      for (const c of f.cast_top) {
        const p = m.get(c.tmdb_person_id) ?? { id: c.tmdb_person_id, name: c.name, known_for_department: 'Acting', popularity: 0 }
        p.popularity += 1
        m.set(c.tmdb_person_id, p)
      }
    }
    return m
  }

  async searchPerson(query: string) {
    const q = normalizeTitle(query)
    return [...this.people().values()]
      .map((p) => ({ p, s: normalizeTitle(p.name) === q ? 2 : titleSim(query, p.name) }))
      .filter((x) => x.s >= 0.75)
      .sort((a, b) => b.s - a.s || b.p.popularity - a.p.popularity)
      .map((x) => x.p)
  }

  async personMovieCredits(personId: number): Promise<TmdbPersonCredits> {
    const cast: TmdbPersonCredits['cast'] = []
    const crew: TmdbPersonCredits['crew'] = []
    for (const f of this.films) {
      const c = f.cast_top.find((x) => x.tmdb_person_id === personId)
      if (c) cast.push({ ...this.summary(f), character: c.character })
      if (f.directors.some((d) => d.tmdb_person_id === personId)) crew.push({ ...this.summary(f), job: 'Director' })
    }
    return { cast, crew }
  }

  async discoverMovies(p: TmdbDiscoverParams) {
    const genreNames = new Set((p.genreIds ?? []).map((id) => TMDB_GENRES.find((g) => g.id === id)?.name))
    const kwIds = new Set(p.keywordIds ?? [])
    const minVotes = p.voteCountGte ?? (p.sort === 'vote_average' ? 50 : 10)
    const list = this.films.filter(
      (f) =>
        (!p.countries?.length || f.countries.some((c) => p.countries!.includes(c))) &&
        (!p.yearFrom || f.year >= p.yearFrom) &&
        (!p.yearTo || f.year <= p.yearTo) &&
        (!genreNames.size || f.genres.some((g) => genreNames.has(g))) &&
        (!kwIds.size || f.keywords.some((k) => kwIds.has(this.keywordIds.get(k)!))) &&
        f.vote_count >= minVotes,
    )
    const key = (f: CatalogFilm) => (p.sort === 'vote_average' ? f.vote_avg : p.sort === 'popularity' ? f.popularity : f.year)
    const page = p.page ?? 1
    return list
      .sort((a, b) => key(b) - key(a) || a.tmdb_id - b.tmdb_id)
      .slice((page - 1) * 20, page * 20)
      .map((f) => this.summary(f))
  }

  async searchKeyword(query: string) {
    const q = normalizeTitle(query)
    return [...this.keywordIds.entries()]
      .filter(([k]) => normalizeTitle(k).includes(q) || titleSim(k, query) >= 0.8)
      .map(([name, id]) => ({ id, name }))
  }

  async movieGenres() {
    return TMDB_GENRES
  }
}

// ───────────────────────────── 工厂 ─────────────────────────────

let singleton: TmdbClient | undefined

export function getTmdbClient(): TmdbClient {
  if (singleton) return singleton
  const catalog = process.env.TMDB_FIXTURE_CATALOG
  if (catalog) {
    singleton = CatalogTmdbClient.fromFile(catalog)
  } else {
    const token = process.env.TMDB_READ_TOKEN
    if (!token) throw new Error('TMDB_READ_TOKEN 未配置')
    singleton = new HttpTmdbClient(token)
  }
  return singleton
}

/** 测试 / CLI 注入。 */
export function setTmdbClient(client: TmdbClient | undefined): void {
  singleton = client
}
