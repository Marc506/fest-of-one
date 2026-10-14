'use client'

import { useState } from 'react'
import { JobProgressBar, useJob } from './JobProgress'

export function DemoJobButton() {
  const [jobId, setJobId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const job = useJob(jobId)
  return (
    <div className="space-y-3">
      <button
        className="rounded-full border border-ink px-4 py-1.5 text-sm"
        onClick={async () => {
          setErr(null)
          const res = await fetch('/api/dev/demo-job', { method: 'POST' })
          const body = await res.json()
          if (!res.ok) setErr(body.error?.message ?? '失败')
          else setJobId(body.job_id)
        }}
      >
        入队一个 demo job
      </button>
      {err && <p className="text-sm text-accent">{err}</p>}
      <JobProgressBar job={job} />
      {job?.status === 'queued' && <p className="text-xs text-muted">若一直排队，确认 `pnpm worker` 在运行。</p>}
    </div>
  )
}
