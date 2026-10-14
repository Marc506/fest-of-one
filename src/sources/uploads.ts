import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { resolveDbPath } from '@/db/client'

/** 上传文件放在数据库同目录的 uploads/ 下（Docker 里同在持久卷）。 */
export function uploadDir(): string {
  if (process.env.UPLOAD_DIR) return resolve(process.env.UPLOAD_DIR)
  const db = resolveDbPath()
  const base = db === ':memory:' ? resolve('data') : dirname(db)
  return join(base, 'uploads')
}

export function saveUpload(userId: string, sourceId: string, ext: string, data: Buffer): string {
  const dir = join(uploadDir(), userId)
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${sourceId}-${Date.now()}${ext.startsWith('.') ? ext : '.' + ext}`)
  writeFileSync(path, data)
  return path
}
