import { describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { jobs } from '@/db/schema'
import { cancelQueuedJob, claimNextJob, getJob, recoverStaleJobs } from '@/db/repo/jobs'
import { upsertUserByEmail } from '@/db/repo/users'
import { enqueueJob, enqueueUnique } from '@/jobs/queue'
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

describe('dedupe and cancel', () => {
  it('reuses a queued (or running) job instead of queueing a duplicate', () => {
    const user = upsertUserByEmail('dedupe@test')
    const a = enqueueUnique('build_taste', { force: true }, user.id, { reuseRunning: true })
    const b = enqueueUnique('build_taste', { force: true }, user.id, { reuseRunning: true })
    expect(a.reused).toBe(false)
    expect(b).toMatchObject({ reused: true, job: { id: a.job.id } })

    claimNextJob() // a 开始跑
    // 手动重建：正在跑的也算 → 复用；设置变了：只复用排队中的 → 新排一个
    expect(enqueueUnique('build_taste', { force: true }, user.id, { reuseRunning: true }).job.id).toBe(a.job.id)
    const c = enqueueUnique('build_taste', { force: true }, user.id)
    expect(c.reused).toBe(false)
    expect(enqueueUnique('build_taste', { force: true }, user.id).job.id).toBe(c.job.id)
  })

  it('cancels only queued jobs of the same user', () => {
    const user = upsertUserByEmail('cancel@test')
    const other = upsertUserByEmail('other@test')
    const q = enqueueJob('build_taste', { force: true }, user.id)
    expect(cancelQueuedJob(q.id, other.id)).toBe(false)
    expect(cancelQueuedJob(q.id, user.id)).toBe(true)
    expect(getJob(q.id)).toMatchObject({ status: 'failed', error: '已取消' })
    expect(claimNextJob()).toBeUndefined() // 取消的不会再被领走

    const r = enqueueJob('build_taste', { force: true }, user.id)
    claimNextJob()
    expect(cancelQueuedJob(r.id, user.id)).toBe(false) // 已经在跑
    expect(getJob(r.id)!.status).toBe('running')
  })
})
