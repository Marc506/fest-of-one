/**
 * Claude API 客户端（7.11）。全流程单一模型 `claude-opus-5-5`；不传 `thinking`（默认 adaptive）；
 * 深度用 `output_config.effort`；工具 `strict: true`、`tool_choice` 保持 auto；不用 assistant prefill。
 *
 * 通过 `LlmTransport` 抽象，测试与 `pnpm curate --replay/--mock` 可以离线运行。
 */
import Anthropic from '@anthropic-ai/sdk'
import type { AutoParseableOutputFormat } from '@anthropic-ai/sdk/lib/parser'
import { MockCuratorTransport } from './mock-curator'
import { ReplayTransport } from './replay'

export const MODEL = 'claude-opus-5-5'
export const MAX_TOKENS = 16000

export type CreateParams = Anthropic.MessageCreateParamsNonStreaming
export type ParseParams<T> = Omit<CreateParams, 'output_config'> & {
  output_config: { effort?: Anthropic.OutputConfig['effort']; format: AutoParseableOutputFormat<T> }
}
export type ParsedResult<T> = Anthropic.Message & { parsed_output: T | null }

export interface LlmTransport {
  readonly name: string
  /** 原始请求（Call A 的工具循环用；结构化输出在调用方用 zod 校验）。 */
  create(params: CreateParams): Promise<Anthropic.Message>
  /** `client.messages.parse` —— 无工具的结构化调用（画像备忘、审查）。 */
  parse<T>(params: ParseParams<T>): Promise<ParsedResult<T>>
}

const FALLBACK_BETA = 'server-side-fallback-2026-07-01'

export class AnthropicTransport implements LlmTransport {
  readonly name = 'anthropic'
  private readonly client: Anthropic

  constructor(
    client?: Anthropic,
    private readonly fallbacks = process.env.LLM_ENABLE_FALLBACKS === '1',
  ) {
    // SDK 自带 2 次重试；job 层再给 1 次（见 worker）
    this.client = client ?? new Anthropic({ maxRetries: 2 })
  }

  async create(params: CreateParams): Promise<Anthropic.Message> {
    if (this.fallbacks) {
      const res = await this.client.beta.messages.create({
        ...(params as Anthropic.Beta.MessageCreateParamsNonStreaming),
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
      })
      return res as unknown as Anthropic.Message
    }
    return this.client.messages.create(params)
  }

  async parse<T>(params: ParseParams<T>): Promise<ParsedResult<T>> {
    if (this.fallbacks) {
      const res = await this.client.beta.messages.parse({
        ...(params as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming),
        betas: [FALLBACK_BETA],
        fallbacks: 'default',
      } as never)
      return res as unknown as ParsedResult<T>
    }
    return (await this.client.messages.parse(params as never)) as unknown as ParsedResult<T>
  }
}

let transport: LlmTransport | undefined

/**
 * 默认真实 API。开发 / 演示可设 `LLM_TRANSPORT=mock`（离线桩）或 `replay`（录制回放）；生产不要设。
 */
export function getTransport(): LlmTransport {
  if (!transport) {
    const kind = process.env.LLM_TRANSPORT
    if (kind === 'mock') transport = new MockCuratorTransport()
    else if (kind === 'replay') transport = new ReplayTransport()
    else transport = new AnthropicTransport()
  }
  return transport!
}

export function setTransport(t: LlmTransport | undefined): void {
  transport = t
}

/** 是否可以调用 LLM：显式注入了 transport（测试 / 回放），或配置了 API 凭据。 */
export function llmConfigured(): boolean {
  return (
    Boolean(transport) ||
    process.env.LLM_TRANSPORT === 'mock' ||
    process.env.LLM_TRANSPORT === 'replay' ||
    Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN)
  )
}

/** 1 小时缓存断点（7.2）。 */
export const CACHE_1H = { type: 'ephemeral', ttl: '1h' } as const

export function cachedText(text: string): Anthropic.TextBlockParam {
  return { type: 'text', text, cache_control: CACHE_1H }
}
