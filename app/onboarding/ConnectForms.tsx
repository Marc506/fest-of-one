'use client'

import { useState } from 'react'
import { Button } from '../_components/ui'
import { SyncProgress, UploadSource } from './UploadSource'

async function createSource(body: Record<string, string>) {
  const res = await fetch('/api/sources', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error?.message ?? '失败')
  return json.job_id as string
}

export function LetterboxdRss() {
  const [handle, setHandle] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [syncId, setSyncId] = useState<string | null>(null)
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="Letterboxd 用户名"
          className="min-w-0 flex-1 rounded border border-rule bg-transparent px-3 py-1.5 text-sm"
        />
        <Button
          disabled={!handle.trim()}
          onClick={async () => {
            setErr(null)
            try {
              setSyncId(await createSource({ provider: 'letterboxd', mode: 'rss', handle: handle.trim() }))
            } catch (e) {
              setErr(e instanceof Error ? e.message : '失败')
            }
          }}
        >
          连接
        </Button>
      </div>
      {err && <p className="text-accent">{err}</p>}
      <SyncProgress syncId={syncId} />
    </div>
  )
}

export function DoubanConnect() {
  const [tab, setTab] = useState<'upload' | 'scrape'>('upload')
  const [people, setPeople] = useState('')
  const [cookie, setCookie] = useState('')
  const [err, setErr] = useState<string | null>(null)
  const [syncId, setSyncId] = useState<string | null>(null)
  return (
    <div className="space-y-3">
      <div className="flex gap-3 text-xs">
        <button className={tab === 'upload' ? 'underline' : 'text-muted'} onClick={() => setTab('upload')}>
          上传导出（推荐）
        </button>
        <button className={tab === 'scrape' ? 'underline' : 'text-muted'} onClick={() => setTab('scrape')}>
          Cookie 抓取
        </button>
      </div>
      {tab === 'upload' ? (
        <>
          <p className="text-xs text-muted">第三方工具（如豆伴）导出的 CSV / Excel，需要包含标题与条目链接两列。</p>
          <UploadSource provider="douban" accept=".csv,.xlsx" label="上传并导入" />
        </>
      ) : (
        <div className="space-y-2">
          <input
            value={people}
            onChange={(e) => setPeople(e.target.value)}
            placeholder="豆瓣 ID（个人主页 /people/ 后面那一段）"
            className="w-full rounded border border-rule bg-transparent px-3 py-1.5 text-sm"
          />
          <textarea
            value={cookie}
            onChange={(e) => setCookie(e.target.value)}
            placeholder="登录后的 Cookie（只用于抓取，加密保存，可随时清除）"
            rows={3}
            className="w-full rounded border border-rule bg-transparent px-3 py-1.5 font-mono text-xs"
          />
          <p className="text-xs text-muted">每页间隔 2–4 秒，最多 100 页；遇到验证会立刻停下并提示，不会绕过验证码。</p>
          <Button
            disabled={!people.trim() || !cookie.trim()}
            onClick={async () => {
              setErr(null)
              try {
                setSyncId(await createSource({ provider: 'douban', mode: 'scrape', handle: people.trim(), cookie }))
                setCookie('')
              } catch (e) {
                setErr(e instanceof Error ? e.message : '失败')
              }
            }}
          >
            开始抓取
          </Button>
          {err && <p className="text-accent">{err}</p>}
          <SyncProgress syncId={syncId} />
        </div>
      )}
    </div>
  )
}

export function ClearCookieButton({ id }: { id: string }) {
  const [done, setDone] = useState(false)
  return done ? (
    <span className="text-xs text-muted">已清除</span>
  ) : (
    <button
      className="text-xs text-muted underline"
      onClick={async () => {
        await fetch(`/api/sources/${id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cookie: null }) })
        setDone(true)
      }}
    >
      清除 Cookie
    </button>
  )
}
