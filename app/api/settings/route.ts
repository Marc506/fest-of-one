import { NextResponse } from 'next/server'
import { z } from 'zod'
import { updateUserSettings } from '@/db/repo/users'
import { recencyOf, UserPrefsSchema } from '@/db/types'
import { enqueueJob } from '@/jobs/queue'
import { parseJson, requireApiUser, route } from '@/lib/api'
import { rebuildDecision } from '@/taste/profile'

const Body = z.object({
  locale: z.enum(['zh-CN', 'en']).optional(),
  tz: z
    .string()
    .refine((tz) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: tz })
        return true
      } catch {
        return false
      }
    }, '不是有效的 IANA 时区')
    .optional(),
  prefs: UserPrefsSchema.optional(),
})

export const GET = route(async () => {
  const user = await requireApiUser()
  return NextResponse.json({ locale: user.locale, tz: user.tz, prefs: user.prefs })
})

export const PUT = route(async (req) => {
  const user = await requireApiUser()
  const body = await parseJson(req, Body)
  const u = updateUserSettings(user.id, body)
  // 近期权重变了 → 按新权重重建画像（策展时的观影记录序列化立即生效，备忘与统计要重建）
  let rebuild: string | null = null
  if (recencyOf(u.prefs) !== recencyOf(user.prefs) && rebuildDecision(u.id).needed) {
    rebuild = enqueueJob('build_taste', { force: true }, u.id).id
  }
  return NextResponse.json({ locale: u.locale, tz: u.tz, prefs: u.prefs, taste_rebuild_job_id: rebuild })
})
