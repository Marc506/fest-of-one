import { desc, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { getDb } from '@/db/client'
import { festivalRequests } from '@/db/schema'
import { getFestival, getFestivalRequest, getScreenings, festivalsForRequest } from '@/db/repo/festivals'
import { getJob } from '@/db/repo/jobs'
import { putAvailability } from '@/db/repo/availability'
import { startGeneration, startReroll, MAX_REROLLS } from '@/festival/service'
import { fixtureClient, PERSONAS, seedCatalogFilms, seedPersona } from '@/fixtures/seed'
import { drainQueue } from '@/jobs/worker'
import { setTransport } from '@/llm/client'
import { MockCuratorTransport } from '@/llm/mock-curator'
import { setTmdbClient } from '@/resolver/tmdb'
import { addDays, currentWeekStart } from '@/scheduler/slots'
import { buildTasteProfile } from '@/taste/profile'
import { quiet } from '../helpers'

function getLatestRequestId(userId: string): string {
  return getDb().select().from(festivalRequests).where(eq(festivalRequests.userId, userId)).orderBy(desc(festivalRequests.createdAt)).get()!.id
}

async function setup() {
  setTransport(new MockCuratorTransport())
  setTmdbClient(fixtureClient())
  await seedCatalogFilms()
  const user = seedPersona(PERSONAS.find((p) => p.key === 'genre')!)
  await buildTasteProfile(user.id)
  return user
}

describe('generate → festival → reroll (M4)', () => {
  it('generates through the worker, persists a scheduled festival, rerolls with accumulated avoid', async () => {
    const user = await setup()
    const week = addDays(currentWeekStart(user.tz), 7)
    const g = startGeneration(user, { weekStart: week, days: 3, filmCount: 4 })
    await drainQueue(quiet)
    const job = getJob(g.job.id)!
    expect(job.status).toBe('done')
    const fid = (job.result as { festival_id: string }).festival_id
    const f1 = getFestival(fid)!
    expect(f1.status).toBe('published')
    const s1 = getScreenings(fid)
    expect(s1).toHaveLength(4)
    expect(s1.every((s) => s.startsAt && s.endsAt && s.calendarUid === `screening-${s.id}@fest-of-one`)).toBe(true)

    const r = startReroll(user, f1)
    await drainQueue(quiet)
    expect(getFestival(fid)!.status).toBe('dismissed')
    const req = getFestivalRequest(f1.requestId)!
    expect(req.rerollCount).toBe(1)
    expect(req.avoid.subjects).toContain(f1.subject)
    expect(req.avoid.tmdb_ids).toEqual(expect.arrayContaining(s1.map((s) => s.tmdbId)))
    const f2id = (getJob(r.job.id)!.result as { festival_id: string }).festival_id
    const f2 = getFestival(f2id)!
    expect(f2.subject).not.toBe(f1.subject)
    expect(getScreenings(f2id).some((s) => s1.map((x) => x.tmdbId).includes(s.tmdbId))).toBe(false)
    expect(festivalsForRequest(f1.requestId).filter((f) => f.status !== 'dismissed')).toHaveLength(1)
  }, 60_000)

  it('caps rerolls at 5 per request', async () => {
    const user = await setup()
    const week = addDays(currentWeekStart(user.tz), 7)
    startGeneration(user, { weekStart: week, days: 2, filmCount: 2 })
    await drainQueue(quiet)
    for (let i = 0; i < MAX_REROLLS; i++) {
      const req = festivalsForRequest(getFestivalRequest(getLatestRequestId(user.id))!.id)
      const current = req.find((f) => f.status !== 'dismissed')
      if (!current) break
      startReroll(user, current)
      await drainQueue(quiet)
    }
    const cur = festivalsForRequest(getLatestRequestId(user.id)).find((f) => f.status !== 'dismissed')
    if (cur) expect(() => startReroll(user, cur)).toThrow(/5 次/)
  }, 120_000)

  it('rejects infeasible requests up front and weeks other than this / next', async () => {
    const user = await setup()
    const week = addDays(currentWeekStart(user.tz), 7)
    putAvailability(user.id, week, 'available', [{ dow: 2, start: '20:00', end: '21:00' }])
    expect(() => startGeneration(user, { weekStart: week, days: 1, filmCount: 1 })).toThrow(/没有可用时间/)
    putAvailability(user.id, week, 'available', [{ dow: 2, start: '19:00', end: '23:00' }])
    expect(() => startGeneration(user, { weekStart: week, days: 1, filmCount: 4 })).toThrow(/最多排/)
    expect(() => startGeneration(user, { weekStart: addDays(week, 14), days: 1, filmCount: 1 })).toThrow(/本周或下周/)
  }, 60_000)
})
