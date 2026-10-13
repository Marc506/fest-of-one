import type { JobType } from '@/db/schema'
import { insertJob } from '@/db/repo/jobs'
import { handlers } from './handlers'

/** 入队。payload 在入队时就按 handler 的 schema 校验，避免 worker 端才发现坏数据。 */
export function enqueueJob(type: JobType, payload: unknown, userId: string | null) {
  const handler = handlers[type]
  if (!handler) throw new Error(`No handler registered for job type ${type}`)
  const parsed = handler.payload.parse(payload)
  return insertJob({ type, payload: parsed, userId })
}
