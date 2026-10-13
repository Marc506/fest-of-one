import { NextResponse } from 'next/server'
import { z } from 'zod'
import { startGeneration } from '@/festival/service'
import { parseJson, requireApiUser, route } from '@/lib/api'

const Body = z.object({
  week_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  days: z.number().int().min(1).max(7),
  film_count: z.number().int().min(1).max(12),
})

export const POST = route(async (req) => {
  const user = await requireApiUser()
  const body = await parseJson(req, Body)
  const r = startGeneration(user, { weekStart: body.week_start, days: body.days, filmCount: body.film_count })
  return NextResponse.json({ job_id: r.job.id, request_id: r.request.id, notes: r.notes }, { status: 202 })
})
