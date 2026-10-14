import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { getDb } from '@/db/client'
import { llmCalls } from '@/db/schema'
import { setTransport } from '@/llm/client'
import { callStructured, LlmOutputError, LlmRefusalError } from '@/llm/call'
import { message, ScriptedTransport, toolUse } from '../fake-llm'

const Out = z.strictObject({ answer: z.number() })
const base = {
  purpose: 'other' as const,
  promptVersion: 'test',
  system: [{ type: 'text' as const, text: 'sys' }],
  messages: [{ role: 'user' as const, content: 'q' }],
  schema: Out,
  effort: 'high' as const,
  log: () => {},
}

describe('callStructured', () => {
  it('runs a tool loop, returning all tool results in one user message', async () => {
    const executed: string[] = []
    const t = new ScriptedTransport((p, i) => {
      if (i === 0) return message([toolUse('a', 'add', { x: 1 }), toolUse('b', 'add', { x: 2 })])
      const last = p.messages.at(-1)!
      expect(Array.isArray(last.content) && last.content.length).toBe(2)
      return message('{"answer": 3}')
    })
    setTransport(t)
    const r = await callStructured({
      ...base,
      tools: {
        defs: [{ name: 'add', description: 'add', strict: true, input_schema: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'], additionalProperties: false } }],
        execute: async (name, input) => {
          executed.push(name)
          return { ok: (input as { x: number }).x }
        },
      },
    })
    expect(r.output).toEqual({ answer: 3 })
    expect(executed).toEqual(['add', 'add'])
    expect(t.requests[0]!.output_config).toMatchObject({ effort: 'high', format: { type: 'json_schema' } })
    expect(t.requests[0]!.tool_choice).toBeUndefined()
    expect(r.usage.calls).toBe(2)
    expect(getDb().select().from(llmCalls).all()).toHaveLength(2)
    setTransport(undefined)
  })

  it('nudges once with "Emit the final JSON now." then fails', async () => {
    let n = 0
    setTransport(new ScriptedTransport(() => (n++ === 0 ? message('not json') : message('{"answer": 1}'))))
    const tools = { defs: [], execute: async () => null }
    expect((await callStructured({ ...base, tools })).output).toEqual({ answer: 1 })

    const t = new ScriptedTransport(() => message('still not json'))
    setTransport(t)
    await expect(callStructured({ ...base, tools })).rejects.toBeInstanceOf(LlmOutputError)
    expect(JSON.stringify(t.requests[1]!.messages.at(-1))).toContain('Emit the final JSON now.')
    setTransport(undefined)
  })

  it('answers tool calls past the budget with is_error', async () => {
    const t = new ScriptedTransport((_p, i) => (i < 3 ? message([toolUse(`t${i}`, 'add', { x: i })]) : message('{"answer": 9}')))
    setTransport(t)
    const r = await callStructured({ ...base, tools: { defs: [], execute: async () => 1, maxRounds: 2 } })
    expect(r.output.answer).toBe(9)
    expect(r.toolCalls.map((c) => c.error ?? 'ok')).toEqual(['ok', 'ok', 'budget'])
    setTransport(undefined)
  })

  it('throws on refusal and uses parse() without tools', async () => {
    setTransport(new ScriptedTransport(() => message([], { stop_reason: 'refusal' })))
    await expect(callStructured(base)).rejects.toBeInstanceOf(LlmRefusalError)
    setTransport(new ScriptedTransport(() => message('{"answer": 42}')))
    expect((await callStructured(base)).output.answer).toBe(42)
    setTransport(undefined)
  })
})
