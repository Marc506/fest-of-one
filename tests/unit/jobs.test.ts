import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { jobs } from '@/db/schema'
import { claimNextJob, getJob, recoverStaleJobs } from '@/db/repo/jobs'
import { upsertUserByEmail } from '@/db/repo/users'
import { enqueueJob } from '@/jobs/queue'
import { drainQueue, runJob } from '@/jobs/worker'

const quiet = () => {}

describe('jobs queue', () => {
  it('runs a demo job from queued to done', async () => {
    const u = upsertUserByEmail('a@test')
    const job = enqueueJob('demo', { steps: 2, ms: 1 }, u.id)
    expect(job.status).toBe('queued')
    expect(await drainQueue(quiet)).toBe(1)
    const done = getJob(job.id)!
    expect(done.status).toBe('done')
    expect(done.progress).toBe(100)
    expect(done.attempts).toBe(1)
    expect(done.result).toEqual({ ok: true, steps: 2 })
  })

  it('rejects invalid payloads at enqueue time', () => {
    expect(() => enqueueJob('demo', { steps: 999 }, null)).toThrow()
  })

  it('claims jobs in FIFO order and only once', () => {
    const a = enqueueJob('demo', {}, null)
    const b = enqueueJob('demo', {}, null)
    expect(claimNextJob()?.id).toBe(a.id)
    expect(claimNextJob()?.id).toBe(b.id)
    expect(claimNextJob()).toBeUndefined()
  })

  it('recovers stale running jobs and fails them after 3 attempts', () => {
    const j = enqueueJob('demo', {}, null)
    claimNextJob()
    const old = new Date(Date.now() - 3 * 60_000).toISOString()
    getDb().update(jobs).set({ heartbeatAt: old }).where(eq(jobs.id, j.id)).run()
    expect(recoverStaleJobs()).toEqual({ requeued: 1, failed: 0 })
    expect(getJob(j.id)!.status).toBe('queued')

    getDb().update(jobs).set({ status: 'running', attempts: 3, heartbeatAt: old }).where(eq(jobs.id, j.id)).run()
    expect(recoverStaleJobs()).toEqual({ requeued: 0, failed: 1 })
    expect(getJob(j.id)!.status).toBe('failed')
  })

  it('marks unknown job types failed', async () => {
    const row = getDb().insert(jobs).values({ type: 'build_taste', payload: {} }).returning().get()
    const claimed = claimNextJob()!
    expect(claimed.id).toBe(row.id)
    expect(await runJob(claimed, quiet)).toBe('failed')
  })
})
