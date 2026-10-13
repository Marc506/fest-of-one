import { NextResponse } from 'next/server'
import { z } from 'zod'
import { updateUserSettings } from '@/db/repo/users'
import { UserPrefsSchema } from '@/db/types'
import { parseJson, requireApiUser, route } from '@/lib/api'

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
  return NextResponse.json({ locale: u.locale, tz: u.tz, prefs: u.prefs })
})
