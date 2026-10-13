/**
 * 同步：adapter → upsert film_aliases → upsert watch_log / watchlist（5.1）。
 * 每一步幂等（以 external_entry_id / (user, alias) 去重）。
 */
import { tx } from '@/db/client'
import {
  insertFilmStub,
  pruneSourceEntries,
  setAliasMatch,
  upsertAlias,
  upsertWatchEntry,
  upsertWatchlistEntry,
} from '@/db/repo/library'
import type { SourceAccount } from '@/db/schema'
import type { RawEntry } from './types'

export type SyncStats = { watched: number; watchlist: number; aliases: number; pruned: { log: number; list: number } | null }

const CHUNK = 200

export function writeEntries(
  userId: string,
  source: Pick<SourceAccount, 'id'> | null,
  entries: RawEntry[],
  opts: { prune: boolean; onProgress?: (done: number, total: number) => void } = { prune: false },
): SyncStats {
  const seenLog: string[] = []
  const seenList: number[] = []
  const aliasIds = new Set<number>()
  for (let i = 0; i < entries.length; i += CHUNK) {
    tx(() => {
      for (const e of entries.slice(i, i + CHUNK)) {
        let alias = upsertAlias({
          provider: e.provider,
          externalId: e.externalId,
          titleRaw: e.title,
          yearRaw: e.year ?? null,
          imdbIdRaw: e.imdbId ?? null,
        })
        // Resolver 第 1 步：来源直接给了 tmdb_id（Letterboxd RSS）
        if (e.tmdbId && alias.matchStatus !== 'confirmed' && alias.tmdbId !== e.tmdbId) {
          insertFilmStub({ tmdbId: e.tmdbId, titleEn: e.title, originalTitle: e.title, year: e.year ?? null })
          setAliasMatch(alias.id, { status: 'matched', tmdbId: e.tmdbId, confidence: 1, candidates: null })
          alias = { ...alias, tmdbId: e.tmdbId, matchStatus: 'matched' }
        }
        aliasIds.add(alias.id)
        if (e.listKind === 'watched') {
          upsertWatchEntry({
            userId,
            sourceId: source?.id ?? null,
            aliasId: alias.id,
            tmdbId: alias.tmdbId,
            provider: e.provider,
            externalEntryId: e.entryId,
            watchedAt: e.watchedAt ?? null,
            loggedAt: e.loggedAt ?? null,
            rating10: e.rating10 ?? null,
            liked: e.liked ?? false,
            rewatch: e.rewatch ?? false,
            reviewText: e.review ?? null,
            tags: e.tags ?? [],
            raw: e.raw,
          })
          seenLog.push(e.entryId)
        } else {
          if (e.provider === 'manual') continue
          upsertWatchlistEntry({
            userId,
            sourceId: source?.id ?? null,
            aliasId: alias.id,
            tmdbId: alias.tmdbId,
            provider: e.provider,
            addedAt: e.loggedAt ?? null,
          })
          seenList.push(alias.id)
        }
      }
    })
    opts.onProgress?.(Math.min(i + CHUNK, entries.length), entries.length)
  }
  const pruned = opts.prune && source ? pruneSourceEntries(source.id, seenLog, seenList) : null
  return { watched: seenLog.length, watchlist: seenList.length, aliases: aliasIds.size, pruned }
}

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of it) out.push(x)
  return out
}
