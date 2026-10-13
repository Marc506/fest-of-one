/**
 * 统一的 LLM 调用封装（7.11）：装配、调用、zod 校验、写 llm_calls、算成本、打印缓存命中。
 *
 * - 无工具：`messages.parse` + zodOutputFormat；解析失败（极少，通常是 max_tokens 截断）整次重试一次。
 * - 有工具（Call A）：`messages.create` 手动循环，同一请求带 `output_config.format`；
 *   `end_turn` 后用 zod 解析文本块，失败则追加 user「Emit the final JSON now.」再解析一次。
 *   工具轮数用尽后，对后续 tool_use 一律回 is_error，促使模型直接给出最终 JSON。
 */
import { createHash } from 'node:crypto'
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import type { z } from 'zod'
import { insertLlmCall } from '@/db/repo/llm'
import type { llmCalls } from '@/db/schema'
import { getTransport, MAX_TOKENS, MODEL } from './client'
import { addUsage, cacheHitRate, costUsd, emptyTotals, type UsageTotals } from './cost'

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type Purpose = (typeof llmCalls.$inferInsert)['purpose']

export type ToolSpec = {
  defs: Anthropic.Tool[]
  execute: (name: string, input: unknown) => Promise<unknown>
  /** 最多工具轮数（7.3：12） */
  maxRounds?: number
}

export type CallOptions<T> = {
  purpose: Purpose
  promptVersion: string
  system: Anthropic.TextBlockParam[]
  messages: Anthropic.MessageParam[]
  schema: z.ZodType<T>
  effort: Effort
  tools?: ToolSpec
  userId?: string | null
  jobId?: string | null
  maxTokens?: number
  log?: (line: string) => void
}

export type CallResult<T> = {
  output: T
  usage: UsageTotals
  /** 最终的完整对话（含工具往返），调试用 */
  messages: Anthropic.MessageParam[]
  toolCalls: { name: string; input: unknown; error?: string }[]
}

export class LlmRefusalError extends Error {
  constructor(readonly details: unknown) {
    super('模型拒绝了这个请求（stop_reason = refusal）')
  }
}

export class LlmOutputError extends Error {}

export function requestHash(system: unknown, messages: unknown, tools: unknown): string {
  return createHash('sha256').update(JSON.stringify({ system, messages, tools: tools ?? null })).digest('hex')
}

const FINAL_NUDGE = 'Emit the final JSON now.'
const TOOL_BUDGET_EXHAUSTED =
  'Tool budget exhausted. Do not call any more tools; emit the final JSON answer now using only films already returned by tools.'

function textOf(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim()
}

/** 宽松地从文本里取 JSON（结构化输出下应当整段就是 JSON；兜底去掉 ``` 围栏）。 */
export function extractJson(text: string): unknown {
  const t = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim()
  return JSON.parse(t)
}

export async function callStructured<T>(o: CallOptions<T>): Promise<CallResult<T>> {
  const transport = getTransport()
  const usage = emptyTotals()
  const log = o.log ?? ((l: string) => console.log(l))
  const messages: Anthropic.MessageParam[] = [...o.messages]
  const toolCalls: CallResult<T>['toolCalls'] = []
  const format = zodOutputFormat(o.schema)
  const tools = o.tools?.defs

  const record = (res: Anthropic.Message | null, started: number, hash: string, error?: string) => {
    if (res) addUsage(usage, MODEL, res.usage)
    insertLlmCall({
      userId: o.userId ?? null,
      jobId: o.jobId ?? null,
      purpose: o.purpose,
      promptVersion: o.promptVersion,
      model: MODEL,
      effort: o.effort,
      inputTokens: res?.usage.input_tokens ?? 0,
      cacheCreationInputTokens: res?.usage.cache_creation_input_tokens ?? 0,
      cacheReadInputTokens: res?.usage.cache_read_input_tokens ?? 0,
      outputTokens: res?.usage.output_tokens ?? 0,
      costUsd: res ? costUsd(MODEL, res.usage) : 0,
      requestHash: hash,
      response: res ? (JSON.parse(JSON.stringify(res)) as unknown) : { error },
      durationMs: Date.now() - started,
    })
    if (res) {
      const u = res.usage
      const hit = cacheHitRate({
        input_tokens: u.input_tokens,
        cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
        cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
      })
      log(
        `[llm] ${o.purpose} ${transport.name} stop=${res.stop_reason} in=${u.input_tokens} cache_write=${u.cache_creation_input_tokens ?? 0} cache_read=${u.cache_read_input_tokens ?? 0} out=${u.output_tokens} hit=${(hit * 100).toFixed(0)}% ${Date.now() - started}ms`,
      )
    }
  }

  const guardStop = (res: Anthropic.Message) => {
    if (res.stop_reason === 'refusal') throw new LlmRefusalError((res as { stop_details?: unknown }).stop_details ?? null)
  }

  // ── 无工具：messages.parse ──
  if (!o.tools) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const params = {
        model: MODEL,
        max_tokens: o.maxTokens ?? MAX_TOKENS,
        system: o.system,
        messages,
        output_config: { effort: o.effort, format },
      }
      const hash = requestHash(o.system, messages, null)
      const started = Date.now()
      let res
      try {
        res = await transport.parse(params)
      } catch (err) {
        // SDK 的结构化输出解析失败抛 AnthropicError（不是 APIError）；网络 / HTTP 错误原样抛给 job 层
        if (err instanceof Anthropic.AnthropicError && !(err instanceof Anthropic.APIError) && attempt === 0) {
          record(null, started, hash, String(err))
          log(`[llm] ${o.purpose} parse failed, retrying once: ${(err as Error).message.slice(0, 200)}`)
          continue
        }
        throw err
      }
      record(res, started, hash)
      guardStop(res)
      if (res.parsed_output != null) return { output: res.parsed_output, usage, messages, toolCalls }
      if (attempt === 0) log(`[llm] ${o.purpose} empty parsed_output (stop=${res.stop_reason}), retrying once`)
    }
    throw new LlmOutputError(`${o.purpose}: 结构化输出解析失败`)
  }

  // ── 有工具：create 手动循环 ──
  const maxRounds = o.tools.maxRounds ?? 12
  let rounds = 0
  let nudged = false
  for (let guard = 0; guard < maxRounds + 6; guard++) {
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: MODEL,
      max_tokens: o.maxTokens ?? MAX_TOKENS,
      system: o.system,
      messages,
      tools,
      output_config: { effort: o.effort, format: { type: 'json_schema', schema: format.schema } },
    }
    const hash = requestHash(o.system, messages, tools)
    const started = Date.now()
    const res = await transport.create(params)
    record(res, started, hash)
    guardStop(res)

    if (res.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: res.content })
      continue
    }
    if (res.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: res.content })
      rounds++
      const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      const results = await Promise.all(
        uses.map(async (u): Promise<Anthropic.ToolResultBlockParam> => {
          if (rounds > maxRounds) {
            toolCalls.push({ name: u.name, input: u.input, error: 'budget' })
            return { type: 'tool_result', tool_use_id: u.id, content: TOOL_BUDGET_EXHAUSTED, is_error: true }
          }
          try {
            const out = await o.tools!.execute(u.name, u.input)
            toolCalls.push({ name: u.name, input: u.input })
            return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out) }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            toolCalls.push({ name: u.name, input: u.input, error: msg })
            return { type: 'tool_result', tool_use_id: u.id, content: `Error: ${msg}`, is_error: true }
          }
        }),
      )
      // 所有 tool_result 放在同一条 user 消息里（保持并行工具调用）
      messages.push({ role: 'user', content: results })
      continue
    }

    // end_turn / max_tokens / stop_sequence
    const text = textOf(res)
    let parsed: z.ZodSafeParseResult<T> | undefined
    try {
      parsed = o.schema.safeParse(extractJson(text))
    } catch {
      parsed = undefined
    }
    if (parsed?.success) {
      messages.push({ role: 'assistant', content: res.content })
      return { output: parsed.data, usage, messages, toolCalls }
    }
    if (nudged) {
      const why = parsed ? parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') : 'not JSON'
      throw new LlmOutputError(`${o.purpose}: 最终输出不符合 schema（${why}）`)
    }
    nudged = true
    log(`[llm] ${o.purpose} final output did not parse (stop=${res.stop_reason}); nudging once`)
    messages.push({ role: 'assistant', content: res.content })
    messages.push({ role: 'user', content: FINAL_NUDGE })
  }
  throw new LlmOutputError(`${o.purpose}: 工具循环未收敛`)
}

export { cacheHitRate }
