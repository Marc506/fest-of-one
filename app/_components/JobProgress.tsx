'use client'

import { useEffect, useState } from 'react'
import { CANCELLED_MESSAGE, isCancellable } from '@/jobs/cancellable'

export type JobView = {
  id: string
  type?: string
  status: 'queued' | 'running' | 'done' | 'failed'
  progress: number
  message: string | null
  result: unknown
  error: string | null
}

/** 轮询 /api/jobs/{id}，直到 done / failed。 */
export function useJob(jobId: string | null, intervalMs = 1000): JobView | null {
  const [job, setJob] = useState<JobView | null>(null)
  useEffect(() => {
    if (!jobId) {
      setJob(null)
      return
    }
    let stopped = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: 'no-store' })
        if (res.ok) {
          const j = (await res.json()) as JobView
          if (stopped) return
          setJob(j)
          if (j.status === 'done' || j.status === 'failed') return
        }
      } catch {
        // 网络抖动：下次再试
      }
      if (!stopped) timer = setTimeout(tick, intervalMs)
    }
    void tick()
    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }, [jobId, intervalMs])
  return job
}

export function JobProgressBar({ job }: { job: JobView | null }) {
  const [cancelErr, setCancelErr] = useState<string | null>(null)
  if (!job) return null
  const cancelled = job.status === 'failed' && job.error === CANCELLED_MESSAGE
  const label =
    job.status === 'queued'
      ? '排队中…'
      : job.status === 'running'
        ? (job.message ?? '进行中…')
        : job.status === 'done'
          ? (job.message ?? '完成')
          : cancelled
            ? '已取消'
            : `失败：${job.error ?? '未知错误'}`
  const cancel = async () => {
    setCancelErr(null)
    const res = await fetch(`/api/jobs/${job.id}/cancel`, { method: 'POST' })
    if (!res.ok) setCancelErr((await res.json()).error?.message ?? '取消失败')
  }
  return (
    <div className="space-y-1">
      <div className="h-1.5 w-full overflow-hidden rounded bg-rule">
        <div
          className={`h-full transition-all ${job.status === 'failed' ? 'bg-accent' : 'bg-ink'}`}
          style={{ width: `${job.status === 'done' ? 100 : job.progress}%` }}
        />
      </div>
      <p className={`text-xs ${job.status === 'failed' && !cancelled ? 'text-accent' : 'text-muted'}`}>
        {label}
        {job.status === 'queued' && isCancellable(job.type) && (
          <button type="button" className="ml-2 underline hover:text-ink" onClick={cancel}>
            取消
          </button>
        )}
        {cancelErr && <span className="ml-2 text-accent">{cancelErr}</span>}
      </p>
    </div>
  )
}
