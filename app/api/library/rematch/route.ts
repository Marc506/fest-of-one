import { NextResponse } from 'next/server'
import { enqueueJob } from '@/jobs/queue'
import { requireApiUser, route } from '@/lib/api'

/** 用当前的匹配规则把「待确认」重新跑一遍（已确认 / 已标为非电影的不动）。 */
export const POST = route(async () => {
  const user = await requireApiUser()
  const job = enqueueJob('enrich_films', { rematch: true }, user.id)
  return NextResponse.json({ job_id: job.id })
})
