import { and, eq } from 'drizzle-orm'
import { getDb } from '../client'
import { availability, type User } from '../schema'
import { AvailabilityBlockSchema, type AvailabilityBlock } from '../types'
import type { AvailabilityInput } from '@/scheduler/slots'
import { z } from 'zod'

/** 新用户的默认每周模板：工作日晚上 19:00–23:30，周末 13:00–24:00。 */
export const DEFAULT_TEMPLATE: { mode: 'available'; blocks: AvailabilityBlock[] } = {
  mode: 'available',
  blocks: [
    ...[0, 1, 2, 3, 4].map((dow) => ({ dow, start: '19:00', end: '23:30' })),
    { dow: 5, start: '13:00', end: '24:00' },
    { dow: 6, start: '13:00', end: '24:00' },
  ],
}

export type AvailabilityRow = typeof availability.$inferSelect

export function getAvailability(userId: string, week: string): AvailabilityRow | undefined {
  return getDb()
    .select()
    .from(availability)
    .where(and(eq(availability.userId, userId), eq(availability.weekStart, week)))
    .get()
}

export function putAvailability(userId: string, week: string, mode: 'available' | 'unavailable', blocks: AvailabilityBlock[]): AvailabilityRow {
  const clean = z.array(AvailabilityBlockSchema).parse(blocks)
  return getDb()
    .insert(availability)
    .values({ userId, weekStart: week, mode, blocks: clean })
    .onConflictDoUpdate({ target: [availability.userId, availability.weekStart], set: { mode, blocks: clean } })
    .returning()
    .get()
}

/** 该周的可用时间：本周覆盖 → 用户模板 → 默认模板。 */
export function resolveAvailability(userId: string, week: string): { mode: 'available' | 'unavailable'; blocks: AvailabilityBlock[]; source: 'week' | 'template' | 'default' } {
  const w = getAvailability(userId, week)
  if (w) return { mode: w.mode, blocks: w.blocks, source: 'week' }
  const t = getAvailability(userId, 'template')
  if (t) return { mode: t.mode, blocks: t.blocks, source: 'template' }
  return { ...DEFAULT_TEMPLATE, source: 'default' }
}

export function getDefaultAvailability(user: User, week: string): AvailabilityInput {
  const a = resolveAvailability(user.id, week)
  return { mode: a.mode, blocks: a.blocks, prefs: user.prefs, tz: user.tz }
}
