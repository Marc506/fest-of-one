'use server'

import { signIn } from '@/auth'
import { CALENDAR_SCOPE } from '@/calendar/google'

/** 增量授权 Google 日历（9.4）：授权后回到影展页并自动继续写入。 */
export async function connectGoogleCalendar(festivalId: string) {
  await signIn(
    'google',
    { redirectTo: `/festival/${festivalId}?gcal=1` },
    { scope: `openid email profile ${CALENDAR_SCOPE}`, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  )
}
