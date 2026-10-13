/**
 * 确定性排期（8.3 / 8.4）。LLM 只给顺序（P4），这里决定时间。
 *
 * 1. 选天：枚举有窗口的日期里 `days` 天的组合（≤ C(7,days)），按「总可用时长 / 分布均匀 / 周末能放最长片」打分；
 *    依分数顺序尝试，第一个能排下的组合胜出。
 * 2. 配额：每天至少 1 部；其余按该天最长窗口降序分配，受 max_films_per_day 限制。
 * 3. 放置：按 position 顺序（不跨天乱序）逐部放进当天窗口的最早可行位置（若窗口允许则优先 preferred_start）；
 *    要求 start + runtime + buffer ≤ window.end；工作日不放超过 weekday_max_runtime_min 的片。
 *    放不下 → 回溯（换到后一天 / 前一部提前），步数上限。
 * 4. 仍失败 → 只固定 opening 第一、closing 最后，中段换序再试；
 *    仍失败 → 尽量放，放不下的 starts_at = null 并写明原因。
 */
import type { UserPrefs } from '@/db/types'
import { hhmmToMin, isWeekend, localToUtc, windowLen, type Window } from './slots'

export type SlateFilm = { tmdbId: number; position: number; role: string; runtimeMin: number }

export type Placement = {
  tmdbId: number
  position: number
  date: string | null
  /** 本地分钟 */
  start: number | null
  startsAt: string | null
  endsAt: string | null
  unscheduledReason: string | null
}

/**
 * order：strict = 完全按策展顺序；relaxed = 只保证 opening 第一、closing 最后；any = 贪心兜底，顺序可能打乱。
 */
export type ScheduleResult = { placements: Placement[]; days: string[]; relaxedOrder: boolean; order: 'strict' | 'relaxed' | 'any'; complete: boolean }

type DayPlan = { date: string; dow: number; windows: Window[] }

function groupDays(windows: Window[]): DayPlan[] {
  const m = new Map<string, DayPlan>()
  for (const w of [...windows].sort((a, b) => a.date.localeCompare(b.date) || a.start - b.start)) {
    const d = m.get(w.date) ?? { date: w.date, dow: w.dow, windows: [] }
    d.windows.push(w)
    m.set(w.date, d)
  }
  return [...m.values()]
}

function combinations<T>(xs: T[], k: number): T[][] {
  const out: T[][] = []
  const rec = (start: number, acc: T[]) => {
    if (acc.length === k) {
      out.push([...acc])
      return
    }
    for (let i = start; i <= xs.length - (k - acc.length); i++) rec(i + 1, [...acc, xs[i]!])
  }
  rec(0, [])
  return out
}

const dayIndex = (date: string, base: string) => Math.round((Date.parse(date) - Date.parse(base)) / 86400_000)

/** 组合打分：总可用时长（归一）− 间隔方差 + 周末能放最长片。 */
function scoreCombo(combo: DayPlan[], allMinutes: number, longestFilm: number, prefs: UserPrefs, base: string): number {
  const minutes = combo.reduce((a, d) => a + d.windows.reduce((s, w) => s + windowLen(w), 0), 0)
  const idx = combo.map((d) => dayIndex(d.date, base))
  let variance = 0
  if (idx.length > 2) {
    const gaps = idx.slice(1).map((v, i) => v - idx[i]!)
    const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length
    variance = gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length
  }
  const needsWeekend = longestFilm > prefs.weekday_max_runtime_min
  const weekendOk = combo.some((d) => isWeekend(d.dow) && d.windows.some((w) => windowLen(w) >= longestFilm + prefs.buffer_min))
  return minutes / Math.max(1, allMinutes) - 0.1 * variance + (needsWeekend && weekendOk ? 0.2 : 0)
}

/**
 * 在一天里按顺序放若干部；返回每部的本地开始分钟，放不下返回 null。
 * 先试「第一部从 preferred_start 开始」，整天放不下再退回「从窗口开头开始」（8.3 的 "if fits"）。
 */
function placeInDay(day: DayPlan, films: SlateFilm[], prefs: UserPrefs): number[] | null {
  const preferred = prefs.preferred_start ? hhmmToMin(prefs.preferred_start) : null
  return (preferred !== null ? placeWith(day, films, prefs, preferred) : null) ?? placeWith(day, films, prefs, null)
}

function placeWith(day: DayPlan, films: SlateFilm[], prefs: UserPrefs, preferred: number | null): number[] | null {
  const buffer = prefs.buffer_min
  const starts: number[] = []
  let cursor = -Infinity
  let wi = 0
  for (const f of films) {
    if (!isWeekend(day.dow) && f.runtimeMin > prefs.weekday_max_runtime_min) return null
    let placed = false
    for (; wi < day.windows.length; wi++) {
      const w = day.windows[wi]!
      const earliest = Math.max(w.start, cursor)
      let start = earliest
      if (preferred !== null && starts.length === 0 && preferred > earliest && preferred + f.runtimeMin + buffer <= w.end) start = preferred
      if (start + f.runtimeMin + buffer <= w.end) {
        starts.push(start)
        cursor = start + f.runtimeMin + buffer
        placed = true
        break
      }
    }
    if (!placed) return null
  }
  return starts
}

/**
 * 按顺序把 films 分给 days（非递减、每天 ≥ 1、每天 ≤ max），DFS 回溯；返回每天的影片列表。
 * quotas 给出首选的每天部数；DFS 先试配额，再试其它切分。
 */
function assign(days: DayPlan[], films: SlateFilm[], prefs: UserPrefs, quotas: number[], stepLimit: number): SlateFilm[][] | null {
  let steps = 0
  const result: SlateFilm[][] = []
  const rec = (d: number, i: number): boolean => {
    if (++steps > stepLimit) return false
    if (d === days.length) return i === films.length
    const remainingDays = days.length - d - 1
    const maxTake = Math.min(prefs.max_films_per_day, films.length - i - remainingDays)
    const order = [quotas[d] ?? 1, ...Array.from({ length: maxTake }, (_, k) => maxTake - k)].filter(
      (k, idx, arr) => k >= 1 && k <= maxTake && arr.indexOf(k) === idx,
    )
    for (const take of order) {
      const chunk = films.slice(i, i + take)
      if (!placeInDay(days[d]!, chunk, prefs)) continue
      result[d] = chunk
      if (rec(d + 1, i + take)) return true
    }
    return false
  }
  return rec(0, 0) ? result.slice(0, days.length) : null
}

function quotasFor(days: DayPlan[], n: number, prefs: UserPrefs): number[] {
  const q = days.map(() => 1)
  let extra = n - days.length
  const byLongest = days
    .map((d, i) => ({ i, longest: Math.max(...d.windows.map(windowLen)) }))
    .sort((a, b) => b.longest - a.longest || a.i - b.i)
  while (extra > 0) {
    let progressed = false
    for (const { i } of byLongest) {
      if (extra === 0) break
      if (q[i]! < prefs.max_films_per_day) {
        q[i]!++
        extra--
        progressed = true
      }
    }
    if (!progressed) break
  }
  return q
}

function permutations<T>(xs: T[], limit: number): T[][] {
  const out: T[][] = []
  const rec = (rest: T[], acc: T[]) => {
    if (out.length >= limit) return
    if (!rest.length) {
      out.push(acc)
      return
    }
    for (let i = 0; i < rest.length; i++) rec([...rest.slice(0, i), ...rest.slice(i + 1)], [...acc, rest[i]!])
  }
  rec(xs, [])
  return out
}

function toPlacements(plan: { day: DayPlan; films: SlateFilm[] }[], prefs: UserPrefs, tz: string): Placement[] {
  const out: Placement[] = []
  for (const { day, films } of plan) {
    const starts = placeInDay(day, films, prefs)!
    films.forEach((f, k) => {
      const s = starts[k]!
      out.push({
        tmdbId: f.tmdbId,
        position: f.position,
        date: day.date,
        start: s,
        startsAt: localToUtc(day.date, s, tz),
        endsAt: localToUtc(day.date, s + f.runtimeMin, tz),
        unscheduledReason: null,
      })
    })
  }
  return out
}

export function schedule(slateIn: SlateFilm[], windows: Window[], daysWanted: number, prefs: UserPrefs, tz: string): ScheduleResult {
  const slate = [...slateIn].sort((a, b) => a.position - b.position)
  const allDays = groupDays(windows)
  if (!slate.length) return { placements: [], days: [], relaxedOrder: false, order: 'strict', complete: true }

  // 单部模式（8.4）：最长窗口的最早合适时间
  if (slate.length === 1) {
    const f = slate[0]!
    const candidates = allDays
      .flatMap((d) => d.windows.map((w) => ({ d, w })))
      .filter(({ d }) => isWeekend(d.dow) || f.runtimeMin <= prefs.weekday_max_runtime_min)
      .sort((a, b) => windowLen(b.w) - windowLen(a.w) || a.w.date.localeCompare(b.w.date) || a.w.start - b.w.start)
    for (const { d, w } of candidates) {
      const starts = placeInDay({ ...d, windows: [w] }, [f], prefs)
      if (starts) {
        return {
          placements: toPlacements([{ day: { ...d, windows: [w] }, films: [f] }], prefs, tz),
          days: [d.date],
          relaxedOrder: false,
          order: 'strict',
          complete: true,
        }
      }
    }
    return {
      placements: [unscheduled(f, `没有能放下 ${f.runtimeMin} 分钟的空档`)],
      days: [],
      relaxedOrder: false,
      order: 'strict',
      complete: false,
    }
  }

  const usable = allDays.filter((d) => d.windows.some((w) => windowLen(w) >= 80))
  const k = Math.max(1, Math.min(daysWanted, usable.length, slate.length))
  const allMinutes = usable.reduce((a, d) => a + d.windows.reduce((s, w) => s + windowLen(w), 0), 0)
  const longestFilm = Math.max(...slate.map((f) => f.runtimeMin))
  const base = usable[0]?.date ?? '1970-01-01'
  const stepLimit = Math.max(64, slate.length ** 2 * 8)

  // 天数优先保持用户要求；排不下时再尝试相邻的天数（偏离：规格没写，但比留下未排入的片更好）
  const dayCounts = [k, ...Array.from({ length: usable.length }, (_, i) => i + 1).filter((x) => x !== k && x <= slate.length).sort((a, b) => Math.abs(a - k) - Math.abs(b - k) || b - a)]

  // 尝试顺序：(要求的天数, 严格顺序) → (要求的天数, 放宽顺序) → (相邻天数, …)；都不行才留未排入
  const relaxedOrders = permutations(slate.slice(1, -1), 720).map((mid) => [slate[0]!, ...mid, slate.at(-1)!])
  for (const count of dayCounts) {
    for (const relax of [false, true]) {
      const orders = relax ? relaxedOrders : [slate]
      const combos = combinations(usable, count)
        .map((c) => ({ c, s: scoreCombo(c, allMinutes, longestFilm, prefs, base) }))
        .sort((a, b) => b.s - a.s || a.c.map((d) => d.date).join().localeCompare(b.c.map((d) => d.date).join()))
      for (const { c } of combos) {
        const q = quotasFor(c, slate.length, prefs)
        for (const order of orders) {
          const a = assign(c, order, prefs, q, stepLimit)
          if (a) {
            return {
              placements: toPlacements(
                c.map((day, i) => ({ day, films: a[i]! })),
                prefs,
                tz,
              ).sort((x, y) => x.position - y.position),
              days: c.map((d) => d.date),
              relaxedOrder: relax,
              order: relax ? 'relaxed' : 'strict',
              complete: true,
            }
          }
        }
      }
    }
  }

  // 尽量放：贪心逐部放到任意还有空的位置
  return greedyPartial(slate, usable, prefs, tz)
}

function unscheduled(f: SlateFilm, reason: string): Placement {
  return { tmdbId: f.tmdbId, position: f.position, date: null, start: null, startsAt: null, endsAt: null, unscheduledReason: reason }
}

function greedyPartial(slate: SlateFilm[], days: DayPlan[], prefs: UserPrefs, tz: string): ScheduleResult {
  const used = new Map<string, SlateFilm[]>()
  const placements: Placement[] = []
  for (const f of slate) {
    let ok = false
    for (const d of days) {
      const cur = used.get(d.date) ?? []
      if (cur.length >= prefs.max_films_per_day) continue
      const next = [...cur, f]
      if (placeInDay(d, next, prefs)) {
        used.set(d.date, next)
        ok = true
        break
      }
    }
    if (!ok) {
      const tooLong = !days.some((d) => d.windows.some((w) => windowLen(w) >= f.runtimeMin + prefs.buffer_min))
      placements.push(unscheduled(f, tooLong ? `片长 ${f.runtimeMin} 分钟，本周没有这么长的空档` : '可用时间不够，排不下这一部'))
    }
  }
  for (const d of days) {
    const films = used.get(d.date)
    if (films?.length) placements.push(...toPlacements([{ day: d, films }], prefs, tz))
  }
  return {
    placements: placements.sort((a, b) => a.position - b.position),
    days: [...used.keys()].sort(),
    relaxedOrder: true,
    order: 'any',
    complete: placements.every((p) => p.startsAt),
  }
}
