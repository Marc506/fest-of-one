import { z } from 'zod'
import { buildTasteProfile } from '@/taste/profile'
import { defineHandler, UserFacingError } from '../types'

export const buildTasteHandler = defineHandler({
  payload: z.object({ force: z.boolean().default(false) }),
  async run({ userId, job, progress, log }) {
    if (!userId) throw new UserFacingError('build_taste 需要 user_id')
    const { profile, memoSkipped } = await buildTasteProfile(userId, { jobId: job.id, progress, log: (l) => log(l) })
    return { profile_id: profile.id, version: profile.version, memo: profile.memo != null, memo_skipped: memoSkipped }
  },
})
