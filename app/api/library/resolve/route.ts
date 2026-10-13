import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ApiError, parseJson, requireApiUser, route } from '@/lib/api'
import { getTmdbClient } from '@/resolver/tmdb'
import { confirmAlias, NotFound } from '@/sources/manual'

const Body = z.object({ alias_id: z.number().int().positive(), tmdb_id: z.number().int().positive() })

export const POST = route(async (req) => {
  const user = await requireApiUser()
  const body = await parseJson(req, Body)
  try {
    const film = await confirmAlias(getTmdbClient(), user.id, body.alias_id, body.tmdb_id)
    return NextResponse.json({ ok: true, tmdb_id: film.tmdbId, title: film.titleEn })
  } catch (err) {
    if (err instanceof NotFound) throw new ApiError(404, 'not_found', err.message)
    throw err
  }
})
