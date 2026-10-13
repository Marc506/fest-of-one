/** Letterboxd RSS 定时增量：worker 每 10 分钟检查一次，距上次同步 ≥ 12 小时的 RSS 来源入队。豆瓣抓取只手动触发。 */
import { and, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm'
import { getDb } from '@/db/client'
import { jobs, sourceAccounts } from '@/db/schema'
import { enqueueJob } from '@/jobs/queue'

export const RSS_INTERVAL_MS = 12 * 3600_000

export function enqueueDueRssSyncs(now = Date.now()): number {
  const db = getDb()
  const cutoff = new Date(now - RSS_INTERVAL_MS).toISOString()
  const due = db
    .select()
    .from(sourceAccounts)
    .where(and(eq(sourceAccounts.syncMode, 'rss'), or(isNull(sourceAccounts.lastSyncAt), lt(sourceAccounts.lastSyncAt, cutoff))))
    .all()
  let n = 0
  for (const s of due) {
    const pending = db
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.type, 'sync_source'), inArray(jobs.status, ['queued', 'running']), sql`json_extract(${jobs.payload}, '$.source_id') = ${s.id}`))
      .get()
    if (pending) continue
    enqueueJob('sync_source', { source_id: s.id, full: false }, s.userId)
    n++
  }
  return n
}
