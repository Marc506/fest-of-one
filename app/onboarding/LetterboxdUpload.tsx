'use client'

import { UploadSource } from './UploadSource'

export function LetterboxdUpload() {
  return <UploadSource provider="letterboxd" accept=".zip" label="上传并导入" />
}
