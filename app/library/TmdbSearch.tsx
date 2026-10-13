'use client'

import { useState, type ReactNode } from 'react'
import { Poster } from '../_components/Poster'
import { Button } from '../_components/ui'

export type SearchResult = {
  tmdb_id: number
  title: string
  original_title: string
  year: number | null
  poster_path: string | null
  vote_count: number
  seen: boolean
}

/** TMDB 搜索框；每条结果右侧的操作由调用方渲染。 */
export function TmdbSearch({
  initialQuery = '',
  initialYear,
  action,
}: {
  initialQuery?: string
  initialYear?: number | null
  action: (r: SearchResult) => ReactNode
}) {
  const [q, setQ] = useState(initialQuery)
  const [year, setYear] = useState<string>(initialYear ? String(initialYear) : '')
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const search = async () => {
    if (!q.trim()) return
    setBusy(true)
    setErr(null)
    const params = new URLSearchParams({ q })
    if (year) params.set('year', year)
    const res = await fetch(`/api/tmdb/search?${params}`)
    const body = await res.json()
    setBusy(false)
    if (!res.ok) setErr(body.error?.message ?? '搜索失败')
    else setResults(body.results)
  }
  return (
    <div className="space-y-3">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          void search()
        }}
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="片名（中文 / 原名 / 英文）"
          className="min-w-0 flex-1 rounded border border-rule bg-transparent px-3 py-1.5 text-sm"
        />
        <input
          value={year}
          onChange={(e) => setYear(e.target.value.replace(/\D/g, '').slice(0, 4))}
          placeholder="年份"
          className="w-20 rounded border border-rule bg-transparent px-2 py-1.5 text-sm"
        />
        <Button type="submit" variant="outline" disabled={busy}>
          {busy ? '…' : '搜索'}
        </Button>
      </form>
      {err && <p className="text-xs text-accent">{err}</p>}
      {results && results.length === 0 && <p className="text-xs text-muted">没有结果。</p>}
      {results && results.length > 0 && (
        <ul className="divide-y divide-rule">
          {results.map((r) => (
            <li key={r.tmdb_id} className="flex items-center gap-3 py-2">
              <Poster path={r.poster_path} title={r.title} size="w92" className="w-10 shrink-0 rounded" />
              <div className="min-w-0 flex-1 text-sm">
                <p className="truncate">
                  {r.title} <span className="text-muted">({r.year ?? '?'})</span>
                </p>
                {r.original_title !== r.title && <p className="truncate text-xs text-muted">{r.original_title}</p>}
              </div>
              {action(r)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
