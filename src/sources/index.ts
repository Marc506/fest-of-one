import type { SourceAccount } from '@/db/schema'
import { letterboxdZipAdapter } from './letterboxd-zip'
import type { SourceAdapter } from './types'

/** 来源账号 → 适配器。M6 补 Letterboxd RSS、豆瓣 CSV / 抓取。 */
export function adapterFor(account: Pick<SourceAccount, 'provider' | 'syncMode'>): SourceAdapter {
  if (account.provider === 'letterboxd' && account.syncMode === 'upload') return letterboxdZipAdapter
  throw new Error(`暂不支持的来源：${account.provider} / ${account.syncMode}`)
}
