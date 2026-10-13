/**
 * 影展生成 / 换一个（7.1 / 7.8）的服务层：API 与 worker 共用。
 */
import { formatInTimeZone } from 'date-fns-tz'
import { curate, persistCuration } from '@/curator'
import { resolveAvailability } from '@/db/repo/availability'
import {
  createFestivalRequest,
  festivalsForRequest,
  getFestivalRequest,
  getScreenings,
  setFestivalStatus,
  updateFestivalRequest,
} from '@/db/repo/festivals'
import { getUser } from '@/db/repo/users'
import type { Festival, User } from '@/db/schema'
import { enqueueJob } from '@/jobs/queue'
import { UserFacingError } from '@/jobs/types'
import { addDays, checkFeasibility, currentWeekStart, deriveWindows } from '@/scheduler/slots'

export const MAX_REROLLS = 5

/** 只支持本周与下周（16 章未决项默认）。 */
export function allowedWeeks(user: Pick<User, 'tz'>, now = new Date()): string[] {
  const cur = currentWeekStart(user.tz, now)
  return [cur, addDays(cur, 7)]
}

export function startGeneration(user: User, input: { weekStart: string; days: number; filmCount: number }, now = new Date()) {
  if (!allowedWeeks(user, now).includes(input.weekStart)) throw new UserFacingError('只能为本周或下周生成影展')
  const a = resolveAvailability(user.id, input.weekStart)
  const snapshot = { mode: a.mode, blocks: a.blocks, prefs: user.prefs, tz: user.tz }
  // 同步预检：不可行时立刻告诉用户，不必排队
  const feas = checkFeasibility(deriveWindows(snapshot, input.weekStart, now), input.days, input.filmCount, user.prefs)
  if (feas.error) throw new UserFacingError(feas.error)
  const req = createFestivalRequest({
    userId: user.id,
    weekStart: input.weekStart,
    days: input.days,
    filmCount: input.filmCount,
    availabilitySnapshot: snapshot,
  })
  const job = enqueueJob('generate_festival', { request_id: req.id }, user.id)
  updateFestivalRequest(req.id, { jobId: job.id })
  return { request: req, job, notes: feas.notes }
}

/** 换一个：当前影展置 dismissed，avoid 追加 subject 与片单，重跑 2–7 步。 */
export function startReroll(user: User, festival: Festival) {
  const req = getFestivalRequest(festival.requestId)
  if (!req || req.userId !== user.id) throw new UserFacingError('影展不存在')
  if (req.rerollCount >= MAX_REROLLS) throw new UserFacingError(`这一周已经换了 ${MAX_REROLLS} 次，先看看这一个吧`)
  const slate = getScreenings(festival.id).map((s) => s.tmdbId)
  const avoid = {
    kinds: req.avoid.kinds,
    subjects: [...new Set([...req.avoid.subjects, festival.subject])],
    tmdb_ids: [...new Set([...req.avoid.tmdb_ids, ...slate])],
  }
  setFestivalStatus(festival.id, 'dismissed')
  updateFestivalRequest(req.id, { avoid, rerollCount: req.rerollCount + 1 })
  const job = enqueueJob('generate_festival', { request_id: req.id, reroll_of: festival.id }, user.id)
  updateFestivalRequest(req.id, { jobId: job.id })
  return { job, rerollsLeft: MAX_REROLLS - req.rerollCount - 1 }
}

/** worker：执行一次生成（含 reroll）。生成以 request 为单位，失败不留半个 festival（persist 在事务里）。 */
export async function runGeneration(requestId: string, opts: { jobId: string; progress: (p: number, m?: string) => void; log: (l: string) => void }) {
  const req = getFestivalRequest(requestId)
  if (!req) throw new UserFacingError('生成请求不存在')
  const user = getUser(req.userId)
  if (!user) throw new UserFacingError('用户不存在')
  // 同一 request 已有未 dismiss 的影展（任务被重试）→ 直接复用，保证幂等
  const existing = festivalsForRequest(req.id).find((f) => f.status !== 'dismissed')
  if (existing) return { festival_id: existing.id, reused: true }
  const r = await curate({
    userId: user.id,
    weekStart: req.weekStart,
    days: req.days,
    filmCount: req.filmCount,
    availability: req.availabilitySnapshot,
    avoid: req.avoid,
    today: formatInTimeZone(new Date(), user.tz, 'yyyy-MM-dd'),
    jobId: opts.jobId,
    progress: opts.progress,
    log: opts.log,
  })
  const saved = persistCuration(req.id, user.id, r)
  return {
    festival_id: saved.festival.id,
    kind: saved.festival.kind,
    title: saved.festival.title,
    unscheduled: saved.screenings.filter((s) => !s.startsAt).length,
    notes: r.feasibility.notes,
    usage: r.usage,
  }
}
