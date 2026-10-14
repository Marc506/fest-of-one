/**
 * TMDB 富化（5.5）：详情 en-US + zh-CN 两次请求，写入 films 全局缓存。
 */
import { getFilm, upsertFilm } from '@/db/repo/library'
import type { CastMember, PersonRef } from '@/db/types'
import { mapLimit } from '@/lib/http'
import { nowIso } from '@/lib/time'
import { isHanOnly } from './normalize'
import { yearOf, type TmdbClient, type TmdbMovieDetails } from './tmdb'

export const ENRICH_TTL_DAYS = 30

export function staleBefore(now = Date.now()): string {
  return new Date(now - ENRICH_TTL_DAYS * 86400_000).toISOString()
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)]
}

/** TMDB 详情 → films 行（纯函数，便于测试）。 */
export function detailsToFilm(en: TmdbMovieDetails, zh: TmdbMovieDetails | null) {
  const directors: PersonRef[] = []
  for (const c of en.credits?.crew ?? []) {
    if (c.job === 'Director' && !directors.some((d) => d.tmdb_person_id === c.id)) {
      directors.push({ tmdb_person_id: c.id, name: c.name })
    }
  }
  const cast: CastMember[] = [...(en.credits?.cast ?? [])]
    .sort((a, b) => a.order - b.order)
    .slice(0, 10)
    .map((c) => ({ tmdb_person_id: c.id, name: c.name, character: c.character || null, order: c.order }))
  // zh-CN 无译名时 TMDB 回退原名：只在「中文 / 日本片的纯汉字原名」或「与原名不同的汉字译名」时采信（韩文、假名不算）
  const zhTitle =
    zh?.title && isHanOnly(zh.title) && (zh.title !== en.original_title || ['zh', 'cn', 'ja'].includes(en.original_language))
      ? zh.title
      : null
  return {
    tmdbId: en.id,
    imdbId: en.imdb_id ?? en.external_ids?.imdb_id ?? null,
    titleEn: en.title,
    titleZh: zhTitle,
    originalTitle: en.original_title,
    year: yearOf(en.release_date),
    runtimeMin: en.runtime && en.runtime > 0 ? en.runtime : null,
    countries: uniq([...en.production_countries.map((c) => c.iso_3166_1), ...(en.origin_country ?? [])]),
    languages: uniq([en.original_language, ...en.spoken_languages.map((l) => l.iso_639_1)].filter(Boolean)),
    genres: en.genres.map((g) => g.name),
    directors,
    castTop: cast,
    keywords: (en.keywords?.keywords ?? []).map((k) => k.name),
    overviewEn: en.overview || null,
    overviewZh: zh?.overview || null,
    posterPath: en.poster_path,
    voteAvg: en.vote_average,
    voteCount: en.vote_count,
    popularity: en.popularity,
    releaseDate: en.release_date || null,
    enrichedAt: nowIso(),
  }
}

/** 富化单部片；TMDB 上不存在返回 false。 */
export async function enrichFilm(client: TmdbClient, tmdbId: number): Promise<boolean> {
  const [en, zh] = await Promise.all([client.getMovie(tmdbId, 'en-US'), client.getMovie(tmdbId, 'zh-CN')])
  if (!en) return false
  upsertFilm(detailsToFilm(en, zh))
  return true
}

/** 确保某部片在 films 里且已富化（候选片落地、手动添加用）。 */
export async function ensureFilm(client: TmdbClient, tmdbId: number, opts: { refreshIfOlderThan?: string } = {}) {
  const f = getFilm(tmdbId)
  if (f?.enrichedAt && (!opts.refreshIfOlderThan || f.enrichedAt >= opts.refreshIfOlderThan)) return f
  const ok = await enrichFilm(client, tmdbId)
  return ok ? getFilm(tmdbId) : undefined
}

export async function enrichMany(
  client: TmdbClient,
  ids: number[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ enriched: number; missing: number[] }> {
  let done = 0
  const missing: number[] = []
  let enriched = 0
  await mapLimit(ids, 4, async (id) => {
    const ok = await enrichFilm(client, id)
    if (ok) enriched++
    else missing.push(id)
    done++
    onProgress?.(done, ids.length)
  })
  return { enriched, missing }
}
