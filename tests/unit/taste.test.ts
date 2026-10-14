import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { llmCalls } from '@/db/schema'
import { latestTasteProfile } from '@/db/repo/taste'
import { createSource } from '@/db/repo/sources'
import { upsertUserByEmail } from '@/db/repo/users'
import { enqueueJob } from '@/jobs/queue'
import { drainQueue } from '@/jobs/worker'
import { setTransport } from '@/llm/client'
import { CatalogTmdbClient, setTmdbClient } from '@/resolver/tmdb'
import { buildTasteProfile, currentWatchState, needsRebuild } from '@/taste/profile'
import { computeTasteStats } from '@/taste/stats'
import { saveUpload } from '@/sources/uploads'
import { addManualWatch } from '@/sources/manual'
import type { TasteMemoT } from '@/curator/schemas'
import { message, ScriptedTransport } from '../fake-llm'
import { FIXTURES, miniCatalog, quiet, zipFolder } from '../helpers'

const MEMO: TasteMemoT = {
  summary: '一位耐心的观众。',
  register: { art_house: 0.8, auteur_genre: 0.6, mainstream_commercial: 1.7, note: '能接受作者类型片。' },
  affinities: [{ kind: 'director', name: 'Wong Kar-wai', strength: 0.9, evidence: [843, 999999], note: '王家卫。' }],
  aversions: [],
  frontiers: [{ description: '侯孝贤', why_adjacent: '同代', seed_films: [25538] }],
  habits: { pace_per_week: 1, runtime_tolerance_min: 170, rewatch_tendency: 'low' },
  do_not_program: ['超级英雄系列'],
}

async function importFixture() {
  setTmdbClient(new CatalogTmdbClient(miniCatalog()))
  const user = upsertUserByEmail('taste@test')
  const source = createSource({ userId: user.id, provider: 'letterboxd', handle: 'export', syncMode: 'upload' })
  const path = saveUpload(user.id, source.id, '.zip', zipFolder(join(FIXTURES, 'letterboxd-export')))
  enqueueJob('sync_source', { source_id: source.id, upload_path: path, full: true }, user.id)
  return { user }
}

describe('taste profile (M2)', () => {
  it('computes stats from the imported log', async () => {
    const { user } = await importFixture()
    setTransport(undefined)
    await drainQueue(quiet)
    const { films } = currentWatchState(user.id)
    const s = computeTasteStats(films, new Date('2024-09-15T00:00:00Z'))
    expect(s.counts).toMatchObject({ films: 8, rated: 6, liked: 2, rewatched: 1, last90d: 1 })
    expect(s.rating_dist['10']).toBe(2)
    expect(s.loved.sort((a, b) => a - b)).toEqual([843, 1398, 25538, 496243])
    expect(s.disliked).toEqual([])
    expect(s.decades.map((d) => d.decade)).toEqual([1970, 1980, 2000, 2010])
    expect(s.countries.find((c) => c.code === 'US')).toEqual({ code: 'US', n: 2, w: 2, avg10: 8 })
    expect(s.countries[0]).toEqual({ code: 'HK', n: 2, w: 2, avg10: 10 })
    expect(s.runtime_tolerance_p90).toBe(173)
    setTmdbClient(undefined)
  })

  it('builds a stats-only profile when no LLM is configured', async () => {
    const { user } = await importFixture()
    setTransport(undefined)
    await drainQueue(quiet) // sync → enrich → build_taste
    const p = latestTasteProfile(user.id)!
    expect(p.version).toBe(1)
    expect(p.memo).toBeNull()
    expect(p.watchLogCount).toBe(8)
    setTmdbClient(undefined)
  })

  it('generates the memo via the LLM with cached system blocks and sanitises it', async () => {
    const { user } = await importFixture()
    const t = new ScriptedTransport(() => message(JSON.stringify(MEMO), { usage: { cache_creation_input_tokens: 4000 } }))
    setTransport(t)
    await drainQueue(quiet)
    const p = latestTasteProfile(user.id)!
    expect(p.memo).not.toBeNull()
    // 数值夹到 0–1；证据只留真实在 log 里的
    expect(p.memo!.register.mainstream_commercial).toBe(1)
    expect(p.memo!.affinities[0]!.evidence).toEqual([843])
    expect(p.memoMd).toBe('一位耐心的观众。')

    const req = t.requests[0]!
    const system = req.system as { text: string; cache_control?: unknown }[]
    expect(system).toHaveLength(3)
    for (const b of system) expect(b.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' })
    expect(system[2]!.text).toContain('843|In the Mood for Love (2000)|Wong Kar-wai|HK,FR|10|L|2023-02')
    expect(system.map((b) => b.text).join('')).not.toMatch(/2026-10-13|Today/)
    expect(req.output_config?.effort).toBe('high')
    expect(req).not.toHaveProperty('thinking')
    expect(JSON.stringify(req.messages)).toContain('zh-CN')

    const calls = getDb().select().from(llmCalls).where(eq(llmCalls.userId, user.id)).all()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ purpose: 'taste_memo', model: 'claude-opus-5-5', effort: 'high', cacheCreationInputTokens: 4000 })
    expect(calls[0]!.costUsd).toBeGreaterThan(0)
    setTransport(undefined)
    setTmdbClient(undefined)
  })

  it('serializes identically regardless of insertion order (DB level)', async () => {
    const client = new CatalogTmdbClient(miniCatalog())
    const a = upsertUserByEmail('order-a@test')
    const b = upsertUserByEmail('order-b@test')
    const ids = [843, 1091, 25538, 1398, 496243]
    for (const id of ids) await addManualWatch(client, a.id, { tmdbId: id, rating10: 8, watchedAt: '2024-01-01' })
    for (const id of [...ids].reverse()) await addManualWatch(client, b.id, { tmdbId: id, rating10: 8, watchedAt: '2024-01-01' })
    const sa = currentWatchState(a.id).log
    const sb = currentWatchState(b.id).log
    expect(sa.text).toBe(sb.text)
    expect(sa.hash).toBe(sb.hash)
    expect(sa.text).not.toMatch(new RegExp(a.id))
  })

  it('rebuild policy', async () => {
    const { user } = await importFixture()
    setTransport(undefined)
    await drainQueue(quiet)
    const state = currentWatchState(user.id)
    const p = latestTasteProfile(user.id)!
    expect(needsRebuild(p, state).needed).toBe(false)
    expect(needsRebuild(undefined, state).needed).toBe(true)
    const changed = { ...state, log: { ...state.log, hash: 'x' } }
    expect(needsRebuild(p, changed).needed).toBe(false)
    expect(needsRebuild({ ...p, watchLogCount: p.watchLogCount - 25 }, changed).needed).toBe(true)
    expect(needsRebuild(p, changed, new Date(Date.now() + 31 * 86400_000)).needed).toBe(true)
    // force rebuild bumps version
    await buildTasteProfile(user.id)
    expect(latestTasteProfile(user.id)!.version).toBe(2)
    setTmdbClient(undefined)
  })
})
