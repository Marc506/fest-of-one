import { and, eq, inArray, lt, sql } from 'drizzle-orm'
import { getDb } from '../client'
import { jobs, type Job, type JobType } from '../schema'
import { nowIso } from '@/lib/time'

export const STALE_AFTER_MS = 2 * 60 * 1000
export const MAX_STALE_ATTEMPTS = 3

export function insertJob(input: { type: JobType; payload: unknown; userId: string | null }): Job {
  return getDb()
    .insert(jobs)
    .values({ type: input.type, payload: input.payload, userId: input.userId })
    .returning()
    .get()
}

export function getJobForUser(id: string, userId: string): Job | undefined {
  return getDb()
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.userId, userId)))
    .get()
}

export function getJob(id: string): Job | undefined {
  return getDb().select().from(jobs).where(eq(jobs.id, id)).get()
}

/** 原子领取最早的 queued 任务（条件更新防并发）。 */
export function claimNextJob(): Job | undefined {
  const now = nowIso()
  return getDb()
    .update(jobs)
    .set({ status: 'running', attempts: sql`${jobs.attempts} + 1`, heartbeatAt: now, error: null })
    .where(
      and(
        eq(jobs.status, 'queued'),
        eq(
          jobs.id,
          sql`(select ${jobs.id} from ${jobs} where ${jobs.status} = 'queued' order by ${jobs.createdAt}, rowid limit 1)`,
        ),
      ),
    )
    .returning()
    .get()
}

export function heartbeatJob(id: string): void {
  getDb().update(jobs).set({ heartbeatAt: nowIso() }).where(eq(jobs.id, id)).run()
}

export function setJobProgress(id: string, progress: number, message?: string | null): void {
  const pct = Math.max(0, Math.min(100, Math.round(progress)))
  getDb()
    .update(jobs)
    .set({ progress: pct, ...(message !== undefined ? { message } : {}), heartbeatAt: nowIso() })
    .where(eq(jobs.id, id))
    .run()
}

export function completeJob(id: string, result: unknown): void {
  getDb()
    .update(jobs)
    .set({ status: 'done', progress: 100, result: result ?? null, heartbeatAt: nowIso() })
    .where(eq(jobs.id, id))
    .run()
}

export function failJob(id: string, error: string): void {
  getDb().update(jobs).set({ status: 'failed', error }).where(eq(jobs.id, id)).run()
}

export function requeueJob(id: string, error: string | null): void {
  getDb().update(jobs).set({ status: 'queued', error, heartbeatAt: null }).where(eq(jobs.id, id)).run()
}

/** 僵死恢复：running 且心跳超 2 分钟 → 回 queued（attempts ≤ 3），否则 failed。返回处理条数。 */
export function recoverStaleJobs(now = Date.now()): { requeued: number; failed: number } {
  const cutoff = new Date(now - STALE_AFTER_MS).toISOString()
  const db = getDb()
  const stale = db
    .select({ id: jobs.id, attempts: jobs.attempts })
    .from(jobs)
    .where(and(eq(jobs.status, 'running'), lt(jobs.heartbeatAt, cutoff)))
    .all()
  const toRequeue = stale.filter((j) => j.attempts < MAX_STALE_ATTEMPTS).map((j) => j.id)
  const toFail = stale.filter((j) => j.attempts >= MAX_STALE_ATTEMPTS).map((j) => j.id)
  if (toRequeue.length)
    db.update(jobs)
      .set({ status: 'queued', heartbeatAt: null, message: '恢复僵死任务' })
      .where(inArray(jobs.id, toRequeue))
      .run()
  if (toFail.length)
    db.update(jobs)
      .set({ status: 'failed', error: 'worker 心跳超时且重试次数用尽' })
      .where(inArray(jobs.id, toFail))
      .run()
  return { requeued: toRequeue.length, failed: toFail.length }
}

export function countQueued(): number {
  const row = getDb().select({ n: sql<number>`count(*)` }).from(jobs).where(eq(jobs.status, 'queued')).get()
  return row?.n ?? 0
}
