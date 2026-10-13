'use server'

import { signIn } from '@/auth'
import { CALENDAR_SCOPE } from '@/calendar/google'

export async function connectGoogleFromSettings() {
  await signIn(
    'google',
    { redirectTo: '/settings' },
    { scope: `openid email profile ${CALENDAR_SCOPE}`, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true' },
  )
}
