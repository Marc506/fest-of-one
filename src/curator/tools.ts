/**
 * Call A 的 TMDB 工具（7.3）。固定顺序、字面相同（缓存前缀的位置 0）。
 * 服务器在每条结果上标注 `seen_by_viewer`，模型因此不会再选已看的片。
 */
import type Anthropic from '@anthropic-ai/sdk'
import type { z } from 'zod'
import { getFilms } from '@/db/repo/library'
import type { Film } from '@/db/schema'
import { mapLimit } from '@/lib/http'
import { ensureFilm } from '@/resolver/enrich'
import { nameSim } from '@/resolver/normalize'
import { TMDB_GENRES, yearOf, type TmdbClient, type TmdbMovieSummary } from '@/resolver/tmdb'
import { DiscoverFilmsInput, GetFilmInput, GetFilmographyInput, SearchFilmsInput, strictJsonSchema } from './schemas'

function inputSchema(schema: z.ZodType): Anthropic.Tool.InputSchema {
  return strictJsonSchema(schema) as Anthropic.Tool.InputSchema
}

export const TOOL_DEFS: Anthropic.Tool[] = [
  {
    name: 'search_films',
    description:
      'Search TMDB for a film by title (any language), optionally with release year. Returns up to 5 matches with directors, countries, runtime, vote count and whether the viewer has already seen each film. Use it to check a title you have in mind and to get its tmdb_id.',
    strict: true,
    input_schema: inputSchema(SearchFilmsInput),
  },
  {
    name: 'get_filmography',
    description:
      "Get a person's complete feature filmography as director or as actor, ordered by year, with tmdb_id, title, year, character (actors), genres, vote_count, vote_avg, runtime_min and seen_by_viewer. The fastest way to build a director or actor programme.",
    strict: true,
    input_schema: inputSchema(GetFilmographyInput),
  },
  {
    name: 'discover_films',
    description:
      'Discover films by origin country (ISO 3166-1 alpha-2), release-year range, TMDB keywords (English phrases) and genres, sorted by vote_average, popularity or release_date. Returns up to 40 films with the same fields as get_filmography. Useful for country/era programmes and for finding motif candidates.',
    strict: true,
    input_schema: inputSchema(DiscoverFilmsInput),
  },
  {
    name: 'get_film',
    description:
      'Get one film’s details: overview, keywords, top cast, directors, runtime, countries, genres and seen_by_viewer. Use it to confirm a concrete connection (a scene, image or device) before proposing a film for a motif programme.',
    strict: true,
    input_schema: inputSchema(GetFilmInput),
  },
]

export type ToolContext = {
  client: TmdbClient
  seen: Set<number>
  /** 最多富化多少部（filmography / discover 的片长、导演从详情来） */
  enrichLimit?: number
  log?: (...a: unknown[]) => void
}

const genreName = (id: number) => TMDB_GENRES.find((g) => g.id === id)?.name ?? null

function brief(f: Film | undefined, s: TmdbMovieSummary, seen: Set<number>) {
  return {
    tmdb_id: s.id,
    title: f?.titleEn ?? s.title,
    original_title: f?.originalTitle ?? s.original_title,
    year: f?.year ?? yearOf(s.release_date),
    directors: f ? f.directors.map((d) => d.name) : [],
    countries: f?.countries ?? [],
    genres: f?.genres ?? s.genre_ids.map(genreName).filter(Boolean),
    runtime_min: f?.runtimeMin ?? null,
    vote_count: s.vote_count,
    vote_avg: s.vote_average,
    seen_by_viewer: seen.has(s.id),
  }
}

async function enrichAll(ctx: ToolContext, ids: number[]): Promise<Map<number, Film>> {
  const limit = ctx.enrichLimit ?? 40
  const uniq = [...new Set(ids)].slice(0, limit)
  const have = new Map(getFilms(uniq).filter((f) => f.enrichedAt).map((f) => [f.tmdbId, f]))
  const missing = uniq.filter((id) => !have.has(id))
  await mapLimit(missing, 4, async (id) => {
    try {
      const f = await ensureFilm(ctx.client, id)
      if (f) have.set(id, f)
    } catch (err) {
      ctx.log?.('enrich failed', id, err instanceof Error ? err.message : err)
    }
  })
  return have
}

/** 剔掉明显不是长片的条目（未上映、无日期、极少投票的边角料）。 */
function isFeature(s: TmdbMovieSummary): boolean {
  return Boolean(s.release_date) && s.vote_count >= 3
}

export function createToolExecutor(ctx: ToolContext) {
  return async (name: string, rawInput: unknown): Promise<unknown> => {
    switch (name) {
      case 'search_films': {
        const input = SearchFilmsInput.parse(rawInput)
        const language = /[㐀-鿿]/.test(input.query) ? 'zh-CN' : 'en-US'
        let res = await ctx.client.searchMovie(input.query, { year: input.year, language })
        if (!res.length && input.year) res = await ctx.client.searchMovie(input.query, { language })
        const top = res.slice(0, 5)
        const films = await enrichAll(ctx, top.map((r) => r.id))
        return { results: top.map((r) => brief(films.get(r.id), r, ctx.seen)) }
      }
      case 'get_filmography': {
        const input = GetFilmographyInput.parse(rawInput)
        const people = await ctx.client.searchPerson(input.person)
        const dept = input.role === 'director' ? 'Directing' : 'Acting'
        const person =
          people.find((p) => nameSim(p.name, input.person) >= 0.95 && p.known_for_department === dept) ??
          people.find((p) => nameSim(p.name, input.person) >= 0.95) ??
          people.find((p) => p.known_for_department === dept) ??
          people[0]
        if (!person) return { person: null, films: [], note: `No TMDB person found for "${input.person}".` }
        const credits = await ctx.client.personMovieCredits(person.id)
        const raw =
          input.role === 'director'
            ? credits.crew.filter((c) => c.job === 'Director').map((c) => ({ s: c as TmdbMovieSummary, character: null as string | null }))
            : credits.cast.map((c) => ({ s: c as TmdbMovieSummary, character: c.character }))
        const uniq = new Map<number, (typeof raw)[number]>()
        for (const r of raw) if (isFeature(r.s) && !uniq.has(r.s.id)) uniq.set(r.s.id, r)
        // 演员作品可能很多：按票数取前 60 部
        const list = [...uniq.values()].sort((a, b) => b.s.vote_count - a.s.vote_count).slice(0, 60)
        const films = await enrichAll(ctx, list.map((r) => r.s.id))
        const out = list
          .map((r) => ({ ...brief(films.get(r.s.id), r.s, ctx.seen), ...(input.role === 'actor' ? { character: r.character } : {}) }))
          .sort((a, b) => (a.year ?? 0) - (b.year ?? 0) || a.tmdb_id - b.tmdb_id)
        return { person: { tmdb_person_id: person.id, name: person.name, known_for: person.known_for_department }, role: input.role, films: out }
      }
      case 'discover_films': {
        const input = DiscoverFilmsInput.parse(rawInput)
        const keywordIds: number[] = []
        for (const kw of input.keywords) {
          const hits = await ctx.client.searchKeyword(kw)
          const best = hits.find((h) => h.name.toLowerCase() === kw.toLowerCase()) ?? hits[0]
          if (best) keywordIds.push(best.id)
        }
        const genres = await ctx.client.movieGenres()
        const genreIds = input.genres.map((g) => genres.find((x) => x.name.toLowerCase() === g.toLowerCase())?.id).filter((x): x is number => x != null)
        const params = {
          countries: input.countries,
          yearFrom: input.year_from,
          yearTo: input.year_to,
          keywordIds,
          genreIds,
          sort: input.sort,
        }
        const pages = await Promise.all([1, 2].map((page) => ctx.client.discoverMovies({ ...params, page })))
        const seenIds = new Set<number>()
        const list = pages.flat().filter((s) => (seenIds.has(s.id) ? false : (seenIds.add(s.id), true))).slice(0, 40)
        const films = await enrichAll(ctx, list.map((s) => s.id))
        return {
          applied: { keywords: input.keywords.filter((_, i) => keywordIds[i] != null), genres: input.genres.filter((_, i) => genreIds[i] != null) },
          films: list.map((s) => brief(films.get(s.id), s, ctx.seen)),
        }
      }
      case 'get_film': {
        const input = GetFilmInput.parse(rawInput)
        const f = await ensureFilm(ctx.client, input.tmdb_id)
        if (!f) return { error: `No TMDB film with id ${input.tmdb_id}` }
        return {
          tmdb_id: f.tmdbId,
          title: f.titleEn,
          original_title: f.originalTitle,
          year: f.year,
          directors: f.directors.map((d) => d.name),
          countries: f.countries,
          genres: f.genres,
          runtime_min: f.runtimeMin,
          keywords: f.keywords,
          cast_top: f.castTop.slice(0, 8).map((c) => ({ name: c.name, character: c.character })),
          overview: f.overviewEn,
          vote_count: f.voteCount,
          vote_avg: f.voteAvg,
          seen_by_viewer: ctx.seen.has(f.tmdbId),
        }
      }
      default:
        throw new Error(`Unknown tool ${name}`)
    }
  }
}
