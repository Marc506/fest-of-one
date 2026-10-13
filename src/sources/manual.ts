/** 手动添加（5.6）与人工确认匹配（5.4 第 4 步）。 */
import { getAlias, getFilm, setAliasMatch, upsertAlias, upsertWatchEntry, userReferencesAlias } from '@/db/repo/library'
import { ensureFilm } from '@/resolver/enrich'
import type { TmdbClient } from '@/resolver/tmdb'
import { newId } from '@/lib/ids'

export class NotFound extends Error {}

/** 用户在 /library 手工选择 → confirmed（永不再被自动覆盖）。 */
export async function confirmAlias(client: TmdbClient, userId: string, aliasId: number, tmdbId: number) {
  const alias = getAlias(aliasId)
  if (!alias || !userReferencesAlias(userId, aliasId)) throw new NotFound('条目不存在')
  const film = await ensureFilm(client, tmdbId)
  if (!film) throw new NotFound('TMDB 上找不到这部片')
  setAliasMatch(alias.id, { status: 'confirmed', tmdbId, confidence: 1, candidates: alias.candidates })
  return film
}

/** 手动标记看过（provider = manual）。 */
export async function addManualWatch(
  client: TmdbClient,
  userId: string,
  input: { tmdbId: number; watchedAt?: string | null; rating10?: number | null; liked?: boolean },
) {
  const film = (await ensureFilm(client, input.tmdbId)) ?? getFilm(input.tmdbId)
  if (!film) throw new NotFound('TMDB 上找不到这部片')
  const alias = upsertAlias({ provider: 'manual', externalId: `tmdb:${film.tmdbId}`, titleRaw: film.titleEn, yearRaw: film.year })
  if (alias.matchStatus !== 'confirmed') {
    setAliasMatch(alias.id, { status: 'confirmed', tmdbId: film.tmdbId, confidence: 1, candidates: null })
  }
  upsertWatchEntry({
    userId,
    sourceId: null,
    aliasId: alias.id,
    tmdbId: film.tmdbId,
    provider: 'manual',
    externalEntryId: `manual:${newId()}`,
    watchedAt: input.watchedAt ?? null,
    loggedAt: new Date().toISOString().slice(0, 10),
    rating10: input.rating10 ?? null,
    liked: input.liked ?? false,
  })
  return film
}
