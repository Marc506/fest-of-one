import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import AdmZip from 'adm-zip'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { libraryCounts, listLibrary, seenTmdbIds } from '@/db/repo/library'
import { createSource, getSource } from '@/db/repo/sources'
import { upsertUserByEmail } from '@/db/repo/users'
import { enqueueJob } from '@/jobs/queue'
import { drainQueue } from '@/jobs/worker'
import { decryptSecret, encryptSecret } from '@/lib/crypto'
import { CatalogTmdbClient, setTmdbClient } from '@/resolver/tmdb'
import { doubanRating10, parseDoubanCsv, parseDoubanXlsx } from '@/sources/douban-csv'
import { DoubanBlockedError, parseCollectPage, parseImdbId } from '@/sources/douban-scrape'
import { parseLetterboxdRss } from '@/sources/letterboxd-rss'
import { enqueueDueRssSyncs } from '@/sources/schedule'
import { saveUpload } from '@/sources/uploads'
import { currentWatchState } from '@/taste/profile'
import { FIXTURES, miniCatalog, quiet, zipFolder } from '../helpers'

const fx = (name: string) => readFileSync(join(FIXTURES, name), 'utf8')
process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
process.env.DOUBAN_DELAY_MS = '0'

/** 最小 xlsx（inlineStr），测试 Excel 路径用。 */
function xlsx(sheets: { name: string; rows: string[][] }[]): Buffer {
  const zip = new AdmZip()
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
  const col = (i: number) => String.fromCharCode(65 + i)
  zip.addFile(
    '[Content_Types].xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`,
    ),
  )
  zip.addFile('_rels/.rels', Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`))
  zip.addFile(
    'xl/workbook.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets.map((s, i) => `<sheet name="${s.name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    ),
  )
  zip.addFile(
    'xl/_rels/workbook.xml.rels',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
    ),
  )
  sheets.forEach((s, i) => {
    const rows = s.rows
      .map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => `<c r="${col(ci)}${ri + 1}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`).join('')}</row>`)
      .join('')
    zip.addFile(`xl/worksheets/sheet${i + 1}.xml`, Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`))
  })
  return zip.toBuffer()
}

afterEach(() => {
  vi.unstubAllGlobals()
  setTmdbClient(undefined)
})

describe('Douban export parsing (5.3)', () => {
  it('maps ratings: words and stars ×2', () => {
    expect([doubanRating10('力荐'), doubanRating10('推荐'), doubanRating10('还行'), doubanRating10('较差'), doubanRating10('很差')]).toEqual([10, 8, 6, 4, 2])
    expect(doubanRating10('3')).toBe(6)
    expect([doubanRating10('★'), doubanRating10('★★★'), doubanRating10('★★★★★'), doubanRating10('★★★☆☆')]).toEqual([2, 6, 10, 6])
    expect(doubanRating10('')).toBeUndefined()
  })

  it('parses CSV by column names: subject ids, status, dates, years, tags, comments', () => {
    const es = parseDoubanCsv(fx('douban-export.csv'))
    const by = (id: string) => es.find((e) => e.externalId === id)!
    expect(es).toHaveLength(6) // 「在看」跳过
    expect(by('1291557')).toMatchObject({ title: '花样年华 / 花樣年華', year: 2000, rating10: 10, watchedAt: '2023-02-10', listKind: 'watched', review: '旗袍、走廊、雨。', tags: ['王家卫', '香港'] })
    expect(by('1293035').rating10).toBe(6)
    expect(by('1292207')).toMatchObject({ listKind: 'watchlist', entryId: 'douban:wish:1292207' })
    expect(() => parseDoubanCsv('foo,bar\n1,2')).toThrow(/标题/)
  })

  it('parses the douban-frodo-export 影视.csv format (BOM, ★ ratings, 看过 / 在看 / 想看)', () => {
    const csv =
      '\uFEFFtitle,url,date,rating,status,comment\n' +
      '花样年华,https://movie.douban.com/subject/1291557/,2023-02-10,★★★★★,看过,旗袍\n' +
      '某部剧,https://movie.douban.com/subject/30000001/,2024-05-01,,在看,\n' +
      '悲情城市,https://movie.douban.com/subject/1292207/,2024-01-02,,想看,\n' +
      '人鬼情未了,https://movie.douban.com/subject/1291833/,2020-01-01,★★,看过,\n'
    const es = parseDoubanCsv(csv)
    expect(es.map((e) => [e.externalId, e.listKind, e.rating10, e.watchedAt])).toEqual([
      ['1291557', 'watched', 10, '2023-02-10'],
      ['1292207', 'watchlist', undefined, undefined],
      ['1291833', 'watched', 4, '2020-01-01'],
    ])
  })

  it('parses Excel with one sheet per status', async () => {
    const es = await parseDoubanXlsx(
      xlsx([
        { name: '看过', rows: [['标题', '个人评分', '打分日期', '我的短评', '上映日期', '条目链接'], ['一一', '5', '2022-11-05', '好', '2000', 'https://movie.douban.com/subject/1292434/']] },
        { name: '想看', rows: [['标题', '条目链接'], ['悲情城市', 'https://movie.douban.com/subject/1292207/']] },
      ]),
    )
    expect(es.map((e) => [e.externalId, e.listKind, e.rating10])).toEqual([
      ['1292434', 'watched', 10],
      ['1292207', 'watchlist', undefined],
    ])
  })
})

describe('Douban scraping (5.3)', () => {
  it('parses a collect page and a subject page', () => {
    const { entries, hasNext } = parseCollectPage(fx('douban-collect.html'), 'watched')
    expect(hasNext).toBe(true)
    expect(entries.map((e) => [e.externalId, e.title, e.year, e.rating10, e.watchedAt])).toEqual([
      ['1291557', '花样年华 / 花樣年華 / In the Mood for Love', 2000, 10, '2023-02-10'],
      ['1292343', '潜行者 / Сталкер / Stalker', 1979, undefined, '2022-08-01'],
    ])
    expect(entries[0]!.tags).toEqual(['王家卫', '香港'])
    expect(parseImdbId(fx('douban-subject.html'))).toBe('tt0118694')
  })

  it('encrypts cookies at rest', () => {
    const enc = encryptSecret('dbcl2="abc"; ck=xyz')
    expect(enc).toMatch(/^v1:/)
    expect(enc).not.toContain('abc')
    expect(decryptSecret(enc)).toBe('dbcl2="abc"; ck=xyz')
  })

  it('scrapes collect + wish with cookie, rate-limited, stops at the cursor next time, and stops on verification pages', async () => {
    setTmdbClient(new CatalogTmdbClient(miniCatalog()))
    const user = upsertUserByEmail('douban@test')
    const source = createSource({ userId: user.id, provider: 'douban', handle: 'someone', syncMode: 'scrape', authEnc: encryptSecret('dbcl2=1') })
    const calls: string[] = []
    let blocked = false
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push(url)
      expect(new Headers(init?.headers).get('cookie')).toBe('dbcl2=1')
      if (blocked) return new Response('<title>登录豆瓣</title>', { status: 200, headers: { 'content-type': 'text/html' } })
      if (url.includes('/subject/')) return new Response(fx('douban-subject.html'))
      if (url.includes('/collect') && url.includes('start=0')) return new Response(fx('douban-collect.html'))
      return new Response('<div class="grid-view"></div>')
    })
    enqueueJob('sync_source', { source_id: source.id, full: false }, user.id)
    await drainQueue(quiet)
    expect(seenTmdbIds(user.id)).toEqual(new Set([843, 1398]))
    expect(getSource(source.id)!.cursor).toMatchObject({ latest: '1291557' })
    expect(calls.some((u) => u.includes('/wish?start=0'))).toBe(true)

    // 第二次：第一页的第一条就是游标 → 不再翻页
    calls.length = 0
    enqueueJob('sync_source', { source_id: source.id, full: false }, user.id)
    await drainQueue(quiet)
    expect(calls.filter((u) => u.includes('/collect'))).toHaveLength(1)

    blocked = true
    const job = enqueueJob('sync_source', { source_id: source.id, full: false }, user.id)
    await drainQueue(quiet)
    const { getJob } = await import('@/db/repo/jobs')
    expect(getJob(job.id)!.status).toBe('failed')
    expect(getJob(job.id)!.error).toMatch(/重新提供 Cookie 或改用上传/)
    expect(getSource(source.id)!.lastError).toMatch(/Cookie/)
    expect(new DoubanBlockedError('x').userFacing).toBe(true)
  }, 60_000)
})

describe('Letterboxd RSS (5.2)', () => {
  it('parses diary items, skips lists, extracts review text', () => {
    const es = parseLetterboxdRss(fx('letterboxd-rss.xml'))
    expect(es.map((e) => e.entryId)).toEqual(['letterboxd-review-900003', 'letterboxd-watch-900002', 'letterboxd-watch-900001'])
    expect(es[0]).toMatchObject({ tmdbId: 30020, rating10: 9, liked: true, watchedAt: '2026-10-11', review: 'The hills, the car, the dust — and then that ending.' })
    expect(es[1]).toMatchObject({ rewatch: true, review: undefined })
    expect(es[2]!.rating10).toBeUndefined()
  })

  it('ZIP + RSS: same viewing recorded once; repeated RSS syncs add nothing; schedule enqueues due feeds', async () => {
    setTmdbClient(new CatalogTmdbClient(miniCatalog()))
    const user = upsertUserByEmail('rss@test')
    const zipSource = createSource({ userId: user.id, provider: 'letterboxd', handle: 'export', syncMode: 'upload' })
    const path = saveUpload(user.id, zipSource.id, '.zip', zipFolder(join(FIXTURES, 'letterboxd-export')))
    enqueueJob('sync_source', { source_id: zipSource.id, upload_path: path, full: true }, user.id)
    await drainQueue(quiet)
    const before = libraryCounts(user.id)

    let feed = fx('letterboxd-rss.xml')
    vi.stubGlobal('fetch', async () => new Response(feed))
    const rss = createSource({ userId: user.id, provider: 'letterboxd', handle: 'someone', syncMode: 'rss' })
    enqueueJob('sync_source', { source_id: rss.id, full: false }, user.id)
    await drainQueue(quiet)
    // 新增 Taste of Cherry；Parasite 2024-08-30 与 Stalker 2023-03-31 已在 ZIP 里 → 不重复
    expect(libraryCounts(user.id)).toMatchObject({ entries: before.entries + 1, films: before.films + 1 })
    expect(getSource(rss.id)!.cursor).toEqual({ guid: 'letterboxd-review-900003' })
    const parasite = currentWatchState(user.id).films.find((f) => f.tmdbId === 496243)!
    expect(parasite.views).toBe(2) // 两个不同的观看日期

    enqueueJob('sync_source', { source_id: rss.id, full: false }, user.id)
    await drainQueue(quiet)
    expect(libraryCounts(user.id).entries).toBe(before.entries + 1)

    // 新的一条出现在 feed 顶部 → 只加这一条
    feed = feed.replace('<item>', `<item><title>Yi Yi</title><guid isPermaLink="false">letterboxd-watch-900004</guid><letterboxd:watchedDate>2026-10-12</letterboxd:watchedDate><letterboxd:filmTitle>Yi Yi</letterboxd:filmTitle><letterboxd:filmYear>2000</letterboxd:filmYear><tmdb:movieId>25538</tmdb:movieId><description></description></item><item>`)
    enqueueJob('sync_source', { source_id: rss.id, full: false }, user.id)
    await drainQueue(quiet)
    expect(libraryCounts(user.id).entries).toBe(before.entries + 2)
    expect(currentWatchState(user.id).films.find((f) => f.tmdbId === 25538)!.views).toBe(1)

    expect(enqueueDueRssSyncs(Date.now())).toBe(0)
    expect(enqueueDueRssSyncs(Date.now() + 13 * 3600_000)).toBe(1)
    expect(enqueueDueRssSyncs(Date.now() + 13 * 3600_000)).toBe(0) // 已在队列中
  }, 60_000)
})

describe('cross-source merge (M6 acceptance)', () => {
  it('the same film from Letterboxd and Douban merges into one TMDB record', async () => {
    setTmdbClient(new CatalogTmdbClient(miniCatalog()))
    const user = upsertUserByEmail('merge@test')
    const lb = createSource({ userId: user.id, provider: 'letterboxd', handle: 'export', syncMode: 'upload' })
    enqueueJob('sync_source', { source_id: lb.id, upload_path: saveUpload(user.id, lb.id, '.zip', zipFolder(join(FIXTURES, 'letterboxd-export'))), full: true }, user.id)
    const db = createSource({ userId: user.id, provider: 'douban', handle: 'export', syncMode: 'upload' })
    enqueueJob('sync_source', { source_id: db.id, upload_path: saveUpload(user.id, db.id, '.csv', Buffer.from(fx('douban-export.csv'))), full: true }, user.id)
    await drainQueue(quiet)

    const mood = listLibrary(user.id, { q: 'mood' }).rows
    expect(mood).toHaveLength(1)
    expect(mood[0]).toMatchObject({ tmdbId: 843, views: 1 })
    expect(mood[0]!.providers.sort()).toEqual(['douban', 'letterboxd'])
    const crouching = listLibrary(user.id, { q: 'crouching' }).rows
    expect(crouching).toHaveLength(1)
    expect(crouching[0]!.providers.sort()).toEqual(['douban', 'letterboxd'])
    // 豆瓣独有的未匹配条目留在「待确认」
    expect(libraryCounts(user.id).unresolved).toBeGreaterThanOrEqual(1)
  }, 60_000)
})
