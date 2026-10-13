'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Button } from '../_components/ui'
import { TmdbSearch } from './TmdbSearch'

export function ManualAdd() {
  const router = useRouter()
  const [rating, setRating] = useState('')
  const [date, setDate] = useState('')
  const [added, setAdded] = useState<Set<number>>(new Set())
  const [err, setErr] = useState<string | null>(null)
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3 text-sm">
        <label className="flex items-center gap-2">
          看过日期
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="rounded border border-rule bg-transparent px-2 py-1" />
        </label>
        <label className="flex items-center gap-2">
          评分（1–10）
          <input
            value={rating}
            onChange={(e) => setRating(e.target.value.replace(/\D/g, '').slice(0, 2))}
            className="w-14 rounded border border-rule bg-transparent px-2 py-1"
          />
        </label>
      </div>
      <TmdbSearch
        action={(r) =>
          r.seen || added.has(r.tmdb_id) ? (
            <span className="text-xs text-muted">已在片库</span>
          ) : (
            <Button
              variant="outline"
              onClick={async () => {
                setErr(null)
                const n = Number(rating)
                const res = await fetch('/api/library/manual', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ tmdb_id: r.tmdb_id, watched_at: date || null, rating10: n >= 1 && n <= 10 ? n : null }),
                })
                if (!res.ok) setErr((await res.json()).error?.message ?? '失败')
                else {
                  setAdded((s) => new Set(s).add(r.tmdb_id))
                  router.refresh()
                }
              }}
            >
              标为看过
            </Button>
          )
        }
      />
      {err && <p className="text-xs text-accent">{err}</p>}
    </div>
  )
}
