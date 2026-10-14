'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { JobProgressBar, useJob } from '../_components/JobProgress'
import { Button } from '../_components/ui'

/** activeJobId：页面加载时已经在排队 / 在跑的重建，离开再回来也接得上，不会重复排队。 */
export function RebuildButton({ label = '重建画像', activeJobId = null }: { label?: string; activeJobId?: string | null }) {
  const router = useRouter()
  const [jobId, setJobId] = useState<string | null>(activeJobId)
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
