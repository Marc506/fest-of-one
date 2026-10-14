import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { getDb } from '../client'
import { llmCalls } from '../schema'

export type LlmCallInsert = typeof llmCalls.$inferInsert

export function insertLlmCall(row: LlmCallInsert): number {
  return getDb().insert(llmCalls).values(row).returning({ id: llmCalls.id }).get().id
}

/** 回放用：按 request_hash 取最近一次成功的响应。 */
export function findLlmResponse(requestHash: string): unknown | undefined {
  return getDb()
    .select({ response: llmCalls.response })
    .from(llmCalls)
    .where(and(eq(llmCalls.requestHash, requestHash), sql`${llmCalls.response} is not null`))
    .orderBy(desc(llmCalls.id))
    .get()?.response
}

export function llmCostSummary(userId: string, sinceIso?: string) {
  const where = sinceIso ? and(eq(llmCalls.userId, userId), gte(llmCalls.createdAt, sinceIso)) : eq(llmCalls.userId, userId)
  return getDb()
    .select({
      purpose: llmCalls.purpose,
      calls: sql<number>`count(*)`,
      input: sql<number>`sum(${llmCalls.inputTokens})`,
      cacheWrite: sql<number>`sum(${llmCalls.cacheCreationInputTokens})`,
      cacheRead: sql<number>`sum(${llmCalls.cacheReadInputTokens})`,
      output: sql<number>`sum(${llmCalls.outputTokens})`,
      cost: sql<number>`sum(${llmCalls.costUsd})`,
    })
    .from(llmCalls)
    .where(where)
    .groupBy(llmCalls.purpose)
    .all()
}
