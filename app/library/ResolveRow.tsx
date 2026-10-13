'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Badge, Button } from '../_components/ui'
import { TmdbSearch } from './TmdbSearch'

type Candidate = { tmdb_id: number; title: string; year: number | null; score: number; original_title?: string; vote_count?: number }

export function ResolveRow({
  alias,
}: {
  alias: { id: number; provider: string; titleRaw: string; yearRaw: number | null; status: string; candidates: Candidate[]; watched: boolean }
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState<number | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const pick = async (tmdbId: number) => {
    setBusy(tmdbId)
    setErr(null)
    const res = await fetch('/api/library/resolve', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias_id: alias.id, tmdb_id: tmdbId }),
    })
    setBusy(null)
    if (!res.ok) setErr((await res.json()).error?.message ?? '失败')
    else router.refresh()
  }
  return (
    <li className="space-y-2 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{alias.titleRaw}</span>
        <span className="text-muted">{alias.yearRaw ?? '年份未知'}</span>
        <Badge tone={alias.status === 'ambiguous' ? 'ink' : 'accent'}>{alias.status === 'ambiguous' ? '有歧义' : '未匹配'}</Badge>
        <Badge>{alias.provider}</Badge>
        {!alias.watched && <Badge>想看</Badge>}
      </div>
      {alias.candidates.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {alias.candidates.map((c) => (
            <li key={c.tmdb_id} className="flex items-center gap-1">
              <Button variant="outline" disabled={busy !== null} onClick={() => pick(c.tmdb_id)} title={`匹配分 ${c.score}`}>
                {busy === c.tmdb_id ? '…' : `${c.title} (${c.year ?? '?'})`}
                {c.original_title && c.original_title !== c.title && <span className="text-xs opacity-60">{c.original_title}</span>}
                {c.vote_count != null && <span className="text-xs opacity-60">· {c.vote_count} 票</span>}
              </Button>
              <a
                href={`https://www.themoviedb.org/movie/${c.tmdb_id}`}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-muted hover:text-ink"
                title="在 TMDB 查看"
              >
                ↗
              </a>
            </li>
          ))}
        </ul>
      )}
      <button className="text-xs text-muted underline" onClick={() => setOpen((v) => !v)}>
        {open ? '收起' : '都不是？搜索 TMDB'}
      </button>
      {open && (
        <TmdbSearch
          initialQuery={alias.titleRaw.split(' / ').at(-1) ?? alias.titleRaw}
          initialYear={alias.yearRaw}
          action={(r) => (
            <Button variant="outline" disabled={busy !== null} onClick={() => pick(r.tmdb_id)}>
              就是这部
            </Button>
          )}
        />
      )}
      {err && <p className="text-xs text-accent">{err}</p>}
    </li>
  )
}
