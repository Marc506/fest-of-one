'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

const OPTIONS = [
  { v: 'watched', label: '看了' },
  { v: 'skipped', label: '没看' },
  { v: 'not_interested', label: '不感兴趣' },
] as const

type V = (typeof OPTIONS)[number]['v']

export function FeedbackToggle({ festivalId, screeningId, value }: { festivalId: string; screeningId: string; value: V | null }) {
  const router = useRouter()
  const [cur, setCur] = useState<V | null>(value)
  const [busy, setBusy] = useState(false)
  return (
    <div className="flex items-center gap-1 text-xs">
      {OPTIONS.map((o) => (
        <button
          key={o.v}
          disabled={busy}
          onClick={async () => {
            const next = cur === o.v ? null : o.v
            setBusy(true)
            const res = await fetch(`/api/festivals/${festivalId}/feedback`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ screening_id: screeningId, feedback: next }),
            })
            setBusy(false)
            if (res.ok) {
              setCur(next)
              router.refresh()
            }
          }}
          className={`rounded-full border px-2 py-0.5 ${
            cur === o.v ? (o.v === 'not_interested' ? 'border-accent bg-accent text-paper' : 'border-ink bg-ink text-paper') : 'border-rule text-muted hover:text-ink'
          }`}
          title={o.v === 'not_interested' ? '以后的影展不会再排这部' : o.v === 'watched' ? '记进片库，算作看过' : ''}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
