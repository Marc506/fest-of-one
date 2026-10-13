import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getFilm, libraryCounts, listLibrary, matchStats, seenTmdbIds, unresolvedAliasesForUser } from '@/db/repo/library'
import { createSource, deleteSource } from '@/db/repo/sources'
import { getJob } from '@/db/repo/jobs'
import { upsertUserByEmail } from '@/db/repo/users'
import { enqueueJob } from '@/jobs/queue'
import { drainQueue } from '@/jobs/worker'
import { CatalogTmdbClient, setTmdbClient } from '@/resolver/tmdb'
import { addManualWatch, confirmAlias } from '@/sources/manual'
import { saveUpload } from '@/sources/uploads'
import { FIXTURES, miniCatalog, quiet, zipFolder } from '../helpers'

describe('Letterboxd ZIP → resolver → enrich (M1 flow)', () => {
  it('imports, matches, enriches, resolves ambiguity, adds manually and deletes a source', async () => {
    process.env.DATABASE_URL = ':memory:'
    const client = new CatalogTmdbClient(miniCatalog())
    setTmdbClient(client)
    const user = upsertUserByEmail('m1@test')
    const source = createSource({ userId: user.id, provider: 'letterboxd', handle: 'export', syncMode: 'upload' })
    const path = saveUpload(user.id, source.id, '.zip', zipFolder(join(FIXTURES, 'letterboxd-export')))
    expect(path).toBeTruthy()

    const job = enqueueJob('sync_source', { source_id: source.id, upload_path: path, full: true }, user.id)
    await drainQueue(quiet) // sync_source → enrich_films
    const sync = getJob(job.id)!
    expect(sync.status).toBe('done')
    const enrichId = (sync.result as { enrich_job_id: string }).enrich_job_id
    const enrich = getJob(enrichId)!
    expect(enrich.status).toBe('done')

    const ms = matchStats(user.id)
    // 8 watched films: 6 matched, Ghost ambiguous, student short unmatched
    expect(ms).toMatchObject({ matched: 6, ambiguous: 1, unmatched: 1 })
    expect(libraryCounts(user.id)).toMatchObject({ entries: 9, films: 8, unresolved: 2, watchlist: 2 })

    // The Thing (1982) chosen over the 2011 prequel; enrichment filled director + zh title
    const thing = getFilm(1091)!
    expect(thing.enrichedAt).toBeTruthy()
    expect(thing.directors[0]!.name).toBe('John Carpenter')
    expect(getFilm(60935)).toBeUndefined()
    expect(getFilm(843)!.titleZh).toBe('花样年华')
    expect(seenTmdbIds(user.id).has(1091)).toBe(true)

    // ambiguous → user confirms
    const ghost = unresolvedAliasesForUser(user.id).find((a) => a.titleRaw === 'Ghost')!
    expect(ghost.candidates?.map((c) => c.tmdb_id)).toContain(251)
    await confirmAlias(client, user.id, ghost.id, 251)
    expect(seenTmdbIds(user.id).has(251)).toBe(true)

    // confirmed survives re-sync
    enqueueJob('sync_source', { source_id: source.id, upload_path: path, full: true }, user.id)
    await drainQueue(quiet)
    expect(matchStats(user.id)).toMatchObject({ matched: 6, confirmed: 1, unmatched: 1 })
    expect(libraryCounts(user.id).entries).toBe(9)

    // manual add
    await addManualWatch(client, user.id, { tmdbId: 30020, rating10: 8, watchedAt: '2026-10-01' })
    expect(seenTmdbIds(user.id).has(30020)).toBe(true)
    const lib = listLibrary(user.id, { q: 'cherry' })
    expect(lib.rows).toHaveLength(1)
    expect(lib.rows[0]).toMatchObject({ tmdbId: 30020, rating10: 8, providers: ['manual'] })

    // filters
    expect(listLibrary(user.id, { minRating: 10 }).rows.map((r) => r.tmdbId!).sort((a, b) => a - b)).toEqual([843, 25538])
    expect(listLibrary(user.id, { yearFrom: 2000, yearTo: 2000 }).total).toBe(3)

    // deleting the source cascades its entries but keeps manual ones
    expect(deleteSource(source.id, user.id)).toBe(true)
    expect(libraryCounts(user.id)).toMatchObject({ entries: 1, watchlist: 0 })
    setTmdbClient(undefined)
  })

  it('isolates users', async () => {
    const client = new CatalogTmdbClient(miniCatalog())
    const a = upsertUserByEmail('a@test')
    const b = upsertUserByEmail('b@test')
    await addManualWatch(client, a.id, { tmdbId: 843 })
    expect(seenTmdbIds(a.id).has(843)).toBe(true)
    expect(seenTmdbIds(b.id).size).toBe(0)
    expect(listLibrary(b.id).total).toBe(0)
  })
})
