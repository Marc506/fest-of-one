/**
 * Letterboxd RSS（5.2 rss 模式，增量）：https://letterboxd.com/{username}/rss/ ，约最近 50 条 diary。
 * 每条带 tmdb:movieId，可直接匹配（resolver 第 1 步）。游标 = 最新 guid。
 * 注意：只在影片页打星、没写 diary 的评分不会出现在 RSS。
 * 影片键用 `letterboxd:tmdb:{id}`（RSS 没有 boxd.it 影片链接）；与 ZIP 导入的同一部片在 tmdb_id 层合并，
 * 同一次观看（同 tmdb_id + 同观看日期）不会重复记录（见 sync 的 dedupeViewings）。
 */
import * as cheerio from 'cheerio'
import { starsToRating10, type AdapterCtx, type RawEntry, type SourceAdapter } from './types'

export function rssUrl(username: string): string {
  return `https://letterboxd.com/${encodeURIComponent(username.trim().replace(/^@/, ''))}/rss/`
}

function reviewText(descriptionHtml: string): string | undefined {
  const $ = cheerio.load(descriptionHtml)
  const paras = $('p')
    .toArray()
    .map((p) => $(p).text().trim())
    .filter((t) => t && !/^Watched on /i.test(t) && !/^This review may contain spoilers/i.test(t))
  const text = paras.join('\n\n').trim()
  return text || undefined
}

export function parseLetterboxdRss(xml: string): RawEntry[] {
  const $ = cheerio.load(xml, { xmlMode: true })
  const out: RawEntry[] = []
  $('item').each((_, el) => {
    const it = $(el)
    const t = (sel: string) => it.find(sel).first().text().trim() || undefined
    const title = t('letterboxd\\:filmTitle')
    const tmdbId = Number(t('tmdb\\:movieId'))
    const guid = t('guid')
    if (!title || !guid) return // 列表等非影片条目
    const rating = Number(t('letterboxd\\:memberRating'))
    out.push({
      provider: 'letterboxd',
      externalId: Number.isInteger(tmdbId) && tmdbId > 0 ? `letterboxd:tmdb:${tmdbId}` : `letterboxd:rss:${t('link') ?? guid}`,
      entryId: guid,
      title,
      year: Number(t('letterboxd\\:filmYear')) || undefined,
      tmdbId: Number.isInteger(tmdbId) && tmdbId > 0 ? tmdbId : undefined,
      watchedAt: t('letterboxd\\:watchedDate'),
      loggedAt: t('pubDate') ? new Date(t('pubDate')!).toISOString().slice(0, 10) : undefined,
      rating10: Number.isFinite(rating) ? starsToRating10(rating) : undefined,
      rewatch: /^yes$/i.test(t('letterboxd\\:rewatch') ?? ''),
      liked: /^yes$/i.test(t('letterboxd\\:memberLike') ?? ''),
      review: reviewText(t('description') ?? ''),
      listKind: 'watched',
      raw: { guid, link: t('link') },
    })
  })
  return out
}

export class LetterboxdRssAdapter implements SourceAdapter {
  readonly provider = 'letterboxd' as const
  readonly mode = 'rss' as const
  nextCursor: { guid: string | null } | undefined

  async *fetchAll(ctx: AdapterCtx): AsyncIterable<RawEntry> {
    yield* this.run(ctx, null)
  }

  async *fetchIncremental(ctx: AdapterCtx, cursor: unknown): AsyncIterable<RawEntry> {
    yield* this.run(ctx, (cursor as { guid?: string } | null)?.guid ?? null)
  }

  private async *run(ctx: AdapterCtx, stopAt: string | null): AsyncIterable<RawEntry> {
    ctx.onProgress(5, '读取 Letterboxd RSS…')
    const res = await ctx.http(rssUrl(ctx.account.handle), { headers: { 'user-agent': 'fest-of-one/1.0 (+personal film diary sync)' } })
    if (res.status === 404) throw Object.assign(new Error(`Letterboxd 用户不存在：${ctx.account.handle}`), { userFacing: true })
    if (!res.ok) throw new Error(`Letterboxd RSS 请求失败：HTTP ${res.status}`)
    const items = parseLetterboxdRss(await res.text())
    const fresh: RawEntry[] = []
    for (const e of items) {
      if (stopAt && e.entryId === stopAt) break
      fresh.push(e)
    }
    this.nextCursor = { guid: items[0]?.entryId ?? stopAt }
    ctx.log(`rss: ${items.length} items, ${fresh.length} new`)
    yield* fresh
  }
}
