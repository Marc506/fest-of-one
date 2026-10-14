'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { JobProgressBar, useJob } from '../_components/JobProgress'
import { Button } from '../_components/ui'

export function SourceActions({ id }: { id: string }) {
  const router = useRouter()
  const [jobId, setJobId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const job = useJob(jobId)
  useEffect(() => {
    if (job?.status === 'done' || job?.status === 'failed') router.refresh()
  }, [job?.status, router])
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={async () => {
            setErr(null)
            const res = await fetch(`/api/sources/${id}/sync`, { method: 'POST' })
            const body = await res.json()
            if (!res.ok) setErr(body.error?.message ?? '失败')
            else setJobId(body.job_id)
          }}
        >
          重新同步
        </Button>
        <Button
          variant="ghost"
          onClick={async () => {
            if (!confirm('删除这个来源以及从它导入的全部观影记录？')) return
            await fetch(`/api/sources/${id}`, { method: 'DELETE' })
            router.refresh()
          }}
        >
          删除
        </Button>
      </div>
      {err && <p className="text-xs text-accent">{err}</p>}
      <JobProgressBar job={job} />
    </div>
  )
}
