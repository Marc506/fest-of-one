/**
 * 近期权重：越早看的片，越不代表现在的口味——但不会衰减到 0，强烈表态过的老片保留大部分权重。
 *
 *   base(age) = floor + (1 − floor) · 0.5^(age / half_life)          age = 距「最近一次观看」的年数（按月计）
 *   weight    = base + (1 − base) · KEEP · strength                  strength：喜欢 / ≥9 / ≤4 → 1，8 → 0.5，其余 0
 *
 * 锚点是整份记录里最晚的观看日期，而不是今天：同一份记录永远算出同样的权重（缓存前缀稳定，见 6.3），
 * 而且隔一段时间没记录也不会让所有片一起「变老」。重看会刷新 last watched，自然把权重拉回去。
 * 没有日期的条目按最老处理（只剩 floor + 表态加成）。
 */

/** 不依赖 zod：设置页（客户端组件）也会引用这里的常量。zod 枚举在 db/types.ts。 */
export const RECENCY_LEVELS = ['off', 'light', 'moderate', 'strong'] as const
export type RecencyLevelT = (typeof RECENCY_LEVELS)[number]
export const DEFAULT_RECENCY: RecencyLevelT = 'moderate'

export type RecencyPreset = { half_life_years: number; floor: number }

export const RECENCY_PRESETS: Record<RecencyLevelT, RecencyPreset | null> = {
  off: null,
  light: { half_life_years: 8, floor: 0.6 },
  moderate: { half_life_years: 4, floor: 0.4 },
  strong: { half_life_years: 2, floor: 0.25 },
}

export const RECENCY_LABELS: Record<RecencyLevelT, string> = {
  off: '关闭（所有记录同等权重）',
  light: '轻微（半衰期 8 年，最低 0.6）',
  moderate: '适中（半衰期 4 年，最低 0.4）',
  strong: '较强（半衰期 2 年，最低 0.25）',
}

/** 强烈表态（喜欢 / ≥9 / ≤4）的老片能找回的「失去的权重」比例。 */
export const STRONG_OPINION_KEEP = 0.6

export type Weighable = { lastWatched: string | null; rating10: number | null; liked: boolean }

/** 记录里最晚的观看日期（YYYY-MM-DD），没有日期时为 null。 */
export function recencyAnchor(films: readonly { lastWatched: string | null }[]): string | null {
  let a = ''
  for (const f of films) if (f.lastWatched && f.lastWatched > a) a = f.lastWatched
  return a || null
}

const monthIndex = (d: string) => Number(d.slice(0, 4)) * 12 + Number(d.slice(5, 7)) - 1

export function opinionStrength(f: Pick<Weighable, 'rating10' | 'liked'>): number {
  if (f.liked) return 1
  if (f.rating10 == null) return 0
  if (f.rating10 >= 9 || f.rating10 <= 4) return 1
  if (f.rating10 === 8) return 0.5
  return 0
}

/** 0–1，保留两位小数；level = off 时恒为 1。 */
export function recencyWeight(f: Weighable, anchor: string | null, level: RecencyLevelT): number {
  const p = RECENCY_PRESETS[level]
  if (!p) return 1
  const ageYears = f.lastWatched && anchor ? Math.max(0, monthIndex(anchor) - monthIndex(f.lastWatched)) / 12 : Infinity
  const base = p.floor + (1 - p.floor) * 0.5 ** (ageYears / p.half_life_years)
  const w = base + (1 - base) * STRONG_OPINION_KEEP * opinionStrength(f)
  return Math.round(Math.min(1, w) * 100) / 100
}

/** 给 prompt 的一句话说明（英文，进缓存前缀；不含日期）。 */
export function describeRecency(level: RecencyLevelT): string | null {
  const p = RECENCY_PRESETS[level]
  if (!p) return null
  return (
    `weight (0–1) = how much the entry speaks for the viewer's taste NOW. It decays with time since last watched, ` +
    `measured from the latest entry in this log (half-life ${p.half_life_years} years, never below ${p.floor}); ` +
    `strongly felt films (liked, rated ≥9 or ≤4) keep most of their weight, and a rewatch refreshes it.`
  )
}
