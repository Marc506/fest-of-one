import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { NextResponse } from 'next/server'
import { getSourceForUser } from '@/db/repo/sources'
import { enqueueJob } from '@/jobs/queue'
import { ApiError, requireApiUser, route } from '@/lib/api'
import { uploadDir } from '@/sources/uploads'

/** 重新同步：上传模式用最近一次上传的文件；RSS / 抓取模式做增量。 */
export const POST = route(async (_req, { params }: { params: Promise<{ id: string }> }) => {
  const user = await requireApiUser()
  const { id } = await params
  const source = getSourceForUser(id, user.id)
  if (!source) throw new ApiError(404, 'not_found', '来源不存在')
  let payload: { source_id: string; upload_path?: string; full: boolean } = { source_id: source.id, full: false }
  if (source.syncMode === 'upload') {
    const dir = join(uploadDir(), user.id)
    let files: string[] = []
    try {
      files = readdirSync(dir).filter((f) => f.startsWith(source.id + '-')).sort()
    } catch {
      // 目录不存在
    }
    const last = files.at(-1)
    if (!last) throw new ApiError(400, 'no_upload', '没有可用的上传文件，请重新上传')
    payload = { source_id: source.id, upload_path: join(dir, last), full: true }
  }
  const job = enqueueJob('sync_source', payload, user.id)
  return NextResponse.json({ job_id: job.id })
})
