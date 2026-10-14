/**
 * 回放 transport（13 章）：按 request_hash（system + messages + tools）从 llm_calls 取录制的响应。
 * 同一份数据库 + 同一个 --today + 同样的 TMDB 结果 → 请求字节相同 → 命中录制。
 */
import type Anthropic from '@anthropic-ai/sdk'
import { findLlmResponse } from '@/db/repo/llm'
import { requestHash } from './call'
import type { CreateParams, LlmTransport, ParseParams, ParsedResult } from './client'

export class ReplayMissError extends Error {
  constructor(readonly hash: string) {
    super(`回放未命中：没有 request_hash = ${hash.slice(0, 12)}… 的录制（prompt / 观影记录 / 日期变了？）`)
  }
}

export class ReplayTransport implements LlmTransport {
  readonly name = 'replay'

  async create(params: CreateParams): Promise<Anthropic.Message> {
    const hash = requestHash(params.system, params.messages, params.tools ?? null)
    const res = findLlmResponse(hash)
    if (!res || (res as { error?: unknown }).error) throw new ReplayMissError(hash)
    return res as Anthropic.Message
  }

  async parse<T>(params: ParseParams<T>): Promise<ParsedResult<T>> {
    const res = await this.create(params as unknown as CreateParams)
    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text
    return { ...res, parsed_output: text != null ? params.output_config.format.parse(text) : null }
  }
}
