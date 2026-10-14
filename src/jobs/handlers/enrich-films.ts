import { z } from 'zod'
import { filmsNeedingEnrichment, matchRate, matchStats, pendingAliasesForUser, requeueUnresolvedAliases, watchedYearMaxByAlias } from '@/db/repo/library'
import { enrichMany, staleBefore } from '@/resolver/enrich'
import { resolveAlias } from '@/resolver/match'
import { getTmdbClient } from '@/resolver/tmdb'
import { doubanHintsFromWikidata, wikidataEnabled, type DoubanHint } from '@/resolver/wikidata'
import { mapLimit } from '@/lib/http'
import { rebuildDecision } from '@/taste/profile'
import { enqueueUnique } from '../queue'
import { explainError } from '@/lib/net-errors'
import { defineHandler, UserFacingError } from '../types'

/**
 * 解析未匹配条目 + 富化影片（5.4 / 5.5）。
 * `rematch: true`：先把待确认（ambiguous / unmatched）放回 pending，用当前规则再匹配一遍。
 */
export const enrichFilmsHandler = defineHandler({
  payload: z.object({ rematch: z.boolean().default(false) }).passthrough(),
  async run({ userId, payload, progress, log }) {
    if (!userId) throw new UserFacingError('enrich_films 需要 user_id')
    const client = getTmdbClient()

    // 先试一次：TMDB 连不上 / 令牌不对时几秒内就失败并说明原因，而不是逐条重试几个小时
    progress(1, '检查 TMDB 连接…')
    try {
      await client.movieGenres()
    } catch (err) {
      throw new UserFacingError(explainError(err, 'TMDB'))
    }

    const requeued = payload.rematch ? requeueUnresolvedAliases(userId) : 0
    const pending = pendingAliasesForUser(userId)
    const yearMax = watchedYearMaxByAlias(pending.map((a) => a.id))

    // 豆瓣条目先查 Wikidata：有 TMDB / IMDb 编号就不用模糊匹配，还能拿到年份、认出剧集
    let wikidata = new Map<string, DoubanHint>()
    let wikidataNote = ''
    const doubanIds = pending.filter((a) => a.provider === 'douban' && !a.tmdbId && !a.imdbIdRaw).map((a) => a.externalId)
    if (doubanIds.length && wikidataEnabled()) {
      progress(2, `查询 Wikidata：${doubanIds.length} 个豆瓣条目…`)
      const r = await doubanHintsFromWikidata(doubanIds, { log: (l) => log(l) })
      wikidata = r.hints
      log(`wikidata: ${r.hints.size}/${doubanIds.length} douban ids known${r.error ? ` (stopped: ${r.error})` : ''}`)
      wikidataNote = r.error && !r.hints.size ? '；Wikidata 连不上，已跳过' : `；Wikidata 认得其中 ${r.hints.size}/${doubanIds.length} 个豆瓣条目`
    }

    let done = 0
    let errors = 0
    let firstError: unknown
    const outcome = { matched: 0, ambiguous: 0, unmatched: 0, not_film: 0 }
    progress(5, `匹配 TMDB：0/${pending.length}`)
    const abort = new AbortController()
    await mapLimit(pending, 4, async (alias) => {
      if (abort.signal.aborted) return
      try {
        const r = await resolveAlias(alias, client, {
          watchedYearMax: yearMax.get(alias.id),
          wikidata: alias.provider === 'douban' ? wikidata.get(alias.externalId) : undefined,
        })
        if (r.status === 'matched' || r.status === 'confirmed') outcome.matched++
        else if (r.status === 'ambiguous') outcome.ambiguous++
        else if (r.status === 'unmatched') outcome.unmatched++
        else if (r.status === 'not_film') outcome.not_film++
      } catch (err) {
        errors++
        firstError ??= err
        log(`resolve alias ${alias.id} failed:`, explainError(err, 'TMDB'))
        // 开头 20 条全失败 → 不再硬撑
        if (errors >= 20 && errors === done + 1) abort.abort()
      }
      done++
      if (done % 10 === 0 || done === pending.length) progress(5 + (done / pending.length) * 55, `匹配 TMDB：${done}/${pending.length}`)
    })
    if (abort.signal.aborted || (pending.length && errors === pending.length)) {
      throw new UserFacingError(`匹配 TMDB 失败：${explainError(firstError, 'TMDB')}（修好后在「接入观影记录」里点「重新同步」即可，已导入的记录不会重复）`)
    }

    const ids = filmsNeedingEnrichment(userId, staleBefore())
    progress(60, `富化影片：0/${ids.length}`)
    const enriched = await enrichMany(client, ids, (d, t) => {
      if (d % 10 === 0 || d === t) progress(60 + (d / t) * 39, `富化影片：${d}/${t}`)
    })
    const stats = matchStats(userId)
    const rate = matchRate(stats) ?? 1
    // 画像：观影记录变化足够大时自动重建（6.2）
    const decision = rebuildDecision(userId)
    const taste = decision.needed ? enqueueUnique('build_taste', { force: false }, userId).job : null
    const notFilm = outcome.not_film ? `，识别出 ${outcome.not_film} 条剧集等非电影` : ''
    progress(100, `匹配率 ${(rate * 100).toFixed(1)}%${notFilm}，富化 ${enriched.enriched} 部${wikidataNote}`)
    return {
      build_taste_job_id: taste?.id ?? null,
      build_taste_reason: decision.reason,
      rematched: requeued,
      wikidata_hints: wikidata.size,
      resolved: outcome,
      resolve_errors: errors,
      enriched: enriched.enriched,
      missing: enriched.missing,
      match_stats: stats,
      match_rate: rate,
    }
  },
})
