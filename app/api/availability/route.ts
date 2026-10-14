import { NextResponse } from 'next/server'
import { z } from 'zod'
import { putAvailability, resolveAvailability } from '@/db/repo/availability'
import { AvailabilityBlockSchema } from '@/db/types'
import { parseJson, requireApiUser, route } from '@/lib/api'

const Week = z.union([z.literal('template'), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)])

export const GET = route(async (req) => {
  const user = await requireApiUser()
  const week = Week.parse(new URL(req.url).searchParams.get('week') ?? 'template')
  const a = resolveAvailability(user.id, week)
  return NextResponse.json({ week, ...a })
})

const Body = z.object({ mode: z.enum(['available', 'unavailable']), blocks: z.array(AvailabilityBlockSchema).max(7 * 48) })

export const PUT = route(async (req) => {
  const user = await requireApiUser()
  const week = Week.parse(new URL(req.url).searchParams.get('week') ?? 'template')
  const body = await parseJson(req, Body)
  const row = putAvailability(user.id, week, body.mode, body.blocks)
  return NextResponse.json({ week: row.weekStart, mode: row.mode, blocks: row.blocks })
})
