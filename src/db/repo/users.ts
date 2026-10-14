import { eq } from 'drizzle-orm'
import { getDb } from '../client'
import { users, type User } from '../schema'
import { newCalendarToken } from '@/lib/ids'
import { UserPrefsSchema, type UserPrefs } from '../types'

export function getUser(id: string): User | undefined {
  return getDb().select().from(users).where(eq(users.id, id)).get()
}

export function getUserByEmail(email: string): User | undefined {
  return getDb().select().from(users).where(eq(users.email, email)).get()
}

export function getUserByCalendarToken(token: string): User | undefined {
  return getDb().select().from(users).where(eq(users.calendarToken, token)).get()
}

/** 找到或创建一个用户（dev 登录、测试、fixture 用）。 */
export function upsertUserByEmail(email: string, name?: string): User {
  const existing = getUserByEmail(email)
  if (existing) return existing
  return getDb().insert(users).values({ email, name: name ?? null }).returning().get()
}

export function updateUserSettings(
  id: string,
  patch: { locale?: User['locale']; tz?: string; prefs?: UserPrefs; name?: string | null },
): User {
  const values: Partial<typeof users.$inferInsert> = {}
  if (patch.locale) values.locale = patch.locale
  if (patch.tz) values.tz = patch.tz
  if (patch.prefs) values.prefs = UserPrefsSchema.parse(patch.prefs)
  if (patch.name !== undefined) values.name = patch.name
  return getDb().update(users).set(values).where(eq(users.id, id)).returning().get()
}

export function rotateCalendarToken(id: string): string {
  const token = newCalendarToken()
  getDb().update(users).set({ calendarToken: token }).where(eq(users.id, id)).run()
  return token
}
