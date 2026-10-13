import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createSource, findSource, listSources } from '@/db/repo/sources'
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
    const handle = body.provider === 'letterboxd' ? 'export' : body.handle
    const source = findSource(user.id, body.provider, 'upload', handle) ?? createSource({ userId: user.id, provider: body.provider, handle, syncMode: 'upload' })
    const path = saveUpload(user.id, source.id, ext, Buffer.from(await file.arrayBuffer()))
    const job = enqueueJob('sync_source', { source_id: source.id, upload_path: path, full: true }, user.id)
    return NextResponse.json({ source_id: source.id, job_id: job.id }, { status: 201 })
  }
  const body = await parseJson(req, JsonBody)
  if (body.mode === 'upload') throw new ApiError(400, 'use_multipart', '上传模式请用 multipart/form-data')
  throw new ApiError(400, 'not_supported_yet', `${body.provider} / ${body.mode} 将在 M6 支持`)
})
