/** 品味画像统计层 TasteStats（ARCHITECTURE.md 6.1），纯代码生成。 */
import type { RecencyLevelT } from './recency'

/** w：按近期权重折算后的有效部数（旧画像没有这一项）。 */
export type RatedBucket = { n: number; w?: number; avg10: number | null }

export type TasteStatsT = {
  counts: { films: number; rated: number; liked: number; rewatched: number; last90d: number }
  rating_dist: Record<string, number>
  directors: { name: string; n: number; w?: number; avg10: number | null; liked: number; evidence: number[] }[]
  countries: ({ code: string } & RatedBucket)[]
  decades: ({ decade: number } & RatedBucket)[]
  genres: ({ name: string } & RatedBucket)[]
  languages: { code: string; n: number; w?: number }[]
  actors: ({ name: string } & RatedBucket)[]
  keywords: { kw: string; n: number; w?: number }[]
  loved: number[]
  disliked: number[]
  register: {
    share_high_popularity: number
    avg10_high_popularity: number | null
    share_festival_core: number
  }
  pace_per_week: number
  runtime_tolerance_p90: number | null
  /** 统计时用的近期权重（旧画像没有这一项） */
  recency?: { level: RecencyLevelT; half_life_years: number | null; floor: number | null }
}
