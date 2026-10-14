/** 测试用 LLM transport：按脚本返回 Message；parse 模拟 SDK 行为（对 text 块跑 format.parse）。 */
import type Anthropic from '@anthropic-ai/sdk'
import type { CreateParams, LlmTransport, ParseParams, ParsedResult } from '@/llm/client'

export type Handler = (params: CreateParams, i: number) => Anthropic.Message | Promise<Anthropic.Message>

export function message(
  content: Anthropic.ContentBlock[] | string,
  opts: { stop_reason?: Anthropic.Message['stop_reason']; usage?: Partial<Anthropic.Usage> } = {},
): Anthropic.Message {
  const blocks: Anthropic.ContentBlock[] =
    typeof content === 'string' ? [{ type: 'text', text: content, citations: null } as Anthropic.TextBlock] : content
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: blocks,
    stop_reason: opts.stop_reason ?? (blocks.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      ...opts.usage,
    } as Anthropic.Usage,
  } as Anthropic.Message
}

export function toolUse(id: string, name: string, input: unknown): Anthropic.ToolUseBlock {
  return { type: 'tool_use', id, name, input } as Anthropic.ToolUseBlock
}

export class ScriptedTransport implements LlmTransport {
  readonly name = 'scripted'
  readonly requests: CreateParams[] = []
  constructor(private readonly handler: Handler) {}

  async create(params: CreateParams) {
    this.requests.push(JSON.parse(JSON.stringify(params)))
    return this.handler(params, this.requests.length - 1)
  }

  async parse<T>(params: ParseParams<T>): Promise<ParsedResult<T>> {
    const res = await this.create(params as unknown as CreateParams)
    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text
    const parsed = text != null ? params.output_config.format.parse(text) : null
    return { ...res, parsed_output: parsed }
  }
}
