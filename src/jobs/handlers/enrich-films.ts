import { z } from 'zod'
import { filmsNeedingEnrichment, matchStats, pendingAliasesForUser } from '@/db/repo/library'
import { enrichMany, staleBefore } from '@/resolver/enrich'
import { resolveAlias } from '@/resolver/match'
import { getTmdbClient } from '@/resolver/tmdb'
import { mapLimit } from '@/lib/http'
import { rebuildDecision } from '@/taste/profile'
import { enqueueJob } from '../queue'
import { defineHandler, RetryableError, UserFacingError } from '../types'

/** 解析未匹配条目 + 富化影片（5.4 / 5.5）。 */
export const enrichFilmsHandler = defineHandler({
  payload: z.object({}).passthrough(),
  async run({ userId, progress, log }) {
    if (!userId) throw new UserFacingError('enrich_films 需要 user_id')
    const client = getTmdbClient()

    const pending = pendingAliasesForUser(userId)
    let done = 0
    let errors = 0
    const outcome = { matched: 0, ambiguous: 0, unmatched: 0 }
    progress(1, `匹配 TMDB：0/${pending.length}`)
    await mapLimit(pending, 4, async (alias) => {
      try {
        const r = await resolveAlias(alias, client)
        if (r.status === 'matched' || r.status === 'confirmed') outcome.matched++
        else if (r.status === 'ambiguous') outcome.ambiguous++
        else if (r.status === 'unmatched') outcome.unmatched++
      } catch (err) {
        errors++
        log(`resolve alias ${alias.id} failed:`, err instanceof Error ? err.message : err)
      }
      done++
      if (done % 10 === 0 || done === pending.length) progress(1 + (done / pending.length) * 59, `匹配 TMDB：${done}/${pending.length}`)
    })
    if (pending.length && errors === pending.length) throw new RetryableError('TMDB 全部请求失败，稍后重试')

    const ids = filmsNeedingEnrichment(userId, staleBefore())
    progress(60, `富化影片：0/${ids.length}`)
    const enriched = await enrichMany(client, ids, (d, t) => {
      if (d % 10 === 0 || d === t) progress(60 + (d / t) * 39, `富化影片：${d}/${t}`)
    })
    const stats = matchStats(userId)
    const total = Object.values(stats).reduce((a, b) => a + b, 0)
    const rate = total ? (stats.matched + stats.confirmed) / total : 1
    // 画像：观影记录变化足够大时自动重建（6.2）
    const decision = rebuildDecision(userId)
    const taste = decision.needed ? enqueueJob('build_taste', { force: false }, userId) : null
    progress(100, `匹配率 ${(rate * 100).toFixed(1)}%，富化 ${enriched.enriched} 部`)
    return {
      build_taste_job_id: taste?.id ?? null,
      build_taste_reason: decision.reason, resolved: outcome, resolve_errors: errors, enriched: enriched.enriched, missing: enriched.missing, match_stats: stats, match_rate: rate }
  },
})
