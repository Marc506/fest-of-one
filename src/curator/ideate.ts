/** Call A：概念生成（7.3，purpose ideate，effort high，可调 TMDB 工具）。 */
import type { FestivalAvoid } from '@/db/types'
import type { HistoryItem } from '@/db/repo/festivals'
import { callStructured } from '@/llm/call'
import type { TmdbClient } from '@/resolver/tmdb'
import { curationEffort, type CuratorContext } from './context'
import { prompt, PROMPT_VERSION, render } from './prompts'
import { IdeateOutput } from './schemas'
import { createToolExecutor, TOOL_DEFS } from './tools'

export type Mode = 'festival' | 'single'

export type IdeateInput = {
  mode: Mode
  n: number
  days: number
  today: string
  slotsSummary: string
  maxRuntime: number
  history: HistoryItem[]
  avoid: FestivalAvoid
}

export function formatHistory(history: HistoryItem[]): string {
  if (!history.length) return '  (none yet)'
  return history
    .slice(0, 12)
    .map(
      (h) =>
        `  - ${h.weekStart} ${h.kind} · ${h.subject} · [${h.films.map((f) => `${f.tmdbId} ${f.title}${f.feedback ? ` (${f.feedback.replace('_', ' ')})` : ''}`).join('; ')}]`,
    )
    .join('\n')
}

export function ideateUserMessage(ctx: CuratorContext, input: IdeateInput): string {
  const modeBlock =
    input.mode === 'single'
      ? prompt('ideate.mode.single')
      : render(prompt('ideate.mode.festival'), { n: input.n, min_candidates: input.n * 2, max_candidates: input.n * 3 })
  return render(prompt('ideate.user'), {
    today: input.today,
    locale: ctx.user.locale,
    n: input.n,
    days: input.days,
    mode: input.mode,
    slots_summary: input.slotsSummary,
    max_runtime: input.maxRuntime,
    history: formatHistory(input.history),
    avoid_kinds: JSON.stringify(input.avoid.kinds),
    avoid_subjects: JSON.stringify(input.avoid.subjects),
    avoid_films: JSON.stringify(input.avoid.tmdb_ids),
    mode_block: modeBlock,
  })
}

export async function ideate(
  ctx: CuratorContext,
  input: IdeateInput,
  deps: { client: TmdbClient; jobId?: string | null; log?: (l: string) => void },
) {
  const execute = createToolExecutor({ client: deps.client, seen: ctx.seen, log: (...a) => deps.log?.(a.join(' ')) })
  return callStructured({
    purpose: 'ideate',
    promptVersion: PROMPT_VERSION,
    system: ctx.system,
    messages: [{ role: 'user', content: ideateUserMessage(ctx, input) }],
    schema: IdeateOutput,
    effort: curationEffort(),
    tools: { defs: TOOL_DEFS, execute, maxRounds: 12 },
    userId: ctx.user.id,
    jobId: deps.jobId,
    log: deps.log,
  })
}
