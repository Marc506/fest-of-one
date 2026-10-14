import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { DEFAULT_PREFS, type UserPrefs } from '@/db/types'
import { schedule, type SlateFilm } from '@/scheduler/schedule'
import { addDays, isWeekend, minToHhmm, type Window } from '@/scheduler/slots'

const WEEK = '2026-10-19'
const TZ = 'Asia/Shanghai'

const windowsArb = fc
  .array(
    fc.record({
      dow: fc.integer({ min: 0, max: 6 }),
      start: fc.integer({ min: 9 * 12, max: 22 * 12 }).map((x) => x * 5),
      len: fc.integer({ min: 12, max: 120 }).map((x) => x * 5),
    }),
    { minLength: 1, maxLength: 9 },
  )
  .map((raw) => {
    // 同一天的块合并成不重叠窗口
    const byDay = new Map<number, [number, number][]>()
    for (const r of raw) byDay.set(r.dow, [...(byDay.get(r.dow) ?? []), [r.start, Math.min(1440, r.start + r.len)]])
    const out: Window[] = []
    for (const [dow, ivs] of byDay) {
      const merged: [number, number][] = []
      for (const iv of ivs.sort((a, b) => a[0] - b[0])) {
        const last = merged.at(-1)
        if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1])
        else merged.push([...iv])
      }
      for (const [start, end] of merged) out.push({ date: addDays(WEEK, dow), dow, start, end })
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start)
  })

const slateArb = fc
  .array(fc.integer({ min: 14, max: 48 }).map((x) => x * 5), { minLength: 1, maxLength: 6 })
  .map((rts): SlateFilm[] => rts.map((runtimeMin, i) => ({ tmdbId: 1000 + i, position: i + 1, role: 'regular', runtimeMin })))

const prefsArb = fc.record({
  buffer_min: fc.constantFrom(0, 10, 20, 30),
  max_films_per_day: fc.integer({ min: 1, max: 3 }),
  weekday_max_runtime_min: fc.constantFrom(150, 170, 200),
  preferred_start: fc.constantFrom(null, '19:30', '20:00'),
}).map((p): UserPrefs => ({ ...DEFAULT_PREFS, ...p }))

describe('schedule() properties (8.3)', () => {
  it('never overlaps, stays in windows, respects buffer, caps and order', () => {
    fc.assert(
      fc.property(windowsArb, slateArb, prefsArb, fc.integer({ min: 1, max: 7 }), (windows, slate, prefs, days) => {
        const r = schedule(slate, windows, days, prefs, TZ)
        expect(r.placements).toHaveLength(slate.length)
        const placed = r.placements.filter((p) => p.startsAt)
        for (const p of r.placements) if (!p.startsAt) expect(p.unscheduledReason).toBeTruthy()
        if (r.complete) expect(placed).toHaveLength(slate.length)
        const rt = (id: number) => slate.find((s) => s.tmdbId === id)!.runtimeMin

        // 在窗口内（含 buffer）、工作日片长上限
        for (const p of placed) {
          const w = windows.find((w) => w.date === p.date && p.start! >= w.start && p.start! + rt(p.tmdbId) + prefs.buffer_min <= w.end)
          expect(w, `placement ${p.date} ${minToHhmm(p.start!)} outside windows`).toBeTruthy()
          if (!isWeekend(w!.dow)) expect(rt(p.tmdbId)).toBeLessThanOrEqual(prefs.weekday_max_runtime_min)
          expect(Date.parse(p.endsAt!) - Date.parse(p.startsAt!)).toBe(rt(p.tmdbId) * 60000)
        }
        // 不重叠 + buffer
        const byTime = [...placed].sort((a, b) => a.startsAt!.localeCompare(b.startsAt!))
        for (let i = 1; i < byTime.length; i++) {
          expect(Date.parse(byTime[i]!.startsAt!) - Date.parse(byTime[i - 1]!.endsAt!)).toBeGreaterThanOrEqual(prefs.buffer_min * 60000)
        }
        // 每日上限
        const perDay = new Map<string, number>()
        for (const p of placed) perDay.set(p.date!, (perDay.get(p.date!) ?? 0) + 1)
        for (const k of perDay.values()) expect(k).toBeLessThanOrEqual(prefs.max_films_per_day)
        // 顺序单调（未放宽时）
        if (r.complete && !r.relaxedOrder) {
          const byPos = [...placed].sort((a, b) => a.position - b.position)
          for (let i = 1; i < byPos.length; i++) expect(byPos[i]!.startsAt! > byPos[i - 1]!.startsAt!).toBe(true)
        }
        // 放宽顺序时 opening 第一、closing 最后
        if (r.complete && r.order === 'relaxed' && slate.length >= 2) {
          expect(byTime[0]!.position).toBe(1)
          expect(byTime.at(-1)!.position).toBe(slate.length)
        }
      }),
      { numRuns: 400 },
    )
  })

  it('single mode places the film whenever any window can hold it', () => {
    fc.assert(
      fc.property(windowsArb, fc.integer({ min: 14, max: 48 }).map((x) => x * 5), prefsArb, (windows, runtimeMin, prefs) => {
        const r = schedule([{ tmdbId: 1, position: 1, role: 'opening', runtimeMin }], windows, 1, prefs, TZ)
        const fits = windows.some((w) => w.end - w.start >= runtimeMin + prefs.buffer_min && (isWeekend(w.dow) || runtimeMin <= prefs.weekday_max_runtime_min))
        expect(r.complete).toBe(fits)
      }),
      { numRuns: 300 },
    )
  })
})

describe('schedule() hand-written edges', () => {
  const prefs = { ...DEFAULT_PREFS, preferred_start: null }
  const win = (dow: number, s: string, e: string): Window => {
    const m = (x: string) => Number(x.slice(0, 2)) * 60 + Number(x.slice(3))
    return { date: addDays(WEEK, dow), dow, start: m(s), end: m(e) }
  }

  it('one 4h window cannot hold three films; reports the leftovers', () => {
    const slate: SlateFilm[] = [100, 95, 110].map((runtimeMin, i) => ({ tmdbId: i + 1, position: i + 1, role: 'regular', runtimeMin }))
    const r = schedule(slate, [win(5, '14:00', '18:00')], 1, { ...prefs, max_films_per_day: 3 }, TZ)
    expect(r.complete).toBe(false)
    expect(r.placements.filter((p) => p.startsAt)).toHaveLength(2)
    expect(r.placements.find((p) => !p.startsAt)!.unscheduledReason).toMatch(/排不下/)
  })

  it('moves an over-long film off weekdays', () => {
    const slate: SlateFilm[] = [
      { tmdbId: 1, position: 1, role: 'opening', runtimeMin: 95 },
      { tmdbId: 2, position: 2, role: 'closing', runtimeMin: 230 },
    ]
    const r = schedule(slate, [win(1, '19:00', '23:30'), win(2, '19:00', '23:30'), win(6, '12:00', '24:00')], 2, prefs, TZ)
    expect(r.complete).toBe(true)
    expect(r.placements.find((p) => p.tmdbId === 2)!.date).toBe(addDays(WEEK, 6))
  })

  it('uses preferred_start when the window allows it', () => {
    const r = schedule([{ tmdbId: 1, position: 1, role: 'opening', runtimeMin: 100 }], [win(2, '18:00', '23:30')], 1, { ...prefs, preferred_start: '19:30' }, TZ)
    expect(r.placements[0]!.start).toBe(19 * 60 + 30)
    expect(r.placements[0]!.startsAt).toBe('2026-10-21T11:30:00.000Z')
  })

  it('spreads days evenly when asked for fewer days than available', () => {
    const slate: SlateFilm[] = [1, 2, 3].map((i) => ({ tmdbId: i, position: i, role: 'regular', runtimeMin: 100 }))
    const ws = [0, 1, 2, 3, 4, 5, 6].map((d) => win(d, '19:00', '23:30'))
    const r = schedule(slate, ws, 3, prefs, TZ)
    expect(r.complete).toBe(true)
    const idx = r.days.map((d) => (Date.parse(d) - Date.parse(WEEK)) / 86400000)
    expect(idx[1]! - idx[0]!).toBe(idx[2]! - idx[1]!)
  })
})
