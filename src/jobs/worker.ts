/**
 * 独立 worker 进程（`pnpm worker`）：轮询 jobs 表执行任务。ARCHITECTURE.md 第 11 章。
 *
 *   pnpm worker          常驻
 *   pnpm worker --once   处理完当前队列后退出（脚本 / 测试用）
 */
import '@/lib/load-env'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import {
  claimNextJob,
  completeJob,
  failJob,
  heartbeatJob,
  recoverStaleJobs,
  requeueJob,
  setJobProgress,
} from '@/db/repo/jobs'
import { runMigrations } from '@/db/migrate'
import type { Job } from '@/db/schema'
import { sleep } from '@/lib/time'
import { enqueueDueRssSyncs } from '@/sources/schedule'
import { handlers } from './handlers'

const HEARTBEAT_MS = 10_000
const IDLE_POLL_MS = 1_000
const STALE_SCAN_MS = 60_000
/** 错误重试：SDK 自带 2 次重试，job 层再给 1 次 → 最多执行 2 次。 */
export const MAX_ERROR_ATTEMPTS = 2

function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  if ('retryable' in err && (err as { retryable?: boolean }).retryable) return true
  // Anthropic SDK / fetch 连接类错误：只按 name 判断，避免 worker 依赖 SDK 实例化
  const name = (err as { name?: string }).name ?? ''
  return ['RateLimitError', 'APIConnectionError', 'APIConnectionTimeoutError', 'InternalServerError'].includes(name)
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export async function runJob(job: Job, log: (...a: unknown[]) => void = console.log): Promise<'done' | 'failed' | 'requeued'> {
  const handler = handlers[job.type]
  const tag = `[worker] ${job.type}#${job.id}`
  if (!handler) {
    failJob(job.id, `未知任务类型 ${job.type}`)
    log(`${tag} failed: unknown type`)
    return 'failed'
  }
  const hb = setInterval(() => heartbeatJob(job.id), HEARTBEAT_MS)
  const started = Date.now()
  try {
    const payload = handler.payload.parse(job.payload)
    const result = await handler.run({
      job,
      payload,
      userId: job.userId,
      progress: (pct, message) => setJobProgress(job.id, pct, message),
      log: (...a) => log(tag, ...a),
    })
    completeJob(job.id, result)
    log(`${tag} done in ${Date.now() - started}ms`)
    return 'done'
  } catch (err) {
    const msg = errorMessage(err)
    if (isRetryable(err) && job.attempts < MAX_ERROR_ATTEMPTS) {
      requeueJob(job.id, msg)
      log(`${tag} retryable error, requeued (attempt ${job.attempts}): ${msg}`)
      return 'requeued'
    }
    failJob(job.id, msg)
    log(`${tag} failed: ${msg}`)
    if (!(err as { userFacing?: boolean })?.userFacing && err instanceof Error && err.stack) log(err.stack)
    return 'failed'
  } finally {
    clearInterval(hb)
  }
}

/** 处理队列直到为空（--once / 测试）。 */
export async function drainQueue(log?: (...a: unknown[]) => void): Promise<number> {
  let n = 0
  for (let job = claimNextJob(); job; job = claimNextJob()) {
    await runJob(job, log)
    n++
  }
  return n
}

async function main() {
  const once = process.argv.includes('--once')
  runMigrations()
  const rec = recoverStaleJobs()
  if (rec.requeued || rec.failed) console.log(`[worker] stale recovery: requeued ${rec.requeued}, failed ${rec.failed}`)

  if (once) {
    const n = await drainQueue()
    console.log(`[worker] --once processed ${n} job(s)`)
    return
  }

  let stopping = false
  let current: Job | undefined
  const stop = (sig: string) => {
    if (stopping) process.exit(1)
    stopping = true
    console.log(`[worker] ${sig} received, finishing current job…`)
    // 当前任务若在宽限期内没完成，交还队列，由下一次启动继续（handler 均幂等）
    setTimeout(() => {
      if (current) requeueJob(current.id, 'worker 关闭时中断')
      process.exit(0)
    }, 5_000).unref()
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))

  const staleTimer = setInterval(() => {
    const r = recoverStaleJobs()
    if (r.requeued || r.failed) console.log(`[worker] stale recovery: requeued ${r.requeued}, failed ${r.failed}`)
  }, STALE_SCAN_MS)
  // Letterboxd RSS 定时增量
  const rssTimer = setInterval(() => {
    const n = enqueueDueRssSyncs()
    if (n) console.log(`[worker] enqueued ${n} RSS sync(s)`)
  }, 10 * 60_000)

  console.log('[worker] started; polling jobs')
  while (!stopping) {
    current = claimNextJob()
    if (!current) {
      await sleep(IDLE_POLL_MS)
      continue
    }
    await runJob(current)
    current = undefined
  }
  clearInterval(staleTimer)
  clearInterval(rssTimer)
  process.exit(0)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('[worker] fatal', err)
    process.exit(1)
  })
}
