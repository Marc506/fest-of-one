/**
 * Call B：片单审查（7.5，purpose audit，effort medium，各概念并行）。
 * system 前三块同 A；第 4 块（带 cache 断点）= 审查规则 + 该概念 thesis + 落地后的候选（含 TMDB 事实）。
 * 代码再校验一次：slate ⊆ keep、无重复、无已看、position 1..N 连续、不含 infeasible / commercial_disposable。
 */
import type Anthropic from '@anthropic-ai/sdk'
import { stableStringify } from '@/lib/json'
import { cachedText } from '@/llm/client'
import { callStructured } from '@/llm/call'
import type { CuratorContext } from './context'
import type { GroundedConcept } from './ground'
import type { Mode } from './ideate'
import { prompt, PROMPT_VERSION, render } from './prompts'
import { AuditOutput, type AuditOutputT } from './schemas'

export function conceptBlock(g: GroundedConcept): string {
  const c = g.concept
  const programme = {
    kind: c.kind,
    subject: c.subject,
    title: c.title,
    thesis: c.thesis,
    why_now: c.why_now,
    evidence_from_log: c.evidence,
    candidates: g.candidates.map((x) => ({
      tmdb_id: x.tmdb_id,
      title: x.film.titleEn,
      original_title: x.film.originalTitle,
      year: x.film.year,
      directors: x.film.directors.map((d) => d.name),
      countries: x.film.countries,
      runtime_min: x.film.runtimeMin,
      genres: x.film.genres,
      keywords: x.film.keywords.slice(0, 12),
      vote_count: x.film.voteCount,
      vote_avg: x.film.voteAvg,
      overview: (x.film.overviewEn ?? '').slice(0, 400),
      role_in_program: x.role_in_program,
      connection: x.connection,
      if_only_one: x.if_only_one,
      infeasible: x.infeasible,
    })),
  }
  return `${prompt('audit.system')}\n\n## Programme under review\n${stableStringify(programme, 1)}`
}

export function auditSystem(ctx: CuratorContext, g: GroundedConcept): Anthropic.TextBlockParam[] {
  return [...ctx.system, cachedText(conceptBlock(g))]
}

export function auditUserMessage(ctx: CuratorContext, input: { n: number; mode: Mode; slotsSummary: string; maxRuntime: number }): string {
  const modeBlock = input.mode === 'single' ? prompt('audit.mode.single') : render(prompt('audit.mode.festival'), { n: input.n })
  return render(prompt('audit.user'), {
    n: input.n,
    mode: input.mode,
    locale: ctx.user.locale,
    slots_summary: input.slotsSummary,
    max_runtime: input.maxRuntime,
    mode_block: modeBlock,
  })
}

/** 代码侧校验；返回问题列表（空 = 通过）。 */
export function validateAudit(out: AuditOutputT, g: GroundedConcept, n: number, seen: Set<number>): string[] {
  const problems: string[] = []
  const cand = new Map(g.candidates.map((c) => [c.tmdb_id, c]))
  const kept = new Set(out.decisions.filter((d) => d.keep).map((d) => d.tmdb_id))
  const disposable = new Set(out.decisions.filter((d) => d.register === 'commercial_disposable').map((d) => d.tmdb_id))
  if (out.insufficient) problems.push('审查认为候选不足')
  const ids = out.slate.map((s) => s.tmdb_id)
  if (new Set(ids).size !== ids.length) problems.push('slate 有重复')
  for (const s of out.slate) {
    if (!cand.has(s.tmdb_id)) problems.push(`slate 含非候选片 ${s.tmdb_id}`)
    else if (cand.get(s.tmdb_id)!.infeasible) problems.push(`slate 含排不下的片 ${s.tmdb_id}`)
    if (!kept.has(s.tmdb_id)) problems.push(`slate 含未保留的片 ${s.tmdb_id}`)
    if (disposable.has(s.tmdb_id)) problems.push(`slate 含 commercial_disposable ${s.tmdb_id}`)
    if (seen.has(s.tmdb_id)) problems.push(`slate 含已看片 ${s.tmdb_id}`)
  }
  if (out.slate.length !== n) problems.push(`slate 有 ${out.slate.length} 部，需要 ${n} 部`)
  const positions = [...out.slate.map((s) => s.position)].sort((a, b) => a - b)
  if (!positions.every((p, i) => p === i + 1)) problems.push('position 不是 1..N 连续')
  return problems
}

/** 规范化角色：≥ 3 部时第一部 opening、最后一部 closing、至多一个 centerpiece。 */
export function normalizeSlate(out: AuditOutputT): AuditOutputT['slate'] {
  const slate = [...out.slate].sort((a, b) => a.position - b.position)
  let centerpiece = false
  return slate.map((s, i) => {
    let role = s.role
    if (slate.length >= 3 && i === 0) role = 'opening'
    else if (slate.length >= 3 && i === slate.length - 1) role = 'closing'
    else if (slate.length === 1) role = 'opening'
    else if (role === 'opening' || role === 'closing') role = 'regular'
    if (role === 'centerpiece') {
      if (centerpiece) role = 'regular'
      centerpiece = true
    }
    return { ...s, role }
  })
}

export async function audit(
  ctx: CuratorContext,
  g: GroundedConcept,
  input: { n: number; mode: Mode; slotsSummary: string; maxRuntime: number },
  deps: { jobId?: string | null; log?: (l: string) => void },
) {
  const res = await callStructured({
    purpose: 'audit',
    promptVersion: PROMPT_VERSION,
    system: auditSystem(ctx, g),
    messages: [{ role: 'user', content: auditUserMessage(ctx, input) }],
    schema: AuditOutput,
    effort: 'medium',
    userId: ctx.user.id,
    jobId: deps.jobId,
    log: deps.log,
  })
  const problems = validateAudit(res.output, g, input.n, ctx.seen)
  return { output: res.output, usage: res.usage, problems, valid: problems.length === 0 }
}
