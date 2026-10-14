/**
 * 流水线不变量（13 章）：无已看片、恰好 N 部、全部 TMDB 落地、kind 轮换生效、主题 12 周不重复、
 * 面向观众的文本是 locale、排期不重叠且在窗口内、buffer 满足、顺序单调（除非放宽）。
 */
import { getFilm } from '@/db/repo/library'
import type { UserPrefs } from '@/db/types'
import { isCjk } from '@/resolver/normalize'
import { addDays } from '@/scheduler/slots'
import type { CurationResult } from './index'
import { sameSubject } from './select'

export function checkInvariants(r: CurationResult, opts: { seen: Set<number>; n: number; locale: string; weekStart: string; prefs: UserPrefs }): string[] {
  const v: string[] = []
  const slate = r.chosen.slate
  if (slate.length !== opts.n) v.push(`应有 ${opts.n} 部，实际 ${slate.length} 部`)
  for (const s of slate) {
    if (opts.seen.has(s.tmdbId)) v.push(`已看过的片进了片单：${s.tmdbId}`)
    const f = getFilm(s.tmdbId)
    if (!f?.enrichedAt) v.push(`未在 TMDB 落地：${s.tmdbId}`)
    if (!f?.runtimeMin) v.push(`缺片长：${s.tmdbId}`)
  }
  if (new Set(slate.map((s) => s.tmdbId)).size !== slate.length) v.push('片单有重复')
  if (!slate.map((s) => s.position).every((p, i) => p === i + 1)) v.push('position 不是 1..N')

  // kind 轮换 / 主题不重复
  if (r.mode === 'festival') {
    const last = r.history.find((h) => h.weekStart === addDays(opts.weekStart, -7))
    const prev = r.history.find((h) => h.weekStart === addDays(opts.weekStart, -14))
    if (last && prev && last.kind === r.chosen.kind && prev.kind === r.chosen.kind && !r.relaxed) v.push(`同一 kind 连续三周：${r.chosen.kind}`)
    if (r.history.some((h) => h.weekStart >= addDays(opts.weekStart, -84) && sameSubject(h.subject, r.chosen.subject))) v.push(`主题 12 周内重复：${r.chosen.subject}`)
  } else if (r.chosen.kind !== 'single') v.push('单部模式的 kind 应为 single')

  // locale
  if (opts.locale === 'zh-CN') {
    // 单部模式的标题就是片名（片库里没有中文译名时只能是原名 / 英文名），不按 locale 检查
    const texts = [...(r.mode === 'single' ? [] : [r.chosen.title]), r.chosen.statement, ...slate.map((s) => s.programNote)]
    for (const t of texts) if (!isCjk(t)) v.push(`文本不是中文：「${t.slice(0, 30)}」`)
  }

  // 排期
  const placed = slate.filter((s) => s.placement.startsAt)
  for (const s of slate) if (!s.placement.startsAt && !s.placement.unscheduledReason) v.push(`未排入却没有原因：${s.tmdbId}`)
  const sorted = [...placed].sort((a, b) => a.placement.startsAt!.localeCompare(b.placement.startsAt!))
  for (let i = 1; i < sorted.length; i++) {
    const gap = (Date.parse(sorted[i]!.placement.startsAt!) - Date.parse(sorted[i - 1]!.placement.endsAt!)) / 60000
    if (gap < opts.prefs.buffer_min) v.push(`场次间隔不足 ${opts.prefs.buffer_min} 分钟`)
  }
  if (!r.chosen.relaxedOrder) {
    const byPos = [...placed].sort((a, b) => a.position - b.position)
    for (let i = 1; i < byPos.length; i++) if (byPos[i]!.placement.startsAt! < byPos[i - 1]!.placement.startsAt!) v.push('排期顺序与策展顺序不一致')
  }
  for (const s of placed) {
    const w = r.windows.find((w) => w.date === s.placement.date && s.placement.start! >= w.start && s.placement.start! + s.film.runtimeMin! + opts.prefs.buffer_min <= w.end)
    if (!w) v.push(`场次不在可用窗口内：${s.tmdbId}`)
  }
  const perDay = new Map<string, number>()
  for (const s of placed) perDay.set(s.placement.date!, (perDay.get(s.placement.date!) ?? 0) + 1)
  for (const [d, k] of perDay) if (k > opts.prefs.max_films_per_day) v.push(`${d} 排了 ${k} 部，超过每日上限`)
  return v
}
