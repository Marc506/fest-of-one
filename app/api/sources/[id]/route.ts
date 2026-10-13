import { NextResponse } from 'next/server'
import { deleteSource } from '@/db/repo/sources'
import { ApiError, requireApiUser, route } from '@/lib/api'

/** 删除来源及其 watch_log / watchlist（外键级联）。 */
export const DELETE = route(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireApiUser()
  const { id } = await params
  if (!deleteSource(id, user.id)) throw new ApiError(404, 'not_found', '来源不存在')
  return NextResponse.json({ ok: true })
})
