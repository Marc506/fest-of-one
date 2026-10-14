import type { Job, JobType } from '@/db/schema'
import { findActiveJob, insertJob } from '@/db/repo/jobs'
import { handlers } from './handlers'

/** 入队。payload 在入队时就按 handler 的 schema 校验，避免 worker 端才发现坏数据。 */
export function enqueueJob(type: JobType, payload: unknown, userId: string | null) {
  const handler = handlers[type]
  if (!handler) throw new Error(`No handler registered for job type ${type}`)
  const parsed = handler.payload.parse(payload)
  return insertJob({ type, payload: parsed, userId })
}

/**
 * 同一用户同一类任务不重复排队：已有排队中的就复用它（它开始跑时读的是最新状态）。
 * reuseRunning：正在跑的也算（手动「重建画像」）；设置变了要等正在跑的结束后再跑一次，就不复用 running。
 */
export function enqueueUnique(type: JobType, payload: unknown, userId: string, opts: { reuseRunning?: boolean } = {}): { job: Job; reused: boolean } {
  const existing = findActiveJob(userId, type, opts.reuseRunning ? ['queued', 'running'] : ['queued'])
  if (existing) return { job: existing, reused: true }
  return { job: enqueueJob(type, payload, userId), reused: false }
}

