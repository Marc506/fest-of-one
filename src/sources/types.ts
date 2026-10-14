/** 数据接入层接口（5.1）。 */
import type { SourceAccount } from '@/db/schema'
import type { FetchLike } from '@/lib/http'

export type Provider = 'letterboxd' | 'douban' | 'manual'

export interface RawEntry {
  provider: Provider
  /** 影片在来源处的去重键（Letterboxd 影片 URI / 豆瓣 subject id） */
  externalId: string
  /**
   * 单条观看记录的去重键（→ watch_log.external_entry_id）。
   * 同一部片多次观看各有一条；没有 diary 的看过记录用 `watched:{externalId}`。
   * 偏离：规格的 RawEntry 只有 externalId；Letterboxd 的 diary 行与影片不是一一对应，所以加了这个字段。
   */
  entryId: string
  /** 原始标题（豆瓣可能是「中文名 / 原名」） */
  title: string
  year?: number
  /** Letterboxd RSS 直接给 */
  tmdbId?: number
  /** 豆瓣 subject 页可抓到 */
  imdbId?: string
  /** YYYY-MM-DD */
  watchedAt?: string
  loggedAt?: string
  rating10?: number
  liked?: boolean
  rewatch?: boolean
  review?: string
  tags?: string[]
  listKind: 'watched' | 'watchlist'
  raw: unknown
}

export type AdapterCtx = {
  account: SourceAccount
  http: FetchLike
  log: (...args: unknown[]) => void
  onProgress: (pct: number, msg?: string) => void
  /** 上传模式：已保存的上传文件路径 */
  uploadPath?: string
}

export interface SourceAdapter {
  readonly provider: 'letterboxd' | 'douban'
  readonly mode: 'upload' | 'rss' | 'scrape'
  /** 全量 */
  fetchAll(ctx: AdapterCtx): AsyncIterable<RawEntry>
  /** 增量（可选）；返回后由调用方读取 `nextCursor` */
  fetchIncremental?(ctx: AdapterCtx, cursor: unknown): AsyncIterable<RawEntry>
  /** 增量 / 抓取结束后的新游标 */
  nextCursor?: unknown
}

/** 星级（0.5–5，步长 0.5）→ rating10（1–10）。附录 B。 */
export function starsToRating10(stars: number | null | undefined): number | undefined {
  if (stars == null || !Number.isFinite(stars) || stars <= 0) return undefined
  return Math.max(1, Math.min(10, Math.round(stars * 2)))
}
