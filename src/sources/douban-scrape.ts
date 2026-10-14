/**
 * 豆瓣抓取（5.3 scrape 模式，非官方、可能失效）：
 *   https://movie.douban.com/people/{id}/collect?start={n}&sort=time&rating=all&filter=all&mode=grid  （每页 15 条）
 *   想看：/wish
 * - 每请求 2–4 秒随机间隔；单次同步最多 100 页
 * - 403 / 跳转到验证页 / 登录页 → 立刻停止并报错「需要重新提供 Cookie 或改用上传」（不绕过验证码）
 * - 游标 = { latest: 最新 subject id, pages }；增量只抓到上次最新为止
 * - 新条目不多（≤ 60）时顺带抓 subject 页的 IMDb 号，供 resolver 用 TMDB find 精确匹配
 */
import * as cheerio from 'cheerio'
import { decryptSecret } from '@/lib/crypto'
import { sleep } from '@/lib/time'
import type { AdapterCtx, RawEntry, SourceAdapter } from './types'

export const DOUBAN_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15'
export const MAX_PAGES = 100
export const PER_PAGE = 15
const IMDB_LOOKUP_LIMIT = 60

export class DoubanBlockedError extends Error {
  readonly userFacing = true
  constructor(detail: string) {
    super(`豆瓣拒绝了抓取（${detail}）：需要重新提供 Cookie 或改用上传导出文件`)
  }
}

export type DoubanCursor = { latest: string | null; pages: number }

/** 解析一页「看过 / 想看」（grid 模式）。 */
export function parseCollectPage(html: string, kind: 'watched' | 'watchlist'): { entries: RawEntry[]; hasNext: boolean } {
  const $ = cheerio.load(html)
  const entries: RawEntry[] = []
  $('.grid-view .item, .item.comment-item').each((_, el) => {
    const item = $(el)
    const href = item.find('a[href*="/subject/"]').first().attr('href') ?? ''
    const id = href.match(/subject\/(\d+)/)?.[1]
    if (!id) return
    const title = item.find('li.title a').first().text().replace(/\s+/g, ' ').trim() || item.find('a[title]').attr('title') || ''
    const intro = item.find('li.intro').text()
    const year = Number(intro.match(/\b(18|19|20)\d{2}\b/)?.[0]) || undefined
    const date = item.find('span.date').text().trim().match(/\d{4}-\d{2}-\d{2}/)?.[0]
    const ratingCls = item.find('span[class^="rating"]').attr('class') ?? ''
    const stars = Number(ratingCls.match(/rating(\d)-t/)?.[1])
    const comment = item.find('span.comment').text().trim() || undefined
    const tags = item
      .find('span.tags')
      .text()
      .replace(/^标签[:：]\s*/, '')
      .split(/\s+/)
      .filter(Boolean)
    entries.push({
      provider: 'douban',
      externalId: id,
      entryId: kind === 'watched' ? `douban:collect:${id}` : `douban:wish:${id}`,
      title,
      year,
      watchedAt: kind === 'watched' ? date : undefined,
      loggedAt: date,
      rating10: kind === 'watched' && stars >= 1 && stars <= 5 ? stars * 2 : undefined,
      review: kind === 'watched' ? comment : undefined,
      tags,
      listKind: kind,
      raw: { id, title, intro: intro.trim(), date, rating: ratingCls, comment },
    })
  })
  const hasNext = $('.paginator .next a').length > 0
  return { entries, hasNext }
}

export function parseImdbId(html: string): string | undefined {
  return html.match(/IMDb:?<\/span>\s*(tt\d+)/)?.[1] ?? html.match(/IMDb:\s*(tt\d+)/)?.[1]
}

function looksBlocked(res: Response, html: string): string | null {
  if (res.status === 403 || res.status === 418) return `HTTP ${res.status}`
  if (/sec\.douban\.com|accounts\.douban\.com|passport/.test(res.url)) return '跳转到了验证 / 登录页'
  if (/<title>\s*(登录豆瓣|禁止访问|异常请求)/.test(html) || /captcha|tjs\/|验证码/i.test(html.slice(0, 5000))) return '出现了验证页'
  return null
}

export class DoubanScrapeAdapter implements SourceAdapter {
  readonly provider = 'douban' as const
  readonly mode = 'scrape' as const
  nextCursor: DoubanCursor | undefined

  constructor(private readonly delayMs: () => number = () => Number(process.env.DOUBAN_DELAY_MS ?? 2000 + Math.random() * 2000)) {}

  private async get(ctx: AdapterCtx, url: string, cookie: string): Promise<string> {
    await sleep(this.delayMs())
    const res = await ctx.http(url, { headers: { cookie, 'user-agent': DOUBAN_UA, referer: 'https://movie.douban.com/' }, redirect: 'follow' })
    const html = await res.text()
    const blocked = looksBlocked(res, html)
    if (blocked) throw new DoubanBlockedError(blocked)
    if (!res.ok) throw new Error(`豆瓣请求失败：HTTP ${res.status}`)
    return html
  }

  async *fetchAll(ctx: AdapterCtx): AsyncIterable<RawEntry> {
    yield* this.run(ctx, null)
  }

  async *fetchIncremental(ctx: AdapterCtx, cursor: unknown): AsyncIterable<RawEntry> {
    yield* this.run(ctx, (cursor as DoubanCursor | null)?.latest ?? null)
  }

  private async *run(ctx: AdapterCtx, stopAt: string | null): AsyncIterable<RawEntry> {
    if (!ctx.account.authEnc) throw new DoubanBlockedError('没有 Cookie')
    const cookie = decryptSecret(ctx.account.authEnc)
    const people = encodeURIComponent(ctx.account.handle)
    let pages = 0
    let latest: string | null = null
    const fresh: RawEntry[] = []
    for (const kind of ['watched', 'watchlist'] as const) {
      const path = kind === 'watched' ? 'collect' : 'wish'
      for (let page = 0; page < MAX_PAGES - pages; page++) {
        const url = `https://movie.douban.com/people/${people}/${path}?start=${page * PER_PAGE}&sort=time&rating=all&filter=all&mode=grid`
        const { entries, hasNext } = parseCollectPage(await this.get(ctx, url, cookie), kind)
        pages++
        ctx.onProgress(Math.min(35, 2 + pages), `豆瓣${kind === 'watched' ? '看过' : '想看'}：第 ${page + 1} 页`)
        let reachedCursor = false
        for (const e of entries) {
          if (kind === 'watched') {
            latest ??= e.externalId
            if (stopAt && e.externalId === stopAt) {
              reachedCursor = true
              break
            }
          }
          fresh.push(e)
        }
        if (reachedCursor || !hasNext || !entries.length) break
      }
    }
    // 新条目不多时顺带取 IMDb 号
    const watched = fresh.filter((e) => e.listKind === 'watched')
    if (watched.length <= IMDB_LOOKUP_LIMIT) {
      for (const e of watched) {
        try {
          e.imdbId = parseImdbId(await this.get(ctx, `https://movie.douban.com/subject/${e.externalId}/`, cookie))
        } catch (err) {
          if (err instanceof DoubanBlockedError) throw err
        }
      }
    }
    this.nextCursor = { latest: latest ?? stopAt, pages }
    yield* fresh
  }
}
