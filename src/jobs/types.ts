import type { z } from 'zod'
import type { Job } from '@/db/schema'

export type JobContext<P> = {
  job: Job
  payload: P
  userId: string | null
  /** 进度 0–100 + 可选文案；同时刷新心跳。 */
  progress: (pct: number, message?: string) => void
  log: (...args: unknown[]) => void
}

export type JobHandler<P = unknown> = {
  payload: z.ZodType<P>
  run: (ctx: JobContext<P>) => Promise<unknown>
}

export function defineHandler<P>(h: JobHandler<P>): JobHandler<P> {
  return h
}

/** 注册表里的类型擦除版本：payload 由 handler 自己的 schema 在运行时解析。 */
export type AnyJobHandler = JobHandler<unknown>

export function erase<P>(h: JobHandler<P>): AnyJobHandler {
  return h as unknown as AnyJobHandler
}

/** handler 抛出它表示「可以再试一次」（例如上游 429 / 5xx 在 SDK 重试后仍失败）。 */
export class RetryableError extends Error {
  readonly retryable = true
}

/** 面向用户的失败（可行性检查不通过等），message 直接展示。 */
export class UserFacingError extends Error {
  readonly userFacing = true
}
