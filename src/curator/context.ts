/**
 * 上下文装配与缓存布局（7.2）。渲染顺序 tools → system → messages；system 三块都带 1h 断点：
 *   [0] 策展 system（冻结文本）
 *   [1] "## Viewer memo" + 键排序的 memo JSON + "## Stats" + stats JSON
 *   [2] 完整观影记录 + watchlist（确定性序列化）
 * system 里禁止日期、用户 ID、随机数；这些只出现在最后一条 user 消息。
 *
 * Call A（构思）与 Call B（审查）共用同一段缓存前缀：工具定义排在最前面，所以 Call B 也带同样的工具定义
 * （tool_choice none），并用同一个 effort（effort 是否进入前缀因模型而异，统一最稳）。
 * 这样一次生成只写一遍前缀（约十几万 token），审查直接读。
 */
import type Anthropic from '@anthropic-ai/sdk'
import { latestProfileWithMemo, latestTasteProfile } from '@/db/repo/taste'
import { getUser } from '@/db/repo/users'
import type { TasteProfile, User } from '@/db/schema'
import { stableStringify } from '@/lib/json'
import { cachedText } from '@/llm/client'
import { currentWatchState, type WatchState } from '@/taste/profile'
import type { TasteStatsT } from '@/taste/types'
import { prompt } from './prompts'
import type { TasteMemoT } from './schemas'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/** 构思与审查共用的 effort（见上：不一致可能让审查读不到构思写下的缓存）。默认 high；`CURATION_EFFORT` 只用于对比测试。 */
export function curationEffort(): (typeof EFFORTS)[number] {
  const e = process.env.CURATION_EFFORT
  return e && (EFFORTS as readonly string[]).includes(e) ? (e as (typeof EFFORTS)[number]) : 'high'
}

export type CuratorContext = {
  user: User
  profile: TasteProfile
  memo: TasteMemoT | null
  stats: TasteStatsT
  state: WatchState
  seen: Set<number>
  watchlist: Set<number>
  system: Anthropic.TextBlockParam[]
}

export class NoProfileError extends Error {
  constructor() {
    super('还没有品味画像：请先导入观影记录并生成画像')
  }
}

export function memoBlock(memo: TasteMemoT | null, stats: TasteStatsT): string {
  const m = memo ? stableStringify(memo) : '(no memo yet — rely on the statistics and the log)'
  return `## Viewer memo\n${m}\n## Stats\n${stableStringify(stats)}`
}

export function assembleContext(userId: string): CuratorContext {
  const user = getUser(userId)
  if (!user) throw new Error('用户不存在')
  const profile = latestProfileWithMemo(userId) ?? latestTasteProfile(userId)
  if (!profile) throw new NoProfileError()
  const state = currentWatchState(userId)
  const seen = new Set(state.films.map((f) => f.tmdbId).filter((x): x is number => x != null))
  const watchlist = new Set(state.watchlist.map((f) => f.tmdbId).filter((x): x is number => x != null))
  const system = [cachedText(prompt('curator.system')), cachedText(memoBlock(profile.memo, profile.stats)), cachedText(state.log.text)]
  return { user, profile, memo: profile.memo, stats: profile.stats, state, seen, watchlist, system }
}

/** 粗估 token 数（CLI 打印用；约 4 字符 / token，中文按 1.5 字符 / token）。 */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[㐀-鿿]/g) ?? []).length
  return Math.round((text.length - cjk) / 4 + cjk / 1.5)
}
