import { NextResponse } from 'next/server'
import { z } from 'zod'
import { deleteSource, getSourceForUser, updateSourceAuth } from '@/db/repo/sources'
import { encryptSecret } from '@/lib/crypto'
import { ApiError, parseJson, requireApiUser, route } from '@/lib/api'

/** 删除来源及其 watch_log / watchlist（外键级联）。 */
export const DELETE = route(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireApiUser()
  const { id } = await params
  if (!deleteSource(id, user.id)) throw new ApiError(404, 'not_found', '来源不存在')
  return NextResponse.json({ ok: true })
})

/** 更新或清除豆瓣 Cookie（12 章：用户可随时清除；UI 只显示「已设置」）。 */
export const PATCH = route(async (req, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireApiUser()
  const { id } = await params
  const source = getSourceForUser(id, user.id)
  if (!source) throw new ApiError(404, 'not_found', '来源不存在')
  const body = await parseJson(req, z.object({ cookie: z.string().max(10_000).nullable() }))
  updateSourceAuth(source.id, body.cookie?.trim() ? encryptSecret(body.cookie.trim()) : null)
  return NextResponse.json({ ok: true, has_auth: Boolean(body.cookie?.trim()) })
})
