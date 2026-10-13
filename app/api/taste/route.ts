import { NextResponse } from 'next/server'
import { latestTasteProfile } from '@/db/repo/taste'
import { requireApiUser, route } from '@/lib/api'
import { rebuildDecision } from '@/taste/profile'

export const GET = route(async () => {
  const user = await requireApiUser()
  const p = latestTasteProfile(user.id)
  return NextResponse.json({
    profile: p
      ? { id: p.id, version: p.version, created_at: p.createdAt, stats: p.stats, memo: p.memo, memo_md: p.memoMd, films: p.watchLogCount }
      : null,
    rebuild: rebuildDecision(user.id),
  })
})
