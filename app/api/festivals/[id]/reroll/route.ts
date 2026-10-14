import { NextResponse } from 'next/server'
import { getFestivalForUser } from '@/db/repo/festivals'
import { startReroll } from '@/festival/service'
import { ApiError, requireApiUser, route } from '@/lib/api'

export const POST = route(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireApiUser()
  const { id } = await params
  const f = getFestivalForUser(id, user.id)
  if (!f) throw new ApiError(404, 'not_found', '影展不存在')
  if (f.status === 'dismissed') throw new ApiError(409, 'dismissed', '这个影展已经换掉了')
  const r = startReroll(user, f)
  return NextResponse.json({ job_id: r.job.id, rerolls_left: r.rerollsLeft }, { status: 202 })
})
