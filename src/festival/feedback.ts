/**
 * 反馈闭环（1.1 第 6 步 / M7）：
 * - watched → 写一条 provider = fest 的 watch_log（这部片从此算「看过」，P5 生效）
 * - not_interested → 以后策展永远不选（落地校验剔除 + 进 Call A 的 avoid）
 * - skipped → 只进历史，让策展人知道
 * 全部场次都有反馈后影展置 completed。
 */
import { and, eq, isNull } from 'drizzle-orm'
import { getDb, tx } from '@/db/client'
import { getFilm, setAliasMatch, upsertAlias, upsertWatchEntry } from '@/db/repo/library'
import { festivals, screenings, watchLog, type Festival, type Screening } from '@/db/schema'
import { nowIso } from '@/lib/time'

export type Feedback = NonNullable<Screening['feedback']>

export function setScreeningFeedback(userId: string, festival: Festival, screeningId: string, feedback: Feedback | null): Screening {
  const db = getDb()
  return tx(() => {
    const s = db
      .select()
      .from(screenings)
      .where(and(eq(screenings.id, screeningId), eq(screenings.festivalId, festival.id), eq(screenings.userId, userId)))
      .get()
    if (!s) throw Object.assign(new Error('场次不存在'), { userFacing: true })
    const updated = db
      .update(screenings)
      .set({ feedback, feedbackAt: feedback ? nowIso() : null })
      .where(eq(screenings.id, s.id))
      .returning()
      .get()

    const entryId = `fest:${s.id}`
    if (feedback === 'watched') {
      const film = getFilm(s.tmdbId)!
      const alias = upsertAlias({ provider: 'manual', externalId: `tmdb:${film.tmdbId}`, titleRaw: film.titleEn, yearRaw: film.year })
      if (alias.matchStatus !== 'confirmed') setAliasMatch(alias.id, { status: 'confirmed', tmdbId: film.tmdbId, confidence: 1, candidates: null })
      upsertWatchEntry({
        userId,
        sourceId: null,
        aliasId: alias.id,
        tmdbId: film.tmdbId,
        provider: 'fest',
        externalEntryId: entryId,
        watchedAt: (s.startsAt ?? nowIso()).slice(0, 10),
        loggedAt: nowIso().slice(0, 10),
      })
    } else {
      db.delete(watchLog).where(and(eq(watchLog.userId, userId), eq(watchLog.provider, 'fest'), eq(watchLog.externalEntryId, entryId))).run()
    }

    // 全部有反馈 → completed；撤回反馈 → 回到 published
    const open = db
      .select({ id: screenings.id })
      .from(screenings)
      .where(and(eq(screenings.festivalId, festival.id), isNull(screenings.feedback)))
      .get()
    if (festival.status === 'published' && !open) db.update(festivals).set({ status: 'completed' }).where(eq(festivals.id, festival.id)).run()
    if (festival.status === 'completed' && open) db.update(festivals).set({ status: 'published' }).where(eq(festivals.id, festival.id)).run()
    return updated
  })
}

/** 用户在历史里勾掉的片：给 Call A 的 avoid 与落地校验用。 */
export function feedbackSummary(list: Pick<Screening, 'feedback'>[]): Record<Feedback | 'none', number> {
  const out = { watched: 0, skipped: 0, not_interested: 0, none: 0 }
  for (const s of list) out[s.feedback ?? 'none']++
  return out
}
