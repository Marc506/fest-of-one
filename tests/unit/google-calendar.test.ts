import { afterEach, describe, expect, it, vi } from 'vitest'
import { feedEvents } from '@/calendar/feed'
import { accessToken, CALENDAR_SCOPE, GoogleAuthRequired, GoogleCalendarClient, hasCalendarScope } from '@/calendar/google'
import { buildIcs } from '@/calendar/ics'
import { getDb } from '@/db/client'
import { getFestival, getScreenings } from '@/db/repo/festivals'
import { getUser } from '@/db/repo/users'
import { accounts } from '@/db/schema'
import { startGeneration, startReroll } from '@/festival/service'
import { fixtureClient, PERSONAS, seedCatalogFilms, seedPersona } from '@/fixtures/seed'
import { enqueueJob } from '@/jobs/queue'
import { drainQueue } from '@/jobs/worker'
import { getJob } from '@/db/repo/jobs'
import { setTransport } from '@/llm/client'
import { MockCuratorTransport } from '@/llm/mock-curator'
import { setTmdbClient } from '@/resolver/tmdb'
import { addDays, currentWeekStart } from '@/scheduler/slots'
import { buildTasteProfile } from '@/taste/profile'
import type { CalendarEvent } from '@/calendar/event'
import { quiet } from '../helpers'

const EVENT: CalendarEvent = {
  uid: 'screening-x@fest-of-one',
  sequence: 0,
  summary: 's',
  description: 'd',
  url: 'http://x/festival/f',
  start: '2026-10-21T11:30:00.000Z',
  end: '2026-10-21T13:00:00.000Z',
  alarmMin: 30,
  tmdbId: 1,
}

function linkGoogle(userId: string, opts: { scope?: string; expiresAt?: number; refresh?: string | null } = {}) {
  getDb()
    .insert(accounts)
    .values({
      userId,
      type: 'oidc',
      provider: 'google',
      providerAccountId: `g-${userId}`,
      access_token: 'old-token',
      refresh_token: opts.refresh === undefined ? 'refresh-1' : opts.refresh,
      expires_at: opts.expiresAt ?? Math.floor(Date.now() / 1000) + 3600,
      scope: opts.scope ?? `openid email ${CALENDAR_SCOPE}`,
    })
    .run()
}

type Call = { method: string; url: string; body?: unknown }
function fakeGoogle(handler: (c: Call) => Response) {
  const calls: Call[] = []
  const f = async (input: string | URL, init?: RequestInit) => {
    const c: Call = { method: init?.method ?? 'GET', url: String(input), body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body }
    calls.push(c)
    return handler(c)
  }
  return { f, calls }
}

async function festivalFixture() {
  setTransport(new MockCuratorTransport())
  setTmdbClient(fixtureClient())
  await seedCatalogFilms()
  const user = seedPersona(PERSONAS.find((p) => p.key === 'slow')!)
  await buildTasteProfile(user.id)
  const g = startGeneration(user, { weekStart: addDays(currentWeekStart(user.tz), 7), days: 2, filmCount: 3 })
  await drainQueue(quiet)
  const fid = (getJob(g.job.id)!.result as { festival_id: string }).festival_id
  return { user: getUser(user.id)!, fid }
}

afterEach(() => {
  vi.unstubAllGlobals()
  setTransport(undefined)
  setTmdbClient(undefined)
})

describe('Google Calendar (9.4)', () => {
  it('requires the calendar scope and refreshes expired tokens', async () => {
    const { user } = await festivalFixture()
    await expect(accessToken(user.id)).rejects.toBeInstanceOf(GoogleAuthRequired)
    expect(hasCalendarScope(user.id)).toBe(false)
    linkGoogle(user.id, { expiresAt: Math.floor(Date.now() / 1000) - 10 })
    expect(hasCalendarScope(user.id)).toBe(true)
    const g = fakeGoogle(() => Response.json({ access_token: 'fresh', expires_in: 3600 }))
    expect(await accessToken(user.id, g.f)).toBe('fresh')
    expect(g.calls[0]!.url).toBe('https://oauth2.googleapis.com/token')
    // 写回后不再刷新
    expect(await accessToken(user.id, g.f)).toBe('fresh')
    expect(g.calls).toHaveLength(1)
  }, 60_000)

  it('upserts idempotently: insert, 409 → lookup by iCalUID → update, update by id', async () => {
    let n = 0
    const g = fakeGoogle((c) => {
      if (c.method === 'POST') return n++ === 0 ? Response.json({ id: 'ev1' }) : new Response('dup', { status: 409 })
      if (c.method === 'GET') return Response.json({ items: [{ id: 'ev1' }] })
      if (c.method === 'PUT') return Response.json({ id: 'ev1' })
      return new Response(null, { status: 204 })
    })
    const client = new GoogleCalendarClient('tok', g.f)
    expect(await client.upsert(EVENT, null)).toBe('ev1')
    expect(g.calls[0]!.body).toMatchObject({ iCalUID: EVENT.uid, start: { dateTime: EVENT.start }, reminders: { overrides: [{ minutes: 30 }] } })
    expect(g.calls[0]!.body).not.toHaveProperty('location')
    expect(await client.upsert(EVENT, null)).toBe('ev1') // 409 path
    expect(g.calls.map((c) => c.method)).toEqual(['POST', 'POST', 'GET', 'PUT'])
    expect(await client.upsert(EVENT, 'ev1')).toBe('ev1')
    expect(g.calls.at(-1)!.method).toBe('PUT')
    await client.remove('gone') // 204
  })

  it('push job writes every scheduled screening, reroll deletes them', async () => {
    const { user, fid } = await festivalFixture()
    linkGoogle(user.id)
    let id = 0
    const g = fakeGoogle((c) => (c.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ id: `ev${++id}` })))
    vi.stubGlobal('fetch', g.f)
    enqueueJob('push_google_calendar', { festival_id: fid, action: 'sync' }, user.id)
    await drainQueue(quiet)
    const list = getScreenings(fid)
    expect(list.filter((s) => s.startsAt).every((s) => s.googleEventId)).toBe(true)
    expect(getFestival(fid)!.googleCalendarSyncedAt).toBeTruthy()

    startReroll(user, getFestival(fid)!)
    await drainQueue(quiet)
    expect(getScreenings(fid).every((s) => s.googleEventId == null)).toBe(true)
    expect(g.calls.filter((c) => c.method === 'DELETE')).toHaveLength(list.filter((s) => s.startsAt).length)
  }, 60_000)

  it('webcal feed: published festivals within -30/+60 days, dismissed excluded', async () => {
    const { user, fid } = await festivalFixture()
    const events = feedEvents(user, new Date(), 'https://fest.example.com')
    const uids = new Set(getScreenings(fid).map((s) => s.calendarUid))
    expect(events.length).toBe(uids.size)
    expect(events.every((e) => uids.has(e.uid))).toBe(true)
    expect(buildIcs(events, { name: 'x', refreshHours: 6 })).toContain('REFRESH-INTERVAL;VALUE=DURATION:PT6H')
    expect(feedEvents(user, new Date(Date.now() + 120 * 86400_000))).toHaveLength(0)
    startReroll(user, getFestival(fid)!)
    expect(feedEvents(user).some((e) => uids.has(e.uid))).toBe(false)
  }, 60_000)
})
