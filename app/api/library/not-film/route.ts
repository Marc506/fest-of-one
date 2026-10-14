import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getAlias, setAliasMatch, userReferencesAlias } from '@/db/repo/library'
import { ApiError, parseJson, requireApiUser, route } from '@/lib/api'

const Body = z.object({ alias_id: z.number().int().positive(), not_film: z.boolean() })

/** 标为「不是电影」（剧集 / 综艺 / 舞台录像…），或恢复到待确认。 */
export const POST = route(async (req) => {
  const user = await requireApiUser()
  const body = await parseJson(req, Body)
  const alias = getAlias(body.alias_id)
  if (!alias || !userReferencesAlias(user.id, alias.id)) throw new ApiError(404, 'not_found', '条目不存在')
  if (alias.matchStatus === 'confirmed' || alias.matchStatus === 'matched') throw new ApiError(409, 'already_matched', '这条已经对上了电影')
  setAliasMatch(alias.id, { status: body.not_film ? 'not_film' : 'unmatched', tmdbId: null, confidence: null, candidates: alias.candidates })
  return NextResponse.json({ ok: true })
})
