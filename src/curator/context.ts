/**
 * 上下文装配与缓存布局（7.2）。渲染顺序 tools → system → messages；system 三块都带 1h 断点：
 *   [0] 策展 system（冻结文本）
 *   [1] "## Viewer memo" + 键排序的 memo JSON + "## Stats" + stats JSON
 *   [2] 完整观影记录 + watchlist（确定性序列化）
 * system 里禁止日期、用户 ID、随机数；这些只出现在最后一条 user 消息。
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
