/**
 * 选择策略（7.6，代码，确定性）。
 *
 *   base = 0.35·taste_fit + 0.25·novelty + 0.20·coherence + 0.10·ambition + 0.10·confidence
 *   penalties: kind == 上周 kind −0.15；kind == 上周 == 上上周 → 排除；subject 12 周内出现过 → 排除；
 *              slate 排不进可用时间 → 排除
 *   bonus:     motif 且 coherence ≥ 0.75 +0.05；kind 4 周内未出现 +0.03
 *   argmax；tie-break motif > actor > country > director
 * 全部被排除：放宽「同 kind 两周」再算；仍为空 → 失败。
 *
 * 单部模式（7.7）：taste_fit·0.5 + novelty·0.3 + confidence·0.2。
 * taste_fit / novelty / ambition 取 Call A 自评；coherence / confidence 取 Call B（审查后的判断更可靠）。
 */
import type { HistoryItem } from '@/db/repo/festivals'
import type { FestivalAvoid } from '@/db/types'
import { normalizeTitle } from '@/resolver/normalize'
import { addDays } from '@/scheduler/slots'
import type { GroundedConcept } from './ground'
import type { Mode } from './ideate'
import type { AuditOutputT, ConceptKind } from './schemas'

export type Audited = { g: GroundedConcept; audit: AuditOutputT; valid: boolean; problems: string[]; scheduleOk: boolean }

export type TraceRow = {
  index: number
  kind: ConceptKind
  subject: string
  title: string
  parts: Record<string, number>
  penalties: Record<string, number>
  bonuses: Record<string, number>
  score: number | null
  excluded: string | null
}

const KIND_ORDER: Record<ConceptKind, number> = { motif: 4, actor: 3, country: 2, director: 1 }
const clamp01 = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0))
const r3 = (n: number) => Math.round(n * 1000) / 1000

export const sameSubject = (a: string, b: string) => normalizeTitle(a) === normalizeTitle(b)

export function selectConcept(
  items: Audited[],
  opts: { mode: Mode; weekStart: string; history: HistoryItem[]; avoid: FestivalAvoid; relaxKindRule?: boolean },
): { chosen: Audited | null; trace: TraceRow[]; relaxed: boolean } {
  const lastWeek = opts.history.find((h) => h.weekStart === addDays(opts.weekStart, -7))
  const twoWeeksAgo = opts.history.find((h) => h.weekStart === addDays(opts.weekStart, -14))
  const since12 = addDays(opts.weekStart, -84)
  const since4 = addDays(opts.weekStart, -28)
  const recent12 = opts.history.filter((h) => h.weekStart >= since12)
  const recent4Kinds = new Set(opts.history.filter((h) => h.weekStart >= since4).map((h) => h.kind))

  const run = (relax: boolean) => {
    const trace: TraceRow[] = []
    for (const it of items) {
      const c = it.g.concept
      const a = it.audit
      const row: TraceRow = { index: it.g.index, kind: c.kind, subject: c.subject, title: a.revised_title || c.title, parts: {}, penalties: {}, bonuses: {}, score: null, excluded: null }
      trace.push(row)
      if (!it.valid) {
        row.excluded = `审查未通过：${it.problems.join('；')}`
        continue
      }
      if (opts.avoid.kinds.includes(c.kind)) {
        row.excluded = '换一个：回避该类型'
        continue
      }
      if (opts.avoid.subjects.some((s) => sameSubject(s, c.subject))) {
        row.excluded = '换一个：回避该主题'
        continue
      }
      if (recent12.some((h) => sameSubject(h.subject, c.subject))) {
        row.excluded = '主题 12 周内出现过'
        continue
      }
      if (!it.scheduleOk) {
        row.excluded = '片单排不进本周的可用时间'
        continue
      }
      const s = c.self_scores
      if (opts.mode === 'single') {
        row.parts = { taste_fit: clamp01(s.taste_fit), novelty: clamp01(s.novelty), confidence: clamp01(a.confidence) }
        row.score = r3(0.5 * row.parts.taste_fit! + 0.3 * row.parts.novelty! + 0.2 * row.parts.confidence!)
        continue
      }
      row.parts = {
        taste_fit: clamp01(s.taste_fit),
        novelty: clamp01(s.novelty),
        coherence: clamp01(a.coherence),
        ambition: clamp01(s.ambition),
        confidence: clamp01(a.confidence),
      }
      const p = row.parts
      const base = 0.35 * p.taste_fit! + 0.25 * p.novelty! + 0.2 * p.coherence! + 0.1 * p.ambition! + 0.1 * p.confidence!
      if (lastWeek && twoWeeksAgo && c.kind === lastWeek.kind && c.kind === twoWeeksAgo.kind && !relax) {
        row.excluded = '同一类型已连续两周'
        continue
      }
      if (lastWeek && c.kind === lastWeek.kind) row.penalties.same_kind_as_last_week = 0.15
      if (c.kind === 'motif' && p.coherence! >= 0.75) row.bonuses.confident_motif = 0.05
      if (!recent4Kinds.has(c.kind)) row.bonuses.kind_fresh_4w = 0.03
      const pen = Object.values(row.penalties).reduce((x, y) => x + y, 0)
      const bon = Object.values(row.bonuses).reduce((x, y) => x + y, 0)
      row.score = r3(base + bon - pen)
    }
    const eligible = trace.filter((t) => t.score != null && t.excluded == null)
    eligible.sort((x, y) => y.score! - x.score! || KIND_ORDER[y.kind] - KIND_ORDER[x.kind] || x.index - y.index)
    const best = eligible[0]
    return { trace, chosen: best ? items.find((i) => i.g.index === best.index)! : null }
  }

  const first = run(Boolean(opts.relaxKindRule))
  if (first.chosen || opts.mode === 'single') return { ...first, relaxed: Boolean(opts.relaxKindRule) }
  const second = run(true)
  return { ...second, relaxed: true }
}
