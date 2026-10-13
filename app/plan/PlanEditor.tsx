'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { JobProgressBar, useJob } from '../_components/JobProgress'
import { Button } from '../_components/ui'

type Block = { dow: number; start: string; end: string }
type Mode = 'available' | 'unavailable'

const DOW = ['一', '二', '三', '四', '五', '六', '日']
const FIRST_SLOT = 16 // 08:00
const SLOTS = 48 - FIRST_SLOT // 到 24:00，每格 30 分钟

const slotToHhmm = (slot: number) => {
  const m = slot * 30
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
const hhmmToSlot = (s: string) => (s === '24:00' ? 48 : (Number(s.slice(0, 2)) * 60 + Number(s.slice(3))) / 30)

function blocksToCells(blocks: Block[]): boolean[][] {
  const cells = Array.from({ length: 7 }, () => Array<boolean>(SLOTS).fill(false))
  for (const b of blocks) {
    const a = Math.max(FIRST_SLOT, Math.floor(hhmmToSlot(b.start)))
    const z = Math.min(48, Math.ceil(hhmmToSlot(b.end)))
    for (let s = a; s < z; s++) cells[b.dow]![s - FIRST_SLOT] = true
  }
  return cells
}

function cellsToBlocks(cells: boolean[][]): Block[] {
  const out: Block[] = []
  cells.forEach((col, dow) => {
    let start: number | null = null
    for (let i = 0; i <= SLOTS; i++) {
      const on = i < SLOTS && col[i]
      if (on && start === null) start = i
      if (!on && start !== null) {
        out.push({ dow, start: slotToHhmm(start + FIRST_SLOT), end: slotToHhmm(i + FIRST_SLOT) })
        start = null
      }
    }
  })
  return out
}

export function describeBlocks(blocks: Block[]): string {
  if (!blocks.length) return '（空）'
  return blocks.map((b) => `周${DOW[b.dow]} ${b.start}–${b.end}`).join('，')
}

export function PlanEditor(props: {
  weekStart: string
  weeks: { value: string; label: string }[]
  dates: string[]
  initial: { mode: Mode; blocks: Block[]; source: 'week' | 'template' | 'default' }
  template: { mode: Mode; blocks: Block[] } | null
  defaults: { days: number; filmCount: number }
}) {
  const router = useRouter()
  const [mode, setMode] = useState<Mode>(props.initial.mode)
  const [cells, setCells] = useState(() => blocksToCells(props.initial.blocks))
  const [days, setDays] = useState(props.defaults.days)
  const [filmCount, setFilmCount] = useState(props.defaults.filmCount)
  const [jobId, setJobId] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [saved, setSaved] = useState<string | null>(null)
  const job = useJob(jobId)
  const painting = useRef<boolean | null>(null)
  const gridRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setMode(props.initial.mode)
    setCells(blocksToCells(props.initial.blocks))
  }, [props.initial])

  useEffect(() => {
    const id = (job?.result as { festival_id?: string } | null)?.festival_id
    if (job?.status === 'done' && id) router.push(`/festival/${id}`)
  }, [job, router])

  const paintAt = useCallback((x: number, y: number) => {
    const el = document.elementFromPoint(x, y) as HTMLElement | null
    const d = el?.dataset
    if (!d?.dow || painting.current === null) return
    const dow = Number(d.dow)
    const slot = Number(d.slot)
    setCells((prev) => {
      if (prev[dow]![slot] === painting.current) return prev
      const next = prev.map((c) => [...c])
      next[dow]![slot] = painting.current!
      return next
    })
  }, [])

  const blocks = useMemo(() => cellsToBlocks(cells), [cells])
  const busy = job?.status === 'queued' || job?.status === 'running'

  const save = async (week: string) => {
    const res = await fetch(`/api/availability?week=${week}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode, blocks }),
    })
    if (!res.ok) throw new Error((await res.json()).error?.message ?? '保存失败')
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <div className="flex overflow-hidden rounded-full border border-ink">
          {props.weeks.map((w) => (
            <button
              key={w.value}
              onClick={() => router.push(`/plan?week=${w.value}`)}
              className={`px-4 py-1.5 ${w.value === props.weekStart ? 'bg-ink text-paper' : ''}`}
            >
              {w.label}
            </button>
          ))}
        </div>
        <div className="flex overflow-hidden rounded-full border border-rule">
          {(['available', 'unavailable'] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)} className={`px-4 py-1.5 ${mode === m ? 'bg-rule' : 'text-muted'}`}>
              {m === 'available' ? '涂能看的时间' : '涂没空的时间'}
            </button>
          ))}
        </div>
        <span className="text-xs text-muted">
          {props.initial.source === 'week' ? '本周已单独设置' : props.initial.source === 'template' ? '来自每周模板' : '默认：工作日晚上 + 周末下午'}
        </span>
      </div>

      <div
        ref={gridRef}
        className="grid select-none touch-none grid-cols-[3rem_repeat(7,1fr)] text-[11px]"
        onPointerDown={(e) => {
          const d = (e.target as HTMLElement).dataset
          if (!d.dow) return
          painting.current = !cells[Number(d.dow)]![Number(d.slot)]
          paintAt(e.clientX, e.clientY)
        }}
        onPointerMove={(e) => painting.current !== null && paintAt(e.clientX, e.clientY)}
        onPointerUp={() => (painting.current = null)}
        onPointerLeave={() => (painting.current = null)}
      >
        <div />
        {DOW.map((d, i) => (
          <div key={d} className="pb-1 text-center text-muted">
            周{d} <span className="hidden sm:inline">{props.dates[i]?.slice(5)}</span>
          </div>
        ))}
        {Array.from({ length: SLOTS }, (_, slot) => (
          <div key={slot} className="contents">
            <div className="pr-1 text-right leading-4 text-muted">{slot % 2 === 0 ? slotToHhmm(slot + FIRST_SLOT) : ''}</div>
            {DOW.map((_, dow) => (
              <div
                key={dow}
                data-dow={dow}
                data-slot={slot}
                className={`h-4 border-l border-rule/60 ${slot % 2 === 0 ? 'border-t border-t-rule/60' : ''} ${
                  cells[dow]![slot] ? (mode === 'available' ? 'bg-ink/80' : 'bg-accent/60') : 'hover:bg-rule/50'
                }`}
              />
            ))}
          </div>
        ))}
      </div>
      <p className="text-xs text-muted">
        {mode === 'available' ? '深色 = 能看电影的时间。' : '红色 = 没空的时间；生成时会在一天的边界内取补集。'} 按住拖动涂抹，再点一次取消。
      </p>

      <div className="flex flex-wrap items-end gap-4 border-t border-rule pt-6">
        <label className="text-sm">
          <span className="mb-1 block text-muted">几天</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded border border-rule bg-transparent px-3 py-1.5">
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>
                {n} 天
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">几部</span>
          <select value={filmCount} onChange={(e) => setFilmCount(Number(e.target.value))} className="rounded border border-rule bg-transparent px-3 py-1.5">
            {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
              <option key={n} value={n}>
                {n} 部{n === 1 ? '（只推一部）' : ''}
              </option>
            ))}
          </select>
        </label>
        <Button
          disabled={busy}
          onClick={async () => {
            setErr(null)
            try {
              await save(props.weekStart)
              const res = await fetch('/api/festivals/generate', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ week_start: props.weekStart, days: Math.min(days, filmCount), film_count: filmCount }),
              })
              const body = await res.json()
              if (!res.ok) setErr(body.error?.message ?? '生成失败')
              else setJobId(body.job_id)
            } catch (e) {
              setErr(e instanceof Error ? e.message : '生成失败')
            }
          }}
        >
          {busy ? '策展中…' : filmCount === 1 ? '推荐这周的一部' : '生成本周影展'}
        </Button>
        <Button
          variant="ghost"
          onClick={async () => {
            try {
              await save('template')
              setSaved('已存为每周模板')
              router.refresh()
            } catch (e) {
              setErr(e instanceof Error ? e.message : '保存失败')
            }
          }}
        >
          存为每周模板
        </Button>
        {saved && <span className="text-xs text-muted">{saved}</span>}
      </div>
      {err && <p className="whitespace-pre-line text-sm text-accent">{err}</p>}
      {job && (
        <div className="max-w-md">
          <JobProgressBar job={job} />
          {job.status === 'failed' && <p className="mt-2 whitespace-pre-line text-sm text-accent">{job.error}</p>}
        </div>
      )}

      {props.template && (
        <div className="border-t border-rule pt-4 text-xs text-muted">
          <p>
            每周模板（{props.template.mode === 'available' ? '能看' : '没空'}）：{describeBlocks(props.template.blocks)}
          </p>
          <button
            className="mt-1 underline"
            onClick={() => {
              setMode(props.template!.mode)
              setCells(blocksToCells(props.template!.blocks))
            }}
          >
            套用模板
          </button>
        </div>
      )}
    </div>
  )
}
