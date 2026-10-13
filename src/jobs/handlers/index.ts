import type { JobType } from '@/db/schema'
import { erase, type AnyJobHandler } from '../types'
import { buildTasteHandler } from './build-taste'
import { demoHandler } from './demo'
import { enrichFilmsHandler } from './enrich-films'
import { generateFestivalHandler } from './generate-festival'
import { syncSourceHandler } from './sync-source'

/** 任务类型 → handler。尚未实现的类型在后续里程碑补上。 */
export const handlers: Partial<Record<JobType, AnyJobHandler>> = {
  demo: erase(demoHandler),
  sync_source: erase(syncSourceHandler),
  enrich_films: erase(enrichFilmsHandler),
  build_taste: erase(buildTasteHandler),
  generate_festival: erase(generateFestivalHandler),
}
