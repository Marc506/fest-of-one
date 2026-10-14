import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createSource, findSource, listSources, updateSourceAuth } from '@/db/repo/sources'
import { encryptSecret } from '@/lib/crypto'
import { enqueueJob } from '@/jobs/queue'
import { ApiError, parseJson, requireApiUser, route } from '@/lib/api'
import { saveUpload } from '@/sources/uploads'

const MAX_UPLOAD = 50 * 1024 * 1024

const JsonBody = z.object({
  provider: z.enum(['letterboxd', 'douban']),
  handle: z.string().min(1).max(200),
  mode: z.enum(['upload', 'rss', 'scrape']),
  cookie: z.string().max(10_000).optional(),
})

export const GET = route(async () => {
  const user = await requireApiUser()
  return NextResponse.json({
    sources: listSources(user.id).map((s) => ({
      id: s.id,
      provider: s.provider,
      handle: s.handle,
      mode: s.syncMode,
      last_sync_at: s.lastSyncAt,
      last_error: s.lastError,
      has_auth: Boolean(s.authEnc),
    })),
  })
})

/**
 * 新建来源：JSON `{provider, handle, mode, cookie?}`；或 multipart（provider, handle, mode, file）上传导出文件。
 * 上传模式会立刻入队 sync_source。
 */
export const POST = route(async (req) => {
  const user = await requireApiUser()
  const ct = req.headers.get('content-type') ?? ''
  if (ct.startsWith('multipart/form-data')) {
    const form = await req.formData()
    const file = form.get('file')
    if (!(file instanceof File)) throw new ApiError(400, 'missing_file', '请选择要上传的文件')
    if (file.size > MAX_UPLOAD) throw new ApiError(413, 'too_large', '文件超过 50MB')
    const body = JsonBody.parse({
      provider: form.get('provider'),
      handle: (form.get('handle') as string) || file.name,
      mode: 'upload',
    })
    const ext = file.name.toLowerCase().match(/\.(zip|csv|xlsx|xls)$/)?.[0]
    if (!ext) throw new ApiError(400, 'bad_file', '只支持 .zip / .csv / .xlsx')
    if (body.provider === 'letterboxd' && ext !== '.zip') throw new ApiError(400, 'bad_file', 'Letterboxd 请上传导出的 .zip')
    if (body.provider === 'douban' && ext === '.zip') throw new ApiError(400, 'bad_file', '豆瓣请上传导出的 .csv 或 .xlsx')
    const handle = 'export'
    const source = findSource(user.id, body.provider, 'upload', handle) ?? createSource({ userId: user.id, provider: body.provider, handle, syncMode: 'upload' })
    const path = saveUpload(user.id, source.id, ext, Buffer.from(await file.arrayBuffer()))
    const job = enqueueJob('sync_source', { source_id: source.id, upload_path: path, full: true }, user.id)
    return NextResponse.json({ source_id: source.id, job_id: job.id }, { status: 201 })
  }
  const body = await parseJson(req, JsonBody)
  if (body.mode === 'upload') throw new ApiError(400, 'use_multipart', '上传模式请用 multipart/form-data')
  const handle = body.handle.trim()
  if (body.provider === 'letterboxd' && body.mode === 'rss') {
    if (!/^[A-Za-z0-9_]{2,40}$/.test(handle.replace(/^@/, ''))) throw new ApiError(400, 'bad_handle', 'Letterboxd 用户名只能包含字母、数字和下划线')
    const source = findSource(user.id, 'letterboxd', 'rss', handle) ?? createSource({ userId: user.id, provider: 'letterboxd', handle, syncMode: 'rss' })
    const job = enqueueJob('sync_source', { source_id: source.id, full: false }, user.id)
    return NextResponse.json({ source_id: source.id, job_id: job.id }, { status: 201 })
  }
  if (body.provider === 'douban' && body.mode === 'scrape') {
    if (!/^[A-Za-z0-9_.-]{1,60}$/.test(handle)) throw new ApiError(400, 'bad_handle', '豆瓣 ID 格式不对（个人主页 /people/ 后面那一段）')
    if (!body.cookie?.trim()) throw new ApiError(400, 'missing_cookie', '抓取需要登录 Cookie（只用于抓取，加密保存）')
    let enc: string
    try {
      enc = encryptSecret(body.cookie.trim())
    } catch (err) {
      throw new ApiError(422, 'no_encryption_key', err instanceof Error ? err.message : '无法加密 Cookie')
    }
    const existing = findSource(user.id, 'douban', 'scrape', handle)
    const source = existing ?? createSource({ userId: user.id, provider: 'douban', handle, syncMode: 'scrape', authEnc: enc })
    if (existing) updateSourceAuth(existing.id, enc)
    const job = enqueueJob('sync_source', { source_id: source.id, full: false }, user.id)
    return NextResponse.json({ source_id: source.id, job_id: job.id }, { status: 201 })
  }
  throw new ApiError(400, 'unsupported', `不支持的组合：${body.provider} / ${body.mode}`)
})
