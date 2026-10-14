'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Poster } from '../_components/Poster'
import { Badge, Button } from '../_components/ui'
import { TmdbSearch } from './TmdbSearch'

type Candidate = {
  tmdb_id: number
  title: string
  year: number | null
  score: number
  original_title?: string
  vote_count?: number
  poster_path?: string | null
  directors?: string[]
}

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
  const markNotFilm = async (id: number, notFilm: boolean) => {
    setErr(null)
    const res = await fetch('/api/library/not-film', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ alias_id: id, not_film: notFilm }),
    })
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
        <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {alias.candidates.map((c) => (
            <li key={c.tmdb_id}>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => pick(c.tmdb_id)}
                title={`选这部 · 匹配分 ${c.score}`}
                className="flex w-full items-start gap-3 rounded border border-rule p-2 text-left transition hover:border-ink disabled:opacity-50"
              >
                <Poster path={c.poster_path ?? null} title={c.title} size="w92" className="w-12 shrink-0 rounded" />
                <span className="min-w-0 flex-1 space-y-0.5 text-sm">
                  <span className="block truncate">
                    {busy === c.tmdb_id ? '…' : c.title} <span className="text-muted">({c.year ?? '?'})</span>
                  </span>
                  {c.original_title && c.original_title !== c.title && <span className="block truncate text-xs text-muted">{c.original_title}</span>}
                  <span className="block truncate text-xs text-muted">{c.directors?.length ? `导演：${c.directors.join('、')}` : '导演：—'}</span>
                  {c.vote_count != null && <span className="block text-xs text-muted">{c.vote_count} 票</span>}
                </span>
              </button>
              <a
                href={`https://www.themoviedb.org/movie/${c.tmdb_id}`}
                target="_blank"
                rel="noreferrer"
                className="mt-0.5 inline-block text-xs text-muted hover:text-ink"
              >
                在 TMDB 查看 ↗
              </a>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-4">
        <button className="text-xs text-muted underline" onClick={() => setOpen((v) => !v)}>
          {open ? '收起' : '都不是？搜索 TMDB'}
        </button>
        <button className="text-xs text-muted underline" disabled={busy !== null} onClick={() => markNotFilm(alias.id, true)}>
          不是电影（剧集 / 综艺 / 舞台录像…）
        </button>
      </div>
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
