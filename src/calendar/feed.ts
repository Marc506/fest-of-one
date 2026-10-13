/** 某个影展 / 某个用户订阅源的事件集合。 */
import { and, eq, gte, inArray, isNotNull, lte } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { getScreenings } from '@/db/repo/festivals'
import { getFilms } from '@/db/repo/library'
import { festivals, screenings, type Festival, type User } from '@/db/schema'
import { env } from '@/lib/env'
import { buildEvent, type CalendarEvent } from './event'

export function eventsForFestival(festival: Festival, user: User, baseUrl = env().APP_BASE_URL): CalendarEvent[] {
  const list = getScreenings(festival.id)
  const films = new Map(getFilms(list.map((s) => s.tmdbId)).map((f) => [f.tmdbId, f]))
  return list
    .map((s) => (films.get(s.tmdbId) ? buildEvent({ screening: s, festival, film: films.get(s.tmdbId)!, user, baseUrl }) : null))
    .filter((e): e is CalendarEvent => e != null)
}

/** webcal：用户所有 published / completed 影展，过去 30 天至未来 60 天的场次（9.2）。 */
export function feedEvents(user: User, now = new Date(), baseUrl = env().APP_BASE_URL): CalendarEvent[] {
  const from = new Date(now.getTime() - 30 * 86400_000).toISOString()
  const to = new Date(now.getTime() + 60 * 86400_000).toISOString()
  const db = getDb()
  const rows = db
    .select({ s: screenings, f: festivals })
    .from(screenings)
    .innerJoin(festivals, eq(festivals.id, screenings.festivalId))
    .where(
      and(
        eq(screenings.userId, user.id),
        inArray(festivals.status, ['published', 'completed']),
        isNotNull(screenings.startsAt),
        gte(screenings.startsAt, from),
        lte(screenings.startsAt, to),
      ),
    )
    .all()
  const films = new Map(getFilms(rows.map((r) => r.s.tmdbId)).map((f) => [f.tmdbId, f]))
  return rows
    .map((r) => (films.get(r.s.tmdbId) ? buildEvent({ screening: r.s, festival: r.f, film: films.get(r.s.tmdbId)!, user, baseUrl }) : null))
    .filter((e): e is CalendarEvent => e != null)
    .sort((a, b) => a.start.localeCompare(b.start))
}
