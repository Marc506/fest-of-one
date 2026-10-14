import { NextResponse } from 'next/server'
import { getJobForUser } from '@/db/repo/jobs'
import { ApiError, requireApiUser, route } from '@/lib/api'

export const GET = route(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireApiUser()
  const { id } = await params
  const job = getJobForUser(id, user.id)
  if (!job) throw new ApiError(404, 'not_found', '任务不存在')
  return NextResponse.json({
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    message: job.message,
    result: job.result,
    error: job.error,
  })
})
