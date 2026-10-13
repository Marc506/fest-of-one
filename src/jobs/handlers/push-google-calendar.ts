import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { eventsForFestival } from '@/calendar/feed'
import { accessToken, GoogleCalendarClient } from '@/calendar/google'
import { getDb } from '@/db/client'
import { getFestivalForUser, getScreenings } from '@/db/repo/festivals'
import { getUser } from '@/db/repo/users'
import { festivals, screenings } from '@/db/schema'
import { nowIso } from '@/lib/time'
import { defineHandler, UserFacingError } from '../types'

/** 9.4：把一个影展的全部场次写进 Google 日历（sync），或删掉之前写过的（delete，用于换一个 / 不要了）。 */
export const pushGoogleCalendarHandler = defineHandler({
  payload: z.object({ festival_id: z.string(), action: z.enum(['sync', 'delete']).default('sync') }),
  async run({ payload, userId, progress }) {
    const user = userId ? getUser(userId) : undefined
    const f = user ? getFestivalForUser(payload.festival_id, user.id) : undefined
    if (!user || !f) throw new UserFacingError('影展不存在')
    const client = new GoogleCalendarClient(await accessToken(user.id))
    const db = getDb()
    const list = getScreenings(f.id)
    if (payload.action === 'delete') {
      const withIds = list.filter((s) => s.googleEventId)
      for (const [i, s] of withIds.entries()) {
        await client.remove(s.googleEventId!)
        db.update(screenings).set({ googleEventId: null }).where(eq(screenings.id, s.id)).run()
        progress(((i + 1) / withIds.length) * 100, `删除 ${i + 1}/${withIds.length}`)
      }
      db.update(festivals).set({ googleCalendarSyncedAt: null }).where(eq(festivals.id, f.id)).run()
      return { deleted: withIds.length }
    }
    const events = new Map(eventsForFestival(f, user).map((e) => [e.uid, e]))
    let n = 0
    for (const s of list) {
      const e = events.get(s.calendarUid)
      if (!e) continue
      const id = await client.upsert(e, s.googleEventId)
      db.update(screenings).set({ googleEventId: id }).where(eq(screenings.id, s.id)).run()
      n++
      progress((n / events.size) * 100, `写入 Google 日历 ${n}/${events.size}`)
    }
    db.update(festivals).set({ googleCalendarSyncedAt: nowIso() }).where(eq(festivals.id, f.id)).run()
    return { synced: n }
  },
})
