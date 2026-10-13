import { NextResponse } from 'next/server'
import { enqueueJob } from '@/jobs/queue'
import { ApiError, requireApiUser, route } from '@/lib/api'

/** 仅开发：入队一个 demo 任务，验证 web → jobs 表 → worker 链路。 */
export const POST = route(async () => {
  if (process.env.DEV_LOGIN !== '1') throw new ApiError(404, 'not_found', 'Not found')
  const user = await requireApiUser()
  const job = enqueueJob('demo', { steps: 5, ms: 400 }, user.id)
  return NextResponse.json({ job_id: job.id })
})
