import { z } from 'zod'
import { getSource, markSourceSynced } from '@/db/repo/sources'
import { createRateLimitedFetch } from '@/lib/http'
import { adapterFor } from '@/sources'
import { collect, writeEntries } from '@/sources/sync'
import { enqueueJob } from '../queue'
import { defineHandler, UserFacingError } from '../types'

export const syncSourceHandler = defineHandler({
  payload: z.object({
    source_id: z.string(),
    upload_path: z.string().optional(),
    /** 全量（会清理来源侧已删除的条目）；增量为 false */
    full: z.boolean().default(true),
  }),
  async run({ payload, userId, progress, log }) {
    const account = getSource(payload.source_id)
    if (!account || account.userId !== userId) throw new UserFacingError('来源不存在')
    const adapter = adapterFor(account)
    const ctx = {
      account,
      http: createRateLimitedFetch({ concurrency: 1 }),
      log,
      onProgress: progress,
      uploadPath: payload.upload_path,
    }
    try {
      const incremental = !payload.full && adapter.fetchIncremental
      const entries = await collect(incremental ? adapter.fetchIncremental!(ctx, account.cursor) : adapter.fetchAll(ctx))
      progress(40, `写入 ${entries.length} 条记录…`)
      const stats = writeEntries(account.userId, account, entries, {
        prune: Boolean(payload.full && account.syncMode === 'upload'),
        dedupeViewings: account.syncMode === 'rss',
        onProgress: (d, t) => progress(40 + (d / Math.max(1, t)) * 55, `写入 ${d}/${t}`),
      })
      markSourceSynced(account.id, { cursor: adapter.nextCursor ?? account.cursor ?? null })
      const enrich = enqueueJob('enrich_films', {}, account.userId)
      progress(100, `同步完成：看过 ${stats.watched} 条，想看 ${stats.watchlist} 条`)
      return { ...stats, enrich_job_id: enrich.id }
    } catch (err) {
      markSourceSynced(account.id, { error: err instanceof Error ? err.message : String(err) })
      throw err
    }
  },
})
