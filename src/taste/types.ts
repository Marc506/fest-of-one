/** 品味画像统计层 TasteStats（ARCHITECTURE.md 6.1），纯代码生成。 */
export type RatedBucket = { n: number; avg10: number | null }

export type TasteStatsT = {
  counts: { films: number; rated: number; liked: number; rewatched: number; last90d: number }
  rating_dist: Record<string, number>
  directors: { name: string; n: number; avg10: number | null; liked: number; evidence: number[] }[]
  countries: ({ code: string } & RatedBucket)[]
  decades: ({ decade: number } & RatedBucket)[]
  genres: ({ name: string } & RatedBucket)[]
  languages: { code: string; n: number }[]
  actors: ({ name: string } & RatedBucket)[]
  keywords: { kw: string; n: number }[]
  loved: number[]
  disliked: number[]
  register: {
    share_high_popularity: number
    avg10_high_popularity: number | null
    share_festival_core: number
  }
  pace_per_week: number
  runtime_tolerance_p90: number | null
}
