import { NextResponse } from 'next/server'
import { googleConfigured, hasCalendarScope } from '@/calendar/google'
import { getFestivalForUser } from '@/db/repo/festivals'
import { enqueueJob } from '@/jobs/queue'
import { ApiError, requireApiUser, route } from '@/lib/api'

/** 9.4：入队 push_google_calendar；未授权时返回 409 needs_google_auth，前端触发授权后回来继续。 */
export const POST = route(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireApiUser()
  const { id } = await params
  const f = getFestivalForUser(id, user.id)
  if (!f) throw new ApiError(404, 'not_found', '影展不存在')
  if (f.status === 'dismissed') throw new ApiError(409, 'dismissed', '这个影展已经换掉了')
  if (!googleConfigured()) throw new ApiError(422, 'google_not_configured', '服务器没有配置 Google 登录（AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET），请用 .ics 或订阅')
  if (!hasCalendarScope(user.id)) throw new ApiError(409, 'needs_google_auth', '需要先授权 Google 日历')
  const job = enqueueJob('push_google_calendar', { festival_id: f.id, action: 'sync' }, user.id)
  return NextResponse.json({ job_id: job.id }, { status: 202 })
})
