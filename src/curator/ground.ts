/**
 * 落地校验（7.4，代码）：
 * 1. tmdb_id 不在 films → 调 TMDB 详情；仍不存在 → 剔除
 * 2. 导演核对：候选的 director 与 TMDB directors 相似度 < 0.7 → 剔除（幻觉信号）
 * 3. 已看 → 剔除（硬规则）
 * 4. avoid.tmdb_ids / 不感兴趣 / 近 12 周排过 → 剔除
 * 5. 缺片长 → 富化；仍缺 → 剔除
 * 6. 片长 > 能放下的最长片 → 标记 infeasible（不剔除，交给审查）
 * 7. 剩余 < N → insufficient，不进入审查
 */
import type { Film } from '@/db/schema'
import { mapLimit } from '@/lib/http'
import { ensureFilm } from '@/resolver/enrich'
import { nameSim } from '@/resolver/normalize'
import type { TmdbClient } from '@/resolver/tmdb'
import type { IdeateCandidateT, IdeateConceptT } from './schemas'

export const DIRECTOR_SIM_MIN = 0.7

export type GroundedCandidate = IdeateCandidateT & { film: Film; infeasible: boolean }
export type DropReason = 'not_on_tmdb' | 'director_mismatch' | 'seen' | 'avoided' | 'no_runtime' | 'duplicate' | 'bad_id'
export type GroundedConcept = {
  index: number
  concept: IdeateConceptT
  candidates: GroundedCandidate[]
  dropped: { tmdb_id: number; title: string; reason: DropReason }[]
  insufficient: boolean
}

export function directorMatches(claimed: string, film: Film): boolean {
  if (!film.directors.length) return true // TMDB 没有导演信息时不据此判幻觉
  const names = claimed.split(/\s*(?:&|,|\/|\band\b|、|和)\s*/i).filter(Boolean)
  return names.some((n) => film.directors.some((d) => nameSim(n, d.name) >= DIRECTOR_SIM_MIN))
}

export async function groundConcepts(
  concepts: IdeateConceptT[],
  opts: {
    client: TmdbClient
    seen: Set<number>
    avoidIds: Set<number>
    maxRuntime: number
    n: number
    /** single 模式至少需要的候选数（1） */
    minCandidates?: number
  },
): Promise<GroundedConcept[]> {
  const ids = [...new Set(concepts.flatMap((c) => c.candidates.map((x) => x.tmdb_id)).filter((id) => Number.isInteger(id) && id > 0))]
  const filmsById = new Map<number, Film>()
  await mapLimit(ids, 4, async (id) => {
    try {
      const f = await ensureFilm(opts.client, id)
      if (f) filmsById.set(id, f)
    } catch {
      // 网络错误按「不存在」处理：宁可少一部，不放幻觉片
    }
  })
  const need = opts.minCandidates ?? opts.n
  return concepts.map((concept, index) => {
    const candidates: GroundedCandidate[] = []
    const dropped: GroundedConcept['dropped'] = []
    const taken = new Set<number>()
    for (const c of concept.candidates) {
      const drop = (reason: DropReason) => dropped.push({ tmdb_id: c.tmdb_id, title: c.title, reason })
      if (!Number.isInteger(c.tmdb_id) || c.tmdb_id <= 0) {
        drop('bad_id')
        continue
      }
      if (taken.has(c.tmdb_id)) {
        drop('duplicate')
        continue
      }
      const film = filmsById.get(c.tmdb_id)
      if (!film) {
        drop('not_on_tmdb')
        continue
      }
      if (!directorMatches(c.director, film)) {
        drop('director_mismatch')
        continue
      }
      if (opts.seen.has(c.tmdb_id)) {
        drop('seen')
        continue
      }
      if (opts.avoidIds.has(c.tmdb_id)) {
        drop('avoided')
        continue
      }
      if (!film.runtimeMin) {
        drop('no_runtime')
        continue
      }
      taken.add(c.tmdb_id)
      candidates.push({ ...c, film, infeasible: film.runtimeMin > opts.maxRuntime })
    }
    const feasible = candidates.filter((c) => !c.infeasible).length
    return { index, concept, candidates, dropped, insufficient: feasible < need }
  })
}

export function dropRate(grounded: GroundedConcept[]): number {
  const total = grounded.reduce((a, g) => a + g.candidates.length + g.dropped.length, 0)
  const bad = grounded.reduce((a, g) => a + g.dropped.filter((d) => d.reason === 'not_on_tmdb' || d.reason === 'director_mismatch' || d.reason === 'bad_id').length, 0)
  return total ? bad / total : 0
}
