/** 成本计算（7.11）。价格单位：美元 / 百万 token。 */
import type Anthropic from '@anthropic-ai/sdk'

type Price = { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }

const PRICES: Record<string, Price> = {
  // Opus 5.5：输入 $4 / 输出 $20 / 缓存读 $0.20；缓存写 5m = 1.25×，1h = 2× 输入价
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
}

export type UsageLike = Pick<Anthropic.Usage, 'input_tokens' | 'output_tokens'> & {
  cache_creation_input_tokens?: number | null
  cache_read_input_tokens?: number | null
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number } | null
}

export function costUsd(model: string, u: UsageLike): number {
  const p = PRICES[model] ?? PRICES['claude-opus-5-5']!
  const write = u.cache_creation_input_tokens ?? 0
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? (u.cache_creation ? 0 : write)
  const w5m = u.cache_creation?.ephemeral_5m_input_tokens ?? write - w1h
  const usd =
    u.input_tokens * p.input +
    u.output_tokens * p.output +
    (u.cache_read_input_tokens ?? 0) * p.cacheRead +
    w5m * p.cacheWrite5m +
    w1h * p.cacheWrite1h
  return Math.round((usd / 1e6) * 1e6) / 1e6
}

export type UsageTotals = {
  calls: number
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  cost_usd: number
}

export function emptyTotals(): UsageTotals {
  return { calls: 0, input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cost_usd: 0 }
}

export function addUsage(t: UsageTotals, model: string, u: UsageLike): UsageTotals {
  t.calls++
  t.input_tokens += u.input_tokens
  t.output_tokens += u.output_tokens
  t.cache_creation_input_tokens += u.cache_creation_input_tokens ?? 0
  t.cache_read_input_tokens += u.cache_read_input_tokens ?? 0
  t.cost_usd = Math.round((t.cost_usd + costUsd(model, u)) * 1e6) / 1e6
  return t
}

export function mergeTotals(a: UsageTotals, b: UsageTotals): UsageTotals {
  return {
    calls: a.calls + b.calls,
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
    cost_usd: Math.round((a.cost_usd + b.cost_usd) * 1e6) / 1e6,
  }
}

/** 缓存命中率 = 缓存读 / (缓存读 + 缓存写 + 未缓存输入)。 */
export function cacheHitRate(t: Pick<UsageTotals, 'input_tokens' | 'cache_creation_input_tokens' | 'cache_read_input_tokens'>): number {
  const total = t.input_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens
  return total ? t.cache_read_input_tokens / total : 0
}
