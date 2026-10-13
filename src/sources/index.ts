import type { SourceAccount } from '@/db/schema'
import { doubanUploadAdapter } from './douban-csv'
import { DoubanScrapeAdapter } from './douban-scrape'
import { LetterboxdRssAdapter } from './letterboxd-rss'
import { letterboxdZipAdapter } from './letterboxd-zip'
import type { SourceAdapter } from './types'

/** 来源账号 → 适配器（有游标的每次新建实例）。 */
export function adapterFor(account: Pick<SourceAccount, 'provider' | 'syncMode'>): SourceAdapter {
  if (account.provider === 'letterboxd' && account.syncMode === 'upload') return letterboxdZipAdapter
  if (account.provider === 'letterboxd' && account.syncMode === 'rss') return new LetterboxdRssAdapter()
  if (account.provider === 'douban' && account.syncMode === 'upload') return doubanUploadAdapter
  if (account.provider === 'douban' && account.syncMode === 'scrape') return new DoubanScrapeAdapter()
  throw new Error(`暂不支持的来源：${account.provider} / ${account.syncMode}`)
}
