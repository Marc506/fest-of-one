import { z } from 'zod'
import { runGeneration } from '@/festival/service'
import { defineHandler } from '../types'

export const generateFestivalHandler = defineHandler({
  payload: z.object({ request_id: z.string(), reroll_of: z.string().optional() }),
  async run({ payload, job, progress, log }) {
    return runGeneration(payload.request_id, { jobId: job.id, progress, log: (l) => log(l) })
  },
})
