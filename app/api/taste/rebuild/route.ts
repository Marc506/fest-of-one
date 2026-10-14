import { NextResponse } from 'next/server'
import { enqueueUnique } from '@/jobs/queue'
import { requireApiUser, route } from '@/lib/api'

export const POST = route(async () => {
  const user = await requireApiUser()
  // 已经在排队或在跑的重建直接复用，不会重复花一次调用
  const { job, reused } = enqueueUnique('build_taste', { force: true }, user.id, { reuseRunning: true })
  return NextResponse.json({ job_id: job.id, reused })
})
