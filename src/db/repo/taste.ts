import { and, desc, eq, sql } from 'drizzle-orm'
import { getDb } from '../client'
import { tasteProfiles, type TasteProfile } from '../schema'

export function latestTasteProfile(userId: string): TasteProfile | undefined {
  return getDb().select().from(tasteProfiles).where(eq(tasteProfiles.userId, userId)).orderBy(desc(tasteProfiles.version)).get()
}

/** 最近一个带 LLM 备忘的画像（策展用）。 */
export function latestProfileWithMemo(userId: string): TasteProfile | undefined {
  return getDb()
    .select()
    .from(tasteProfiles)
    .where(and(eq(tasteProfiles.userId, userId), sql`${tasteProfiles.memo} is not null`))
    .orderBy(desc(tasteProfiles.version))
    .get()
}

export function insertTasteProfile(row: Omit<typeof tasteProfiles.$inferInsert, 'version'>): TasteProfile {
  const db = getDb()
  const v = db.select({ v: sql<number>`coalesce(max(${tasteProfiles.version}), 0)` }).from(tasteProfiles).where(eq(tasteProfiles.userId, row.userId)).get()?.v ?? 0
  return db.insert(tasteProfiles).values({ ...row, version: v + 1 }).returning().get()
}

export function getTasteProfileVersion(userId: string, version: number): TasteProfile | undefined {
  return getDb()
    .select()
    .from(tasteProfiles)
    .where(and(eq(tasteProfiles.userId, userId), eq(tasteProfiles.version, version)))
    .get()
}

/** 画像历史（新的在前）：版本号、时间、有没有备忘、当时的近期权重档位。 */
export function listTasteProfileVersions(userId: string): { version: number; createdAt: string; hasMemo: boolean; recency: string | null }[] {
  return getDb()
    .select({
      version: tasteProfiles.version,
      createdAt: tasteProfiles.createdAt,
      hasMemo: sql<number>`${tasteProfiles.memo} is not null`,
      recency: sql<string | null>`json_extract(${tasteProfiles.stats}, '$.recency.level')`,
    })
    .from(tasteProfiles)
    .where(eq(tasteProfiles.userId, userId))
    .orderBy(desc(tasteProfiles.version))
    .all()
    .map((r) => ({ ...r, hasMemo: Boolean(r.hasMemo) }))
}
