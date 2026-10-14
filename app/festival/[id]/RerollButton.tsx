'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { JobProgressBar, useJob } from '../../_components/JobProgress'
import { Button } from '../../_components/ui'

export function RerollButton({ festivalId, left }: { festivalId: string; left: number }) {
  const router = useRouter()
  const [jobId, setJobId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const job = useJob(jobId)
  useEffect(() => {
    const id = (job?.result as { festival_id?: string } | null)?.festival_id
    if (job?.status === 'done' && id) router.push(`/festival/${id}`)
  }, [job, router])
  const busy = job?.status === 'queued' || job?.status === 'running'
  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        disabled={busy || left <= 0}
        title={left <= 0 ? '这一周已经换了 5 次' : `还能换 ${left} 次`}
        onClick={async () => {
          setErr(null)
          const res = await fetch(`/api/festivals/${festivalId}/reroll`, { method: 'POST' })
          const body = await res.json()
          if (!res.ok) setErr(body.error?.message ?? '失败')
          else setJobId(body.job_id)
        }}
      >
        {busy ? '换一个…' : '换一个'}
      </Button>
      {err && <p className="text-xs text-accent">{err}</p>}
      {job && (
        <div className="w-64">
          <JobProgressBar job={job} />
        </div>
      )}
    </div>
  )
}
