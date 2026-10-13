/**
 * M3 验收（离线）：3 个 fixture 画像各出 1 个影展与 1 个单部推荐，全部通过不变量；
 * kind 轮换生效；模拟缓存下热态命中率；录制回放可以重现同一结果。
 * LLM 用 MockCuratorTransport（确定性桩），TMDB 用离线片目。
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { curate, persistCuration } from '@/curator'
import { assembleContext } from '@/curator/context'
import { checkInvariants } from '@/curator/invariants'
import { createFestivalRequest } from '@/db/repo/festivals'
import { getDefaultAvailability } from '@/db/repo/availability'
import { fixtureClient, PERSONAS, seedCatalogFilms, seedPersona } from '@/fixtures/seed'
import { setTransport } from '@/llm/client'
import { cacheHitRate } from '@/llm/cost'
import { MockCuratorTransport } from '@/llm/mock-curator'
import { ReplayTransport } from '@/llm/replay'
import { setTmdbClient } from '@/resolver/tmdb'
import { addDays } from '@/scheduler/slots'
import { buildTasteProfile } from '@/taste/profile'
import type { User } from '@/db/schema'

const WEEK = '2026-10-19'

async function setup(key: string): Promise<User> {
  setTmdbClient(fixtureClient())
  await seedCatalogFilms()
  const user = seedPersona(PERSONAS.find((p) => p.key === key)!)
  await buildTasteProfile(user.id)
  return user
}

async function run(user: User, weekStart: string, filmCount: number, days: number, persist = true) {
  const availability = getDefaultAvailability(user, weekStart)
  const r = await curate({
    userId: user.id,
    weekStart,
    days,
    filmCount,
    availability,
    avoid: { kinds: [], subjects: [], tmdb_ids: [] },
    today: addDays(weekStart, -1),
    now: new Date(`${weekStart}T00:00:00Z`),
  })
  const ctx = assembleContext(user.id)
  const violations = checkInvariants(r, { seen: ctx.seen, n: filmCount, locale: user.locale, weekStart, prefs: availability.prefs })
  if (persist) {
    const req = createFestivalRequest({
      userId: user.id,
      weekStart,
      days,
      filmCount,
      availabilitySnapshot: { mode: availability.mode, blocks: availability.blocks, prefs: availability.prefs, tz: availability.tz },
    })
    persistCuration(req.id, user.id, r)
  }
  return { r, violations }
}

describe('curator pipeline on fixture personas (M3)', () => {
  beforeEach(() => setTransport(new MockCuratorTransport()))

  for (const p of PERSONAS) {
    it(`${p.key}: one festival (4 films / 3 days) and one single pick pass all invariants`, async () => {
      const user = await setup(p.key)
      const fest = await run(user, WEEK, 4, 3)
      expect(fest.violations).toEqual([])
      expect(fest.r.mode).toBe('festival')
      expect(fest.r.chosen.slate).toHaveLength(4)
      expect(['director', 'country', 'actor', 'motif']).toContain(fest.r.chosen.kind)
      expect(new Set(fest.r.ideate.concepts.map((c) => c.kind)).size).toBeGreaterThanOrEqual(3)

      const single = await run(user, addDays(WEEK, 7), 1, 1)
      expect(single.violations).toEqual([])
      expect(single.r.chosen.kind).toBe('single')
      expect(single.r.chosen.slate).toHaveLength(1)
      // 第二周不会重复第一周的片
      expect(fest.r.chosen.slate.map((s) => s.tmdbId)).not.toContain(single.r.chosen.slate[0]!.tmdbId)
    }, 60_000)
  }

  it('rotates kinds: never the same kind three weeks running, never the same subject within 12 weeks', async () => {
    const user = await setup('genre')
    const kinds: string[] = []
    const subjects: string[] = []
    for (let w = 0; w < 4; w++) {
      const { r, violations } = await run(user, addDays(WEEK, 7 * w), 3, 2)
      expect(violations).toEqual([])
      kinds.push(r.chosen.kind)
      subjects.push(r.chosen.subject)
    }
    for (let i = 2; i < kinds.length; i++) expect(kinds[i] === kinds[i - 1] && kinds[i] === kinds[i - 2]).toBe(false)
    expect(new Set(subjects).size).toBe(subjects.length)
  }, 120_000)

  it('keeps the cached prefix stable: warm runs read ≥ 80% of input from cache (simulated)', async () => {
    const user = await setup('slow')
    await run(user, WEEK, 4, 3, false) // 冷启动
    const warm = await run(user, WEEK, 4, 3, false)
    const hit = cacheHitRate(warm.r.usage)
    expect(hit).toBeGreaterThanOrEqual(0.8)
  }, 60_000)

  it('replays recorded llm_calls offline and reproduces the same festival', async () => {
    const user = await setup('sinophone')
    const first = await run(user, WEEK, 3, 2, false)
    setTransport(new ReplayTransport())
    const again = await run(user, WEEK, 3, 2, false)
    expect(again.r.chosen.slate.map((s) => s.tmdbId)).toEqual(first.r.chosen.slate.map((s) => s.tmdbId))
    expect(again.r.chosen.title).toBe(first.r.chosen.title)
  }, 60_000)

  it('never programmes a seen film even if the model proposes one', async () => {
    const user = await setup('slow')
    const ctx = assembleContext(user.id)
    const { r } = await run(user, WEEK, 4, 3, false)
    for (const g of r.grounded) for (const c of g.candidates) expect(ctx.seen.has(c.tmdb_id)).toBe(false)
  }, 60_000)
})
