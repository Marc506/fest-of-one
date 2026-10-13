import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getFestivalForUser, setFestivalStatus } from '@/db/repo/festivals'
import { setScreeningFeedback } from '@/festival/feedback'
import { enqueueJob } from '@/jobs/queue'
import { ApiError, parseJson, requireApiUser, route } from '@/lib/api'

const Body = z.union([
  z.object({ screening_id: z.string(), feedback: z.enum(['watched', 'skipped', 'not_interested']).nullable() }),
  z.object({ dismiss: z.literal(true) }),
])

export const POST = route(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireApiUser()
  const { id } = await params
  const f = getFestivalForUser(id, user.id)
  if (!f) throw new ApiError(404, 'not_found', '影展不存在')
  const body = await parseJson(req, Body)
  if ('dismiss' in body) {
    setFestivalStatus(f.id, 'dismissed')
    if (f.googleCalendarSyncedAt) enqueueJob('push_google_calendar', { festival_id: f.id, action: 'delete' }, user.id)
    return NextResponse.json({ ok: true, status: 'dismissed' })
  }
  const s = setScreeningFeedback(user.id, f, body.screening_id, body.feedback)
  return NextResponse.json({ ok: true, screening_id: s.id, feedback: s.feedback })
})
