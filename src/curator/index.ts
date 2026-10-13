/**
 * 策展流水线（7.1）：
 *   0. slots   = 槽位推导 + 可行性预检（N = 1 → single 模式）
 *   1. ctx     = 缓存前缀：curator system + memo/stats + 完整观影记录
 *   2. ideate  = Call A（工具）→ 4–6 个概念
 *   3. ground  = TMDB 落地、剔除已看 / 回避 / 幻觉，补片长
 *   4. audits  = Call B，先跑一个暖缓存，其余并行（≤ 6）
 *   5. select  = 确定性评分 → 唯一结果
 *   6. sched   = 确定性排期
 *   7. persist（`persistCuration`，调用方决定是否落库）
 */
import { formatInTimeZone } from 'date-fns-tz'
import { insertFestivalWithScreenings, notInterestedIds, recentProgrammes, type HistoryItem } from '@/db/repo/festivals'
import type { Festival, Film, Screening } from '@/db/schema'
import type { FestivalAvoid } from '@/db/types'
import { UserFacingError } from '@/jobs/types'
import { mapLimit } from '@/lib/http'
import { LlmOutputError } from '@/llm/call'
import { emptyTotals, mergeTotals, type UsageTotals } from '@/llm/cost'
import type { TmdbClient } from '@/resolver/tmdb'
import { getTmdbClient } from '@/resolver/tmdb'
import { schedule, type Placement } from '@/scheduler/schedule'
import { addDays, checkFeasibility, deriveWindows, slotsSummary, type AvailabilityInput, type Feasibility, type Window } from '@/scheduler/slots'
import { audit, normalizeSlate } from './audit'
import { assembleContext, type CuratorContext } from './context'
import { dropRate, groundConcepts, type GroundedConcept } from './ground'
import { ideate, type Mode } from './ideate'
import type { AuditOutputT, IdeateOutputT } from './schemas'
import { sameSubject, selectConcept, type Audited, type TraceRow } from './select'

export const AUDIT_PARALLELISM = 6

export type CurateRequest = {
  userId: string
  weekStart: string
  days: number
  filmCount: number
  availability: AvailabilityInput
  avoid: FestivalAvoid
  /** 用户时区的今天（进 user 消息）；默认按 tz 计算 */
  today?: string
  /** 截掉本周已过去的时间；默认 new Date() */
  now?: Date
  jobId?: string | null
  client?: TmdbClient
  progress?: (pct: number, msg?: string) => void
  log?: (line: string) => void
}

export type SlateItem = {
  tmdbId: number
  position: number
  role: Screening['role']
  programNote: string
  orderRationale: string
  film: Film
  placement: Placement
}

export type CurationResult = {
  mode: Mode
  windows: Window[]
  feasibility: Feasibility
  ideate: IdeateOutputT
  grounded: GroundedConcept[]
  audited: Audited[]
  trace: TraceRow[]
  relaxed: boolean
  chosen: {
    audited: Audited
    kind: Festival['kind']
    subject: string
    title: string
    statement: string
    slate: SlateItem[]
    days: string[]
    relaxedOrder: boolean
  }
  alternatives: { kind: string; subject: string; title: string; score: number | null; reason: string }[]
  history: HistoryItem[]
  usage: UsageTotals
  dropRate: number
  context: { systemChars: number[]; seen: number }
}

function localTitle(f: Film, locale: string): string {
  return locale === 'zh-CN' ? (f.titleZh ?? f.titleEn) : f.titleEn
}

export async function curate(req: CurateRequest): Promise<CurationResult> {
  const progress = req.progress ?? (() => {})
  const log = req.log ?? (() => {})
  const client = req.client ?? getTmdbClient()
  const now = req.now ?? new Date()
  const prefs = req.availability.prefs

  // 0. 槽位
  const windows = deriveWindows(req.availability, req.weekStart, now)
  const feasibility = checkFeasibility(windows, req.days, req.filmCount, prefs)
  if (feasibility.error) throw new UserFacingError(feasibility.error)
  const mode: Mode = req.filmCount === 1 ? 'single' : 'festival'
  const n = req.filmCount
  const summary = slotsSummary(feasibility, prefs)

  // 1. 上下文
  progress(3, '读取完整观影记录…')
  const ctx: CuratorContext = assembleContext(req.userId)
  const today = req.today ?? formatInTimeZone(now, ctx.user.tz, 'yyyy-MM-dd')
  const history = recentProgrammes(req.userId, { sinceWeek: addDays(req.weekStart, -84), beforeWeek: req.weekStart })
  const avoidIds = new Set<number>([...req.avoid.tmdb_ids, ...notInterestedIds(req.userId), ...history.flatMap((h) => h.films.map((f) => f.tmdbId))])
  let usage = emptyTotals()

  // 2. Call A
  progress(8, 'ideating：策展人在想这周放什么…')
  const a = await ideate(
    ctx,
    { mode, n, days: feasibility.days, today, slotsSummary: summary, maxRuntime: feasibility.maxRuntime, history, avoid: req.avoid },
    { client, jobId: req.jobId, log },
  )
  usage = mergeTotals(usage, a.usage)
  log(`[curate] ideate: ${a.output.concepts.length} concepts, ${a.toolCalls.length} tool calls`)

  // 3. 落地
  progress(45, 'grounding：核对 TMDB 与观影记录…')
  const grounded = await groundConcepts(a.output.concepts, {
    client,
    seen: ctx.seen,
    avoidIds,
    maxRuntime: feasibility.maxRuntime,
    n,
    minCandidates: mode === 'single' ? 1 : n,
  })
  const dr = dropRate(grounded)
  if (dr > 0.3) log(`[curate] warning: ${(dr * 100).toFixed(0)}% candidates failed TMDB grounding (> 30%): prompt or tools need attention`)

  // 4. 审查：先排除注定不会入选的（省钱），其余先跑一个暖缓存、再并行
  const recent12 = history
  const auditable = grounded.filter(
    (g) =>
      !g.insufficient &&
      !req.avoid.kinds.includes(g.concept.kind) &&
      !req.avoid.subjects.some((s) => sameSubject(s, g.concept.subject)) &&
      !recent12.some((h) => sameSubject(h.subject, g.concept.subject)),
  )
  const auditInput = { n, mode, slotsSummary: summary, maxRuntime: feasibility.maxRuntime }
  let done = 0
  const runAudit = async (g: GroundedConcept): Promise<Audited | null> => {
    try {
      const r = await audit(ctx, g, auditInput, { jobId: req.jobId, log })
      usage = mergeTotals(usage, r.usage)
      const slate = normalizeSlate(r.output)
      const out: AuditOutputT = { ...r.output, slate }
      let scheduleOk = false
      if (r.valid) {
        const films = new Map(g.candidates.map((c) => [c.tmdb_id, c.film]))
        const s = schedule(
          slate.map((x) => ({ tmdbId: x.tmdb_id, position: x.position, role: x.role, runtimeMin: films.get(x.tmdb_id)!.runtimeMin! })),
          windows,
          feasibility.days,
          prefs,
          ctx.user.tz,
        )
        scheduleOk = s.complete
      }
      return { g, audit: out, valid: r.valid, problems: r.problems, scheduleOk }
    } catch (err) {
      if (err instanceof LlmOutputError) {
        log(`[curate] audit of concept ${g.index} failed: ${err.message}`)
        return null
      }
      throw err
    } finally {
      done++
      progress(50 + (done / Math.max(1, auditable.length)) * 35, `auditing (${done}/${auditable.length})`)
    }
  }
  progress(50, `auditing (0/${auditable.length})`)
  const audited: Audited[] = []
  if (auditable.length) {
    const first = await runAudit(auditable[0]!)
    if (first) audited.push(first)
    const rest = await mapLimit(auditable.slice(1), AUDIT_PARALLELISM, runAudit)
    for (const r of rest) if (r) audited.push(r)
  }

  // 5. 选择
  const sel = selectConcept(audited, { mode, weekStart: req.weekStart, history, avoid: req.avoid })
  if (!sel.chosen) {
    const reasons = sel.trace.map((t) => `${t.kind} · ${t.subject}：${t.excluded ?? '—'}`).join('\n')
    throw new UserFacingError(
      `这周没有一个方案能成立。请增加可用时间或减少部数后再试。\n${reasons || '（所有概念的候选都不足）'}`,
    )
  }

  // 6. 排期
  progress(90, 'scheduling：排进你的空档…')
  const chosen = sel.chosen
  const films = new Map(chosen.g.candidates.map((c) => [c.tmdb_id, c.film]))
  const slate = [...chosen.audit.slate].sort((x, y) => x.position - y.position)
  const sched = schedule(
    slate.map((x) => ({ tmdbId: x.tmdb_id, position: x.position, role: x.role, runtimeMin: films.get(x.tmdb_id)!.runtimeMin! })),
    windows,
    feasibility.days,
    prefs,
    ctx.user.tz,
  )
  const placement = new Map(sched.placements.map((p) => [p.tmdbId, p]))
  const items: SlateItem[] = slate.map((s) => ({
    tmdbId: s.tmdb_id,
    position: s.position,
    role: s.role,
    programNote: s.program_note,
    orderRationale: s.order_rationale,
    film: films.get(s.tmdb_id)!,
    placement: placement.get(s.tmdb_id)!,
  }))

  const single = mode === 'single'
  const singleFilm = items[0]!.film
  const c = chosen.g.concept
  const alternatives = grounded
    .filter((g) => g.index !== chosen.g.index)
    .map((g) => {
      const t = sel.trace.find((x) => x.index === g.index)
      return {
        kind: g.concept.kind,
        subject: g.concept.subject,
        title: g.concept.title,
        score: t?.score ?? null,
        reason: t?.excluded ?? (g.insufficient ? '落地后候选不足' : t ? '得分较低' : '未进入审查（回避或 12 周内重复）'),
      }
    })
  progress(100, '完成')
  return {
    mode,
    windows,
    feasibility,
    ideate: a.output,
    grounded,
    audited,
    trace: sel.trace,
    relaxed: sel.relaxed,
    chosen: {
      audited: chosen,
      kind: single ? 'single' : c.kind,
      subject: single ? `${singleFilm.titleEn} (${singleFilm.year ?? '?'})` : c.subject,
      title: single ? localTitle(singleFilm, ctx.user.locale) : chosen.audit.revised_title || c.title,
      statement: chosen.audit.revised_statement,
      slate: items,
      days: sched.days,
      relaxedOrder: sched.relaxedOrder,
    },
    alternatives,
    history,
    usage,
    dropRate: dr,
    context: { systemChars: ctx.system.map((b) => b.text.length), seen: ctx.seen.size },
  }
}

/** 7. 落库：festival + screenings（事务）。 */
export function persistCuration(requestId: string, userId: string, r: CurationResult, status: Festival['status'] = 'published') {
  return insertFestivalWithScreenings(
    {
      requestId,
      userId,
      kind: r.chosen.kind,
      subject: r.chosen.subject,
      title: r.chosen.title,
      statementMd: r.chosen.statement,
      concept: { ideate: r.chosen.audited.g.concept, audit: r.chosen.audited.audit },
      alternatives: r.alternatives,
      selectionTrace: {
        mode: r.mode,
        trace: r.trace,
        relaxed: r.relaxed,
        relaxed_order: r.chosen.relaxedOrder,
        drop_rate: r.dropRate,
        grounding: r.grounded.map((g) => ({ index: g.index, kept: g.candidates.length, dropped: g.dropped, insufficient: g.insufficient })),
        feasibility_notes: r.feasibility.notes,
        usage: r.usage,
      },
      status,
    },
    r.chosen.slate.map((s) => ({
      tmdbId: s.tmdbId,
      position: s.position,
      role: s.role,
      programNoteMd: s.programNote,
      startsAt: s.placement.startsAt,
      endsAt: s.placement.endsAt,
      unscheduledReason: s.placement.unscheduledReason,
    })),
  )
}
