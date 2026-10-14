/** 备忘层 TasteMemo（6.2）：LLM 读完整观影记录 + 统计，写一份「这个人是什么样的观众」。 */
import type Anthropic from '@anthropic-ai/sdk'
import { TasteMemo, type TasteMemoT } from '@/curator/schemas'
import { prompt, PROMPT_VERSION, render } from '@/curator/prompts'
import { stableStringify } from '@/lib/json'
import { cachedText } from '@/llm/client'
import { callStructured } from '@/llm/call'
import type { SerializedLog } from './serialize'
import type { TasteStatsT } from './types'

/** 画像调用的 system：[0] 策展 system（与策展调用共享缓存） [1] 统计 [2] 完整观影记录。 */
export function tasteMemoSystem(stats: TasteStatsT, log: SerializedLog): Anthropic.TextBlockParam[] {
  return [cachedText(prompt('curator.system')), cachedText(`## Stats\n${stableStringify(stats)}`), cachedText(log.text)]
}

export async function generateTasteMemo(input: {
  userId: string
  jobId?: string | null
  stats: TasteStatsT
  log: SerializedLog
  locale: string
  log_?: (l: string) => void
}) {
  const res = await callStructured({
    purpose: 'taste_memo',
    promptVersion: PROMPT_VERSION,
    system: tasteMemoSystem(input.stats, input.log),
    messages: [{ role: 'user', content: render(prompt('taste_memo.user'), { locale: input.locale }) }],
    schema: TasteMemo,
    effort: 'high',
    userId: input.userId,
    jobId: input.jobId,
    log: input.log_,
  })
  return { memo: sanitizeMemo(res.output, input.log), usage: res.usage }
}

/** 代码侧校验：数值夹到 0–1，证据只保留观影记录里真实存在的 tmdb_id。 */
export function sanitizeMemo(memo: TasteMemoT, log: SerializedLog): TasteMemoT {
  const ids = new Set<number>()
  for (const m of log.text.matchAll(/^(?:WATCHLIST: )?(\d+)\|/gm)) {
    if (!m[0].startsWith('WATCHLIST')) ids.add(Number(m[1]))
  }
  const clamp = (n: number) => Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0))
  const real = (xs: number[]) => xs.filter((x) => ids.has(x))
  return {
    ...memo,
    register: {
      ...memo.register,
      art_house: clamp(memo.register.art_house),
      auteur_genre: clamp(memo.register.auteur_genre),
      mainstream_commercial: clamp(memo.register.mainstream_commercial),
    },
    affinities: memo.affinities.map((a) => ({ ...a, strength: clamp(a.strength), evidence: real(a.evidence) })),
    aversions: memo.aversions.map((a) => ({ ...a, strength: clamp(a.strength), evidence: real(a.evidence) })),
    frontiers: memo.frontiers.map((f) => ({ ...f, seed_films: real(f.seed_films) })),
  }
}

export function renderMemoMd(memo: TasteMemoT): string {
  return memo.summary.trim()
}

/**
 * 旧画像（提示词 v6 之前）用「TA」「这位观众」称呼用户；页面面向用户本人，显示时统一改成「你」。
 * 只改显示、不改存档；新画像本来就用「你」。
 */
export function toSecondPerson<T>(value: T): T {
  if (typeof value === 'string') {
    return value
      .replace(/这位观众/g, '你')
      .replace(/(?<![A-Za-z])TA(?![A-Za-z])\s?/g, '你') as T
  }
  if (Array.isArray(value)) return value.map((v) => toSecondPerson(v)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toSecondPerson(v)])) as T
  }
  return value
}

