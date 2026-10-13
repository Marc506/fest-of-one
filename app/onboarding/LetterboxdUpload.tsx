'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { JobProgressBar, useJob } from '../_components/JobProgress'
import { Button } from '../_components/ui'

/** 上传 Letterboxd 导出 ZIP → sync_source → enrich_films，两段进度。 */
export function LetterboxdUpload() {
  const router = useRouter()
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [syncId, setSyncId] = useState<string | null>(null)
  const sync = useJob(syncId)
  const enrichId = (sync?.result as { enrich_job_id?: string } | null)?.enrich_job_id ?? null
  const enrich = useJob(enrichId)

  useEffect(() => {
    if (enrich?.status === 'done') router.refresh()
  }, [enrich?.status, router])

  return (
    <div className="space-y-3">
      <input
        type="file"
        accept=".zip"
        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        className="block w-full text-sm file:mr-3 file:rounded-full file:border file:border-ink file:bg-transparent file:px-3 file:py-1"
      />
      <Button
        disabled={!file || busy}
        onClick={async () => {
          if (!file) return
          setBusy(true)
          setErr(null)
          const fd = new FormData()
          fd.set('provider', 'letterboxd')
          fd.set('file', file)
          const res = await fetch('/api/sources', { method: 'POST', body: fd })
          const body = await res.json()
          setBusy(false)
          if (!res.ok) setErr(body.error?.message ?? '上传失败')
          else setSyncId(body.job_id)
        }}
      >
        {busy ? '上传中…' : '上传并导入'}
      </Button>
      {err && <p className="text-accent">{err}</p>}
      {sync && (
        <div>
          <p className="mb-1 text-xs">1 · 导入记录</p>
          <JobProgressBar job={sync} />
        </div>
      )}
      {enrich && (
        <div>
          <p className="mb-1 text-xs">2 · 匹配 TMDB 并补全资料</p>
          <JobProgressBar job={enrich} />
        </div>
      )}
      {enrich?.status === 'done' && (
        <p>
          完成。去 <a className="underline" href="/library">片库</a> 看看，「待确认」里的条目可以手工选择。
        </p>
      )}
    </div>
  )
}
