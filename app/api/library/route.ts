import { NextResponse } from 'next/server'
import { z } from 'zod'
import { libraryCounts, listLibrary, unresolvedAliasesForUser } from '@/db/repo/library'
import { requireApiUser, route } from '@/lib/api'

const Query = z.object({
  status: z.enum(['all', 'ambiguous', 'unresolved']).default('all'),
  q: z.string().max(200).optional(),
  min_rating: z.coerce.number().int().min(1).max(10).optional(),
  year_from: z.coerce.number().int().optional(),
  year_to: z.coerce.number().int().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
})

/** 观影记录 / 未匹配列表。`?status=ambiguous` 只返回 ambiguous；`unresolved` 含 unmatched。 */
export const GET = route(async (req) => {
  const user = await requireApiUser()
  const q = Query.parse(Object.fromEntries(new URL(req.url).searchParams))
  if (q.status !== 'all') {
    const rows = unresolvedAliasesForUser(user.id).filter((a) => q.status === 'unresolved' || a.matchStatus === 'ambiguous')
    return NextResponse.json({
      aliases: rows.map((a) => ({
        id: a.id,
        provider: a.provider,
        title_raw: a.titleRaw,
        year_raw: a.yearRaw,
        status: a.matchStatus,
        confidence: a.matchConfidence,
        candidates: a.candidates ?? [],
        watched: a.watched,
      })),
    })
  }
  const { rows, total } = listLibrary(user.id, {
    q: q.q,
    minRating: q.min_rating,
    yearFrom: q.year_from,
    yearTo: q.year_to,
    limit: q.limit,
    offset: q.offset,
  })
  return NextResponse.json({ total, counts: libraryCounts(user.id), rows })
})
