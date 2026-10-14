import { NextResponse } from 'next/server'
import { z } from 'zod'
import { seenTmdbIds } from '@/db/repo/library'
import { requireApiUser, route } from '@/lib/api'
import { withDirectors } from '@/resolver/match'
import { isCjk } from '@/resolver/normalize'
import { getTmdbClient, yearOf } from '@/resolver/tmdb'

const Query = z.object({ q: z.string().min(1).max(200), year: z.coerce.number().int().optional() })

/** /library 搜索框（手动添加、解决 ambiguous）。偏离：规格未单列此端点。 */
export const GET = route(async (req) => {
  const user = await requireApiUser()
  const q = Query.parse(Object.fromEntries(new URL(req.url).searchParams))
  const client = getTmdbClient()
  const language = isCjk(q.q) ? 'zh-CN' : 'en-US'
  const results = await client.searchMovie(q.q, { year: q.year, language })
  const seen = seenTmdbIds(user.id)
  const top = results.slice(0, 10)
  const directors = await withDirectors(
    client,
    top.map((r) => ({ tmdb_id: r.id, title: r.title, year: yearOf(r.release_date), score: 0 })),
  )
  return NextResponse.json({
    results: top.map((r, i) => ({
      tmdb_id: r.id,
      title: r.title,
      original_title: r.original_title,
      year: yearOf(r.release_date),
      poster_path: r.poster_path,
      vote_count: r.vote_count,
      directors: directors[i]?.directors ?? [],
      seen: seen.has(r.id),
    })),
  })
})
