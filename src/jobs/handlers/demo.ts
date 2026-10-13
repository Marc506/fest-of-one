import { z } from 'zod'
import { sleep } from '@/lib/time'
import { defineHandler } from '../types'

export const demoHandler = defineHandler({
  payload: z.object({ steps: z.number().int().min(1).max(50).default(5), ms: z.number().int().min(0).max(5000).default(400) }),
  async run({ payload, progress }) {
    for (let i = 1; i <= payload.steps; i++) {
      await sleep(payload.ms)
      progress((i / payload.steps) * 100, `demo step ${i}/${payload.steps}`)
    }
    return { ok: true, steps: payload.steps }
  },
})
