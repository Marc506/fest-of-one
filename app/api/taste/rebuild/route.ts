import { NextResponse } from 'next/server'
import { enqueueJob } from '@/jobs/queue'
import { requireApiUser, route } from '@/lib/api'

export const POST = route(async () => {
  const user = await requireApiUser()
  const job = enqueueJob('build_taste', { force: true }, user.id)
  return NextResponse.json({ job_id: job.id })
})
