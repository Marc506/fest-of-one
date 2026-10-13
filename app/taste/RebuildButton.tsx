'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { JobProgressBar, useJob } from '../_components/JobProgress'
import { Button } from '../_components/ui'

export function RebuildButton({ label = '重建画像' }: { label?: string }) {
  const router = useRouter()
  const [jobId, setJobId] = useState<string | null>(null)
  const job = useJob(jobId, 1500)
  useEffect(() => {
    if (job?.status === 'done') router.refresh()
  }, [job?.status, router])
  return (
    <div className="w-64 space-y-2">
      <Button
        variant="outline"
        disabled={job?.status === 'queued' || job?.status === 'running'}
        onClick={async () => {
          const res = await fetch('/api/taste/rebuild', { method: 'POST' })
          if (res.ok) setJobId((await res.json()).job_id)
        }}
      >
        {label}
      </Button>
      <JobProgressBar job={job} />
    </div>
  )
}
