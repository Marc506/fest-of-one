import { NextResponse } from 'next/server'
import { cancelQueuedJob, getJobForUser } from '@/db/repo/jobs'
import { isCancellable } from '@/jobs/cancellable'
import { ApiError, requireApiUser, route } from '@/lib/api'

/** 取消排队中的任务；已经开始跑的不能取消（让它跑完，避免半途中断）。 */
export const POST = route(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireApiUser()
  const { id } = await params
  const job = getJobForUser(id, user.id)
  if (!job) throw new ApiError(404, 'not_found', '任务不存在')
  if (!isCancellable(job.type)) throw new ApiError(409, 'not_cancellable', '这类任务不能取消')
  if (!cancelQueuedJob(job.id, user.id)) throw new ApiError(409, 'not_queued', '任务已经开始了，只能等它完成')
  return NextResponse.json({ ok: true })
})
