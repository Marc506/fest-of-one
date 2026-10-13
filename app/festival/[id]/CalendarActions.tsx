'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { JobProgressBar, useJob } from '../../_components/JobProgress'
import { Button } from '../../_components/ui'
import { connectGoogleCalendar } from './actions'

export function CalendarActions(props: {
  festivalId: string
  webcal: string
  https: string
  googleEnabled: boolean
  googleSyncedAt: string | null
}) {
  const router = useRouter()
  const params = useSearchParams()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [jobId, setJobId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const job = useJob(jobId)
  const resumed = useRef(false)

  const pushGoogle = async () => {
    setErr(null)
    const res = await fetch(`/api/festivals/${props.festivalId}/google-calendar`, { method: 'POST' })
    const body = await res.json()
    if (res.status === 409 && body.error?.code === 'needs_google_auth') {
      await connectGoogleCalendar(props.festivalId)
      return
    }
    if (!res.ok) setErr(body.error?.message ?? '失败')
    else setJobId(body.job_id)
  }

  // 授权回来（?gcal=1）后自动继续
  useEffect(() => {
    if (params.get('gcal') === '1' && !resumed.current) {
      resumed.current = true
      router.replace(`/festival/${props.festivalId}`)
      void pushGoogle()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params])

  useEffect(() => {
    if (job?.status === 'done') router.refresh()
  }, [job?.status, router])

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <a href={`/api/festivals/${props.festivalId}/calendar.ics`} className="inline-flex items-center rounded-full border border-ink px-4 py-1.5 text-sm hover:bg-ink hover:text-paper">
          下载 .ics
        </a>
        <Button variant="outline" onClick={() => setOpen((v) => !v)}>
          订阅日历
        </Button>
        <Button
          variant="outline"
          disabled={!props.googleEnabled || job?.status === 'queued' || job?.status === 'running'}
          title={props.googleEnabled ? '' : '服务器没有配置 Google 登录'}
          onClick={pushGoogle}
        >
          {props.googleSyncedAt ? '重新写入 Google 日历' : '加入 Google 日历（全部）'}
        </Button>
      </div>
      {open && (
        <div className="max-w-xl space-y-2 rounded border border-rule p-3 text-sm">
          <p>
            <a className="underline" href={props.webcal}>
              用 Apple 日历订阅
            </a>
            <span className="text-muted">（点开即弹出「订阅」，以后每周的影展会自动出现）</span>
          </p>
          <div className="flex gap-2">
            <input readOnly value={props.https} className="min-w-0 flex-1 rounded border border-rule bg-transparent px-2 py-1 text-xs" />
            <Button
              variant="ghost"
              onClick={async () => {
                await navigator.clipboard.writeText(props.https)
                setCopied(true)
              }}
            >
              {copied ? '已复制' : '复制 URL'}
            </Button>
          </div>
          <p className="text-xs text-muted">
            Google 日历：其他日历 → 通过网址添加，粘贴上面的 URL。注意 Google 刷新订阅源很慢（几小时到一天），想立刻看到请用「加入 Google 日历」。
          </p>
        </div>
      )}
      {props.googleSyncedAt && !job && <p className="text-xs text-muted">已于 {props.googleSyncedAt.slice(0, 16).replace('T', ' ')}（UTC）写入 Google 日历</p>}
      {err && <p className="text-xs text-accent">{err}</p>}
      {job && (
        <div className="w-64">
          <JobProgressBar job={job} />
        </div>
      )}
    </div>
  )
}
