import { NextResponse } from 'next/server'
import { z } from 'zod'
import { ApiError, parseJson, requireApiUser, route } from '@/lib/api'
import { getTmdbClient } from '@/resolver/tmdb'
import { addManualWatch, NotFound } from '@/sources/manual'

const Body = z.object({
  tmdb_id: z.number().int().positive(),
  watched_at: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  rating10: z.number().int().min(1).max(10).nullish(),
  liked: z.boolean().optional(),
})

export const POST = route(async (req) => {
  const user = await requireApiUser()
  const body = await parseJson(req, Body)
  try {
    const film = await addManualWatch(getTmdbClient(), user.id, {
      tmdbId: body.tmdb_id,
      watchedAt: body.watched_at,
      rating10: body.rating10,
      liked: body.liked,
    })
    return NextResponse.json({ ok: true, tmdb_id: film.tmdbId, title: film.titleEn }, { status: 201 })
  } catch (err) {
    if (err instanceof NotFound) throw new ApiError(404, 'not_found', err.message)
    throw err
  }
})
