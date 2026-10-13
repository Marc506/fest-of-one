/**
 * JSON 列的结构（zod 定义 + 推导类型）。repo 层读写 JSON 列时用这些 schema 校验。
 */
import { z } from 'zod'

export type { TasteStatsT } from '@/taste/types'
export type { TasteMemoT, IdeateConceptT, AuditOutputT } from '@/curator/schemas'

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$|^24:00$/, 'HH:mm')

export const UserPrefsSchema = z.object({
  day_bounds: z.object({ start: HHMM, end: HHMM }),
  buffer_min: z.number().int().min(0).max(240),
  max_films_per_day: z.number().int().min(1).max(6),
  weekday_max_runtime_min: z.number().int().min(60).max(600),
  preferred_start: HHMM.nullable(),
  alarm_min: z.number().int().min(0).max(1440).nullable(),
})
export type UserPrefs = z.infer<typeof UserPrefsSchema>

export const DEFAULT_PREFS: UserPrefs = {
  day_bounds: { start: '10:00', end: '24:00' },
  buffer_min: 20,
  max_films_per_day: 2,
  weekday_max_runtime_min: 170,
  preferred_start: '19:30',
  alarm_min: 30,
}

export const AvailabilityBlockSchema = z.object({
  /** 0 = 周一 … 6 = 周日 */
  dow: z.number().int().min(0).max(6),
  start: HHMM,
  end: HHMM,
})
export type AvailabilityBlock = z.infer<typeof AvailabilityBlockSchema>

export const FestivalAvoidSchema = z.object({
  kinds: z.array(z.string()),
  subjects: z.array(z.string()),
  tmdb_ids: z.array(z.number().int()),
})
export type FestivalAvoid = z.infer<typeof FestivalAvoidSchema>

export type PersonRef = { tmdb_person_id: number; name: string }
export type CastMember = PersonRef & { character: string | null; order: number }
