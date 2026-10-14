'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { JobProgressBar, useJob } from '../_components/JobProgress'
import { Button } from '../_components/ui'

/** 用当前规则重新匹配全部待确认条目。 */
export function RematchButton({ count }: { count: number }) {
  const router = useRouter()
  const [jobId, setJobId] = useState<string | null>(null)
  const job = useJob(jobId, 1500)
  useEffect(() => {
    if (job?.status === 'done' || job?.status === 'failed') router.refresh()
  }, [job?.status, router])
  const running = job?.status === 'queued' || job?.status === 'running'
  return (
    <div className="w-72 space-y-2">
      <Button
        variant="outline"
        disabled={running || count === 0}
        onClick={async () => {
          const res = await fetch('/api/library/rematch', { method: 'POST' })
          if (res.ok) setJobId((await res.json()).job_id)
        }}
      >
        重新匹配这 {count} 条
      </Button>
      <JobProgressBar job={job} />
    </div>
  )
}

/** 被识别为非电影的条目：可以恢复到待确认。 */
export function NotFilmList({ items }: { items: { id: number; titleRaw: string; provider: string }[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState<number | null>(null)
  if (!items.length) return null
  return (
    <details className="rounded border border-rule p-4 text-sm">
      <summary className="cursor-pointer text-muted">已跳过的非电影条目 · {items.length}（剧集 / 综艺等，不进片库、不进待确认；认错了可以恢复）</summary>
      <ul className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
        {items.map((a) => (
          <li key={a.id} className="flex items-center justify-between gap-2">
            <span className="truncate">{a.titleRaw}</span>
            <button
              className="shrink-0 text-xs text-muted underline"
              disabled={busy !== null}
              onClick={async () => {
                setBusy(a.id)
                await fetch('/api/library/not-film', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ alias_id: a.id, not_film: false }),
                })
                setBusy(null)
                router.refresh()
              }}
            >
              {busy === a.id ? '…' : '其实是电影'}
            </button>
          </li>
        ))}
      </ul>
    </details>
  )
}
