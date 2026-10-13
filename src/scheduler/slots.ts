/**
 * 槽位推导（8.1 / 8.2）。所有计算在用户时区的「本地分钟」上进行，最后再转 UTC。
 */
import { fromZonedTime, toZonedTime, formatInTimeZone } from 'date-fns-tz'
import type { AvailabilityBlock, UserPrefs } from '@/db/types'

export type Window = {
  /** 本地日期 YYYY-MM-DD */
  date: string
  /** 0 = 周一 … 6 = 周日 */
  dow: number
  /** 本地分钟（0–1440） */
  start: number
  end: number
}

export type AvailabilityInput = {
  mode: 'available' | 'unavailable'
  blocks: AvailabilityBlock[]
  prefs: UserPrefs
  tz: string
}

export const TYPICAL_RUNTIME = 110
export const MIN_USABLE_WINDOW = 80
export const DOW_ZH = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
export const DOW_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

export function hhmmToMin(s: string): number {
  if (s === '24:00') return 1440
  const [h, m] = s.split(':').map(Number)
  return h! * 60 + m!
}

export function minToHhmm(n: number): string {
  const h = Math.floor(n / 60)
  const m = n % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export const isWeekend = (dow: number) => dow >= 5

/** 用户时区里「今天所在的周一」。 */
export function currentWeekStart(tz: string, now = new Date()): string {
  const local = toZonedTime(now, tz)
  const dow = (local.getDay() + 6) % 7
  const today = formatInTimeZone(now, tz, 'yyyy-MM-dd')
  return addDays(today, -dow)
}

/** 本地日期 + 本地分钟 → UTC ISO。1440 视为次日 00:00。 */
export function localToUtc(date: string, minute: number, tz: string): string {
  const d = minute >= 1440 ? addDays(date, Math.floor(minute / 1440)) : date
  const m = minute % 1440
  return fromZonedTime(`${d}T${minToHhmm(m)}:00`, tz).toISOString()
}

type Interval = [number, number]

function merge(intervals: Interval[]): Interval[] {
  const s = [...intervals].filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])
  const out: Interval[] = []
  for (const iv of s) {
    const last = out.at(-1)
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1])
    else out.push([iv[0], iv[1]])
  }
  return out
}

function subtract(base: Interval, cuts: Interval[]): Interval[] {
  let parts: Interval[] = [base]
  for (const [a, b] of merge(cuts)) {
    parts = parts.flatMap(([x, y]): Interval[] => {
      if (b <= x || a >= y) return [[x, y]]
      const r: Interval[] = []
      if (a > x) r.push([x, a])
      if (b < y) r.push([b, y])
      return r
    })
  }
  return parts
}

/**
 * 可用窗口：available 模式合并相邻 / 重叠块；unavailable 模式在 day_bounds 内取补集。
 * `now` 之前的部分会被裁掉（本周已经过去的时间不能排片），裁到 5 分钟整。
 */
export function deriveWindows(input: AvailabilityInput, weekStart: string, now?: Date): Window[] {
  const out: Window[] = []
  const bounds: Interval = [hhmmToMin(input.prefs.day_bounds.start), hhmmToMin(input.prefs.day_bounds.end)]
  for (let dow = 0; dow < 7; dow++) {
    const date = addDays(weekStart, dow)
    const blocks: Interval[] = input.blocks.filter((b) => b.dow === dow).map((b) => [hhmmToMin(b.start), hhmmToMin(b.end)])
    let ivs = input.mode === 'available' ? merge(blocks) : subtract(bounds, blocks)
    if (now) {
      const today = formatInTimeZone(now, input.tz, 'yyyy-MM-dd')
      if (date < today) ivs = []
      else if (date === today) {
        const local = toZonedTime(now, input.tz)
        const nowMin = Math.ceil((local.getHours() * 60 + local.getMinutes()) / 5) * 5
        ivs = ivs.map(([a, b]): Interval => [Math.max(a, nowMin), b]).filter(([a, b]) => b > a)
      }
    }
    for (const [start, end] of ivs) out.push({ date, dow, start, end })
  }
  return out
}

export const windowLen = (w: Window) => w.end - w.start

export type Feasibility = {
  windows: Window[]
  usableDays: number
  capacity: number
  days: number
  filmCount: number
  /** 天数被下调时的提示 */
  notes: string[]
  /** 不可行时的错误（job 失败并展示给用户） */
  error: string | null
  /** 能放下的最长片长（分钟）：最长窗口 − buffer；工作日受 weekday_max_runtime_min 限制 */
  maxRuntime: number
}

/** 8.2 可行性预检。 */
export function checkFeasibility(windows: Window[], days: number, filmCount: number, prefs: UserPrefs): Feasibility {
  const buffer = prefs.buffer_min
  const notes: string[] = []
  const perDay = new Map<string, number>()
  let capacity = 0
  for (const w of windows) {
    const cap = Math.floor((windowLen(w) + buffer) / (TYPICAL_RUNTIME + buffer))
    capacity += cap
    perDay.set(w.date, Math.max(perDay.get(w.date) ?? 0, windowLen(w)))
  }
  const usableDays = [...perDay.values()].filter((m) => m >= MIN_USABLE_WINDOW).length
  // 每个日子的容量也受 max_films_per_day 限制
  const dayCap = new Map<string, number>()
  for (const w of windows) {
    const cap = Math.floor((windowLen(w) + buffer) / (TYPICAL_RUNTIME + buffer))
    dayCap.set(w.date, (dayCap.get(w.date) ?? 0) + cap)
  }
  capacity = [...dayCap.values()].reduce((a, c) => a + Math.min(c, prefs.max_films_per_day), 0)

  let d = days
  if (d > usableDays) {
    notes.push(`本周只有 ${usableDays} 天有足够长的空档，天数从 ${days} 调整为 ${usableDays}`)
    d = usableDays
  }
  if (d > filmCount) d = filmCount
  let error: string | null = null
  if (!windows.length || usableDays === 0) error = '本周没有可用时间：请在周视图里涂出至少一段 80 分钟以上的空档'
  else if (filmCount > capacity) error = `本周可用时间最多排 ${capacity} 部，请增加可用时间或减少部数`
  const maxRuntime = maxFittingRuntime(windows, prefs)
  return { windows, usableDays, capacity, days: Math.max(1, d), filmCount, notes, error, maxRuntime }
}

export function maxFittingRuntime(windows: Window[], prefs: UserPrefs): number {
  let best = 0
  for (const w of windows) {
    let m = windowLen(w) - prefs.buffer_min
    if (!isWeekend(w.dow)) m = Math.min(m, prefs.weekday_max_runtime_min)
    best = Math.max(best, m)
  }
  return Math.max(0, best)
}

/** 给 LLM 的槽位摘要（英文，进 user 消息）。 */
export function slotsSummary(f: Feasibility, prefs: UserPrefs): string {
  if (!f.windows.length) return 'no free time'
  const longest = [...f.windows].sort((a, b) => windowLen(b) - windowLen(a) || a.date.localeCompare(b.date))[0]!
  const weekday = f.windows.filter((w) => !isWeekend(w.dow))
  const weekend = f.windows.filter((w) => isWeekend(w.dow))
  const avgH = (ws: Window[]) => (ws.reduce((a, w) => a + windowLen(w), 0) / ws.length / 60).toFixed(1)
  const parts = [
    `${f.windows.length} windows over ${new Set(f.windows.map((w) => w.date)).size} days`,
    `longest ${(windowLen(longest) / 60).toFixed(1)}h (${DOW_EN[longest.dow]})`,
  ]
  if (weekday.length) parts.push(`weekday windows ~${avgH(weekday)}h; weekday screenings ≤ ${prefs.weekday_max_runtime_min} min`)
  if (weekend.length) parts.push(`weekend windows ~${avgH(weekend)}h`)
  parts.push(`at most ${prefs.max_films_per_day} films per day`)
  return parts.join('; ')
}
