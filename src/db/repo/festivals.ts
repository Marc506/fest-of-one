import { and, asc, desc, eq, gte, inArray, isNotNull, ne, sql } from 'drizzle-orm'
import { getDb, tx } from '../client'
import {
  festivalRequests,
  festivals,
  films,
  screenings,
  type AvailabilitySnapshot,
  type Festival,
  type FestivalRequest,
  type Screening,
} from '../schema'
import type { FestivalAvoid } from '../types'

export function createFestivalRequest(input: {
  userId: string
  weekStart: string
  days: number
  filmCount: number
  availabilitySnapshot: AvailabilitySnapshot
  avoid?: FestivalAvoid
  jobId?: string | null
}): FestivalRequest {
  return getDb()
    .insert(festivalRequests)
    .values({ ...input, avoid: input.avoid ?? { kinds: [], subjects: [], tmdb_ids: [] }, jobId: input.jobId ?? null })
    .returning()
    .get()
}

export function getFestivalRequest(id: string): FestivalRequest | undefined {
  return getDb().select().from(festivalRequests).where(eq(festivalRequests.id, id)).get()
}

export function updateFestivalRequest(id: string, patch: Partial<Pick<FestivalRequest, 'avoid' | 'rerollCount' | 'jobId'>>): void {
  getDb().update(festivalRequests).set(patch).where(eq(festivalRequests.id, id)).run()
}

export function getFestival(id: string): Festival | undefined {
  return getDb().select().from(festivals).where(eq(festivals.id, id)).get()
}

export function getFestivalForUser(id: string, userId: string): Festival | undefined {
  return getDb()
    .select()
    .from(festivals)
    .where(and(eq(festivals.id, id), eq(festivals.userId, userId)))
    .get()
}

export function getScreenings(festivalId: string): Screening[] {
  return getDb().select().from(screenings).where(eq(screenings.festivalId, festivalId)).orderBy(asc(screenings.position)).all()
}

export type HistoryItem = {
  festivalId: string
  weekStart: string
  kind: Festival['kind']
  subject: string
  title: string
  status: Festival['status']
  createdAt: string
  films: { tmdbId: number; title: string }[]
}

/** 近 N 周的影展（不含 dismissed），按周倒序。weekStart < beforeWeek。 */
export function recentProgrammes(userId: string, opts: { sinceWeek: string; beforeWeek?: string; includeCurrentRequest?: string }): HistoryItem[] {
  const db = getDb()
  const rows = db
    .select({
      id: festivals.id,
      weekStart: festivalRequests.weekStart,
      kind: festivals.kind,
      subject: festivals.subject,
      title: festivals.title,
      status: festivals.status,
      createdAt: festivals.createdAt,
      requestId: festivals.requestId,
    })
    .from(festivals)
    .innerJoin(festivalRequests, eq(festivalRequests.id, festivals.requestId))
    .where(
      and(
        eq(festivals.userId, userId),
        ne(festivals.status, 'dismissed'),
        gte(festivalRequests.weekStart, opts.sinceWeek),
        ...(opts.beforeWeek ? [sql`${festivalRequests.weekStart} < ${opts.beforeWeek}`] : []),
      ),
    )
    .orderBy(desc(festivalRequests.weekStart), desc(festivals.createdAt))
    .all()
  if (!rows.length) return []
  const scr = db
    .select({ festivalId: screenings.festivalId, tmdbId: screenings.tmdbId, position: screenings.position, title: films.titleEn })
    .from(screenings)
    .innerJoin(films, eq(films.tmdbId, screenings.tmdbId))
    .where(inArray(screenings.festivalId, rows.map((r) => r.id)))
    .orderBy(asc(screenings.position))
    .all()
  return rows.map((r) => ({
    festivalId: r.id,
    weekStart: r.weekStart,
    kind: r.kind,
    subject: r.subject,
    title: r.title,
    status: r.status,
    createdAt: r.createdAt,
    films: scr.filter((s) => s.festivalId === r.id).map((s) => ({ tmdbId: s.tmdbId, title: s.title })),
  }))
}

/** 用户标记「不感兴趣」的片（P5 / 7.4 第 4 条）。 */
export function notInterestedIds(userId: string): Set<number> {
  return new Set(
    getDb()
      .selectDistinct({ id: screenings.tmdbId })
      .from(screenings)
      .where(and(eq(screenings.userId, userId), eq(screenings.feedback, 'not_interested')))
      .all()
      .map((r) => r.id),
  )
}

export type NewScreening = Omit<typeof screenings.$inferInsert, 'id' | 'festivalId' | 'userId' | 'calendarUid'>

/** 一次性写入影展 + 场次（事务；失败不留半个 festival）。 */
export function insertFestivalWithScreenings(
  f: Omit<typeof festivals.$inferInsert, 'id'>,
  items: NewScreening[],
): { festival: Festival; screenings: Screening[] } {
  const db = getDb()
  return tx(() => {
    const festival = db.insert(festivals).values(f).returning().get()
    const rows = items.map((s) => {
      const row = db
        .insert(screenings)
        .values({ ...s, festivalId: festival.id, userId: f.userId, calendarUid: 'pending' })
        .returning()
        .get()
      return db
        .update(screenings)
        .set({ calendarUid: `screening-${row.id}@fest-of-one` })
        .where(eq(screenings.id, row.id))
        .returning()
        .get()
    })
    return { festival, screenings: rows }
  })
}

export function setFestivalStatus(id: string, status: Festival['status']): void {
  getDb().update(festivals).set({ status }).where(eq(festivals.id, id)).run()
}

export function festivalsForRequest(requestId: string): Festival[] {
  return getDb().select().from(festivals).where(eq(festivals.requestId, requestId)).orderBy(asc(festivals.createdAt)).all()
}

export function latestPublishedFestival(userId: string): Festival | undefined {
  return getDb()
    .select()
    .from(festivals)
    .where(and(eq(festivals.userId, userId), isNotNull(festivals.id), ne(festivals.status, 'dismissed')))
    .orderBy(desc(festivals.createdAt))
    .get()
}
