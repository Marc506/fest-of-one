/**
 * 画像构建与重建判断（6.2）。
 * 重建时机：watch_log_hash 变化且（新增 ≥ 20 条 或 距上次 ≥ 30 天），或用户点「重建画像」。
 * 偏离：记录完全没变时，30 天到期也不重建（白花钱）；策展时总是用最新的完整观影记录（P3），只有备忘可能稍旧。
 */
import { latestTasteProfile, insertTasteProfile } from '@/db/repo/taste'
import { getUser } from '@/db/repo/users'
import type { TasteProfile } from '@/db/schema'
import { recencyOf } from '@/db/types'
import { llmConfigured, MODEL } from '@/llm/client'
import { generateTasteMemo, renderMemoMd } from './memo'
import { serializeWatchLog, type SerializedLog } from './serialize'
import type { RecencyLevelT } from './recency'
import { computeTasteStats } from './stats'
import { loadViewerFilms, loadWatchlist, type ViewerFilm, type WatchlistFilm } from './viewer'

export const REBUILD_MIN_NEW = 20
export const REBUILD_MAX_AGE_DAYS = 30

/** films 只含电影；剧集等非电影条目在 nonFilm 里，单独序列化（不进统计）。 */
export type WatchState = { films: ViewerFilm[]; nonFilm: ViewerFilm[]; watchlist: WatchlistFilm[]; log: SerializedLog; recency: RecencyLevelT }

export function currentWatchState(userId: string): WatchState {
  const all = loadViewerFilms(userId)
  const films = all.filter((f) => !f.nonFilm)
  const nonFilm = all.filter((f) => f.nonFilm)
  const watchlist = loadWatchlist(userId)
  const recency = recencyOf(getUser(userId)?.prefs)
  return { films, nonFilm, watchlist, recency, log: serializeWatchLog(films, watchlist, { recency, nonFilm }) }
}

export function needsRebuild(
  profile: Pick<TasteProfile, 'watchLogHash' | 'watchLogCount' | 'createdAt' | 'memo' | 'stats'> | undefined,
  state: Pick<WatchState, 'log' | 'films' | 'recency'>,
  now = new Date(),
): { needed: boolean; reason: string } {
  if (!state.films.length) return { needed: false, reason: '没有观影记录' }
  if (!profile) return { needed: true, reason: '还没有画像' }
  if (profile.watchLogHash === state.log.hash) return { needed: false, reason: '观影记录没有变化' }
  // 旧画像没有 recency 字段 = 当时未加权
  if ((profile.stats.recency?.level ?? 'off') !== state.recency) return { needed: true, reason: '近期权重设置变了' }
  const added = Math.abs(state.films.length - profile.watchLogCount)
  if (added >= REBUILD_MIN_NEW) return { needed: true, reason: `新增 ${added} 部` }
  const ageDays = (now.getTime() - new Date(profile.createdAt).getTime()) / 86400_000
  if (ageDays >= REBUILD_MAX_AGE_DAYS) return { needed: true, reason: `距上次 ${Math.floor(ageDays)} 天` }
  return { needed: false, reason: `只新增 ${added} 部、距上次 ${Math.floor(ageDays)} 天` }
}

export async function buildTasteProfile(
  userId: string,
  opts: { jobId?: string | null; progress?: (pct: number, msg?: string) => void; now?: Date; log?: (l: string) => void } = {},
): Promise<{ profile: TasteProfile; memoSkipped: string | null }> {
  const user = getUser(userId)
  if (!user) throw new Error('用户不存在')
  opts.progress?.(5, '整理观影记录…')
  const state = currentWatchState(userId)
  const stats = computeTasteStats(state.films, opts.now, { recency: state.recency })
  let memoSkipped: string | null = null
  let memo = null
  let usage = null
  if (!llmConfigured()) {
    memoSkipped = '未配置 ANTHROPIC_API_KEY，只生成了统计层'
  } else {
    opts.progress?.(15, `策展人正在读你的 ${state.films.length} 部观影记录…`)
    const r = await generateTasteMemo({ userId, jobId: opts.jobId, stats, log: state.log, locale: user.locale, log_: opts.log })
    memo = r.memo
    usage = r.usage
  }
  const profile = insertTasteProfile({
    userId,
    watchLogHash: state.log.hash,
    watchLogCount: state.films.length,
    stats,
    memo,
    memoMd: memo ? renderMemoMd(memo) : null,
    model: memo ? MODEL : null,
    inputTokens: usage ? usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens : null,
    outputTokens: usage?.output_tokens ?? null,
  })
  opts.progress?.(100, memoSkipped ?? '画像已更新')
  return { profile, memoSkipped }
}

export function rebuildDecision(userId: string) {
  return needsRebuild(latestTasteProfile(userId), currentWatchState(userId))
}
