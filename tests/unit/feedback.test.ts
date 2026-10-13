import { describe, expect, it } from 'vitest'
import { assembleContext } from '@/curator/context'
import { ideateUserMessage, formatHistory } from '@/curator/ideate'
import { getFestival, getScreenings, recentProgrammes, notInterestedIds, listFestivalHistory } from '@/db/repo/festivals'
import { getJob } from '@/db/repo/jobs'
import { seenTmdbIds } from '@/db/repo/library'
import { updateUserSettings } from '@/db/repo/users'
import { setScreeningFeedback } from '@/festival/feedback'
import { startGeneration, startReroll } from '@/festival/service'
import { fixtureClient, PERSONAS, seedCatalogFilms, seedPersona } from '@/fixtures/seed'
import { drainQueue } from '@/jobs/worker'
import { setTransport } from '@/llm/client'
import { MockCuratorTransport } from '@/llm/mock-curator'
import { setTmdbClient } from '@/resolver/tmdb'
import { addDays, currentWeekStart } from '@/scheduler/slots'
import { buildTasteProfile } from '@/taste/profile'
import { quiet } from '../helpers'

async function setup() {
  setTransport(new MockCuratorTransport())
  setTmdbClient(fixtureClient())
  await seedCatalogFilms()
  const user = seedPersona(PERSONAS.find((p) => p.key === 'sinophone')!)
  await buildTasteProfile(user.id)
  return user
}

async function generate(user: { id: string; tz: string } & Parameters<typeof startGeneration>[0], week: string, filmCount = 3) {
  const g = startGeneration(user, { weekStart: week, days: 2, filmCount })
  await drainQueue(quiet)
  return (getJob(g.job.id)!.result as { festival_id: string }).festival_id
}

describe('feedback loop (M7)', () => {
  it('not_interested films never come back; watched films become seen; festival completes', async () => {
    const user = await setup()
    const week = addDays(currentWeekStart(user.tz), 7)
    const fid = await generate(user, week)
    const [a, b, c] = getScreenings(fid)
    const f = getFestival(fid)!
    setScreeningFeedback(user.id, f, a!.id, 'not_interested')
    setScreeningFeedback(user.id, f, b!.id, 'watched')
    expect(seenTmdbIds(user.id).has(b!.tmdbId)).toBe(true)
    expect(notInterestedIds(user.id).has(a!.tmdbId)).toBe(true)
    expect(getFestival(fid)!.status).toBe('published')
    setScreeningFeedback(user.id, getFestival(fid)!, c!.id, 'skipped')
    expect(getFestival(fid)!.status).toBe('completed')
    // 撤回「看了」→ 不再算看过；撤回任一反馈 → 回到 published
    setScreeningFeedback(user.id, getFestival(fid)!, b!.id, null)
    expect(seenTmdbIds(user.id).has(b!.tmdbId)).toBe(false)
    expect(getFestival(fid)!.status).toBe('published')
    setScreeningFeedback(user.id, getFestival(fid)!, b!.id, 'watched')

    // 历史与回避进入下一次的 user 消息
    const history = recentProgrammes(user.id, { sinceWeek: addDays(week, -84), beforeWeek: addDays(week, 7) })
    expect(formatHistory(history)).toMatch(/\(not interested\)/)
    expect(formatHistory(history)).toMatch(/\(watched\)/)
    const msg = ideateUserMessage(assembleContext(user.id), {
      mode: 'festival',
      n: 3,
      days: 2,
      today: week,
      slotsSummary: 's',
      maxRuntime: 200,
      history,
      avoid: { kinds: [], subjects: [], tmdb_ids: [...notInterestedIds(user.id)] },
    })
    expect(msg).toContain(`films=[${a!.tmdbId}]`)

    // 之后的若干次生成 / 换一个都不会再排这部
    let cur = await generate(user, week, 4)
    for (let i = 0; i < 3; i++) {
      expect(getScreenings(cur).map((s) => s.tmdbId)).not.toContain(a!.tmdbId)
      expect(getScreenings(cur).map((s) => s.tmdbId)).not.toContain(b!.tmdbId)
      const r = startReroll(user, getFestival(cur)!)
      await drainQueue(quiet)
      cur = (getJob(r.job.id)!.result as { festival_id: string }).festival_id
    }
    expect(listFestivalHistory(user.id, { includeDismissed: true }).length).toBeGreaterThanOrEqual(5)
    expect(listFestivalHistory(user.id, { includeDismissed: false }).every((h) => h.festival.status !== 'dismissed')).toBe(true)
  }, 120_000)

  it('validates settings', async () => {
    const user = await setup()
    const u = updateUserSettings(user.id, { tz: 'America/New_York', locale: 'en', prefs: { ...user.prefs, buffer_min: 30 } })
    expect(u).toMatchObject({ tz: 'America/New_York', locale: 'en' })
    expect(u.prefs.buffer_min).toBe(30)
    expect(() => updateUserSettings(user.id, { prefs: { ...user.prefs, max_films_per_day: 99 } })).toThrow()
  }, 60_000)
})
