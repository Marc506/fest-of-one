import { and, asc, eq } from 'drizzle-orm'
import { getDb } from '../client'
import { sourceAccounts, type SourceAccount } from '../schema'
import { nowIso } from '@/lib/time'

export function createSource(input: {
  userId: string
  provider: SourceAccount['provider']
  handle: string
  syncMode: SourceAccount['syncMode']
  authEnc?: string | null
}): SourceAccount {
  return getDb()
    .insert(sourceAccounts)
    .values({ ...input, authEnc: input.authEnc ?? null })
    .returning()
    .get()
}

/** 同一用户、同一 provider + mode + handle 复用已有来源（重复上传导出 ZIP 时）。 */
export function findSource(userId: string, provider: SourceAccount['provider'], syncMode: SourceAccount['syncMode'], handle: string) {
  return getDb()
    .select()
    .from(sourceAccounts)
    .where(
      and(
        eq(sourceAccounts.userId, userId),
        eq(sourceAccounts.provider, provider),
        eq(sourceAccounts.syncMode, syncMode),
        eq(sourceAccounts.handle, handle),
      ),
    )
    .get()
}

export function getSource(id: string): SourceAccount | undefined {
  return getDb().select().from(sourceAccounts).where(eq(sourceAccounts.id, id)).get()
}

export function getSourceForUser(id: string, userId: string): SourceAccount | undefined {
  return getDb()
    .select()
    .from(sourceAccounts)
    .where(and(eq(sourceAccounts.id, id), eq(sourceAccounts.userId, userId)))
    .get()
}

export function listSources(userId: string): SourceAccount[] {
  return getDb().select().from(sourceAccounts).where(eq(sourceAccounts.userId, userId)).orderBy(asc(sourceAccounts.createdAt)).all()
}

export function markSourceSynced(id: string, patch: { cursor?: unknown; error?: string | null }): void {
  getDb()
    .update(sourceAccounts)
    .set({
      ...(patch.cursor !== undefined ? { cursor: patch.cursor } : {}),
      ...(patch.error ? { lastError: patch.error } : { lastError: null, lastSyncAt: nowIso() }),
    })
    .where(eq(sourceAccounts.id, id))
    .run()
}

export function updateSourceAuth(id: string, authEnc: string | null): void {
  getDb().update(sourceAccounts).set({ authEnc }).where(eq(sourceAccounts.id, id)).run()
}

/** 删除来源；watch_log / watchlist 经 source_id 外键级联删除。 */
export function deleteSource(id: string, userId: string): boolean {
  return getDb().delete(sourceAccounts).where(and(eq(sourceAccounts.id, id), eq(sourceAccounts.userId, userId))).run().changes > 0
}
