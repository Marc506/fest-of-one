import { NextResponse } from 'next/server'
import { webcalUrls } from '@/calendar/links'
import { rotateCalendarToken } from '@/db/repo/users'
import { env } from '@/lib/env'
import { requireApiUser, route } from '@/lib/api'

/** 轮换 webcal token：旧订阅地址立即失效。 */
export const POST = route(async () => {
  const user = await requireApiUser()
  const token = rotateCalendarToken(user.id)
  return NextResponse.json(webcalUrls(env().APP_BASE_URL, token))
})
