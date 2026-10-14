/**
 * 豆瓣导出没有年份、混着剧集：截断未来上映的候选、繁简统一、别名打分、唯一同名、识别剧集、Wikidata 编号、重新匹配。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAlias, libraryCounts, matchRate, matchStats, setAliasMatch, upsertAlias, upsertWatchEntry, upsertWatchlistEntry } from '@/db/repo/library'
import { createSource } from '@/db/repo/sources'
import { upsertUserByEmail } from '@/db/repo/users'
import { enqueueJob } from '@/jobs/queue'
import { drainQueue } from '@/jobs/worker'
import { CatalogTmdbClient, setTmdbClient, type CatalogTv } from '@/resolver/tmdb'
import { buildQuery, doubanHintsFromWikidata, parseBindings } from '@/resolver/wikidata'
import { currentWatchState } from '@/taste/profile'
import { f } from '../fixtures/catalog/build'
import { quiet } from '../helpers'

const FILMS = [
  f(9100001, 'Little Women', 'Little Women', '小妇人', 1994, 115, 'US', 'en', 'Drama', 'Gillian Armstrong', 'Winona Ryder', 'sisters', 7.3, 1500, 10),
  f(9100002, 'Little Women', 'Little Women', '小妇人', 2019, 135, 'US', 'en', 'Drama', 'Greta Gerwig', 'Saoirse Ronan', 'sisters', 7.8, 9000, 40),
  // 只有繁体原名、没有简体译名
  f(9100003, 'A Brighter Summer Day', '牯嶺街少年殺人事件', null, 1991, 237, 'TW', 'zh', 'Drama', 'Edward Yang', 'Chang Chen', 'taipei', 8.3, 600, 9),
  // TMDB 的简体译名与豆瓣不同，豆瓣的叫法只在别名里
  { ...f(9100004, 'As Tears Go By', '旺角卡門', '热血男儿', 1988, 102, 'HK', 'cn', 'Crime', 'Wong Kar-wai', 'Andy Lau', 'triad', 6.9, 300, 6), aka: ['旺角卡门'] },
  f(9100005, 'Demi-Gods and Semi-Devils', '天龍八部', '天龙八部', 1982, 90, 'HK', 'cn', 'Action', 'Somebody', 'Someone', 'wuxia', 5.5, 20, 1),
  f(9100006, 'Into the White Night', '白夜行', '白夜行', 2011, 149, 'JP', 'ja', 'Mystery', 'Yoshihiro Fukagawa', 'Maki Horikita', 'crime', 6.8, 200, 5),
]
const TV: CatalogTv[] = [
  { tmdb_id: 64010, name: '请回答1988', original_name: '응답하라 1988', year: 2015, vote_count: 300, popularity: 20 },
  { tmdb_id: 70001, name: '天龙八部', original_name: '天龍八部', year: 2003, vote_count: 100, popularity: 8 },
  { tmdb_id: 70002, name: '白夜行', original_name: '白夜行', year: 2006, vote_count: 300, popularity: 9 },
]

function seed(rows: { id: string; title: string; date?: string; wish?: boolean }[]) {
  const user = upsertUserByEmail('douban-match@test')
  const source = createSource({ userId: user.id, provider: 'douban', handle: '1', syncMode: 'upload' })
  const ids = new Map<string, number>()
  for (const r of rows) {
    const a = upsertAlias({ provider: 'douban', externalId: r.id, titleRaw: r.title })
    ids.set(r.id, a.id)
    if (r.wish) upsertWatchlistEntry({ userId: user.id, sourceId: source.id, aliasId: a.id, tmdbId: null, provider: 'douban' })
    else upsertWatchEntry({ userId: user.id, sourceId: source.id, aliasId: a.id, tmdbId: null, provider: 'douban', externalEntryId: `c${r.id}`, watchedAt: r.date ?? '2020-01-01' })
  }
  return { user, alias: (id: string) => getAlias(ids.get(id)!)! }
}

afterEach(() => {
  process.env.WIKIDATA_LOOKUP = '0'
  vi.unstubAllGlobals()
})

describe('matching year-less Douban entries', () => {
  it('resolves remakes by watch date, traditional titles, aliases, and recognises TV', async () => {
    setTmdbClient(new CatalogTmdbClient(FILMS, TV))
    const { user, alias } = seed([
      { id: '1', title: '小妇人', date: '2015-03-01' }, // 2019 版那时还没上映
      { id: '2', title: '小妇人', wish: true }, // 想看：没有日期约束 → 两部同名 → 待确认
      { id: '3', title: '牯岭街少年杀人事件' },
      { id: '4', title: '旺角卡门' },
      { id: '5', title: '请回答1988' },
      { id: '6', title: '绝命毒师 第一季' },
      { id: '7', title: '天龙八部' }, // 同名剧热度远高于同名片 → 剧集
      { id: '8', title: '白夜行' }, // 同名片与剧热度相当 → 待确认
    ])
    enqueueJob('enrich_films', {}, user.id)
    await drainQueue(quiet)

    expect(alias('1')).toMatchObject({ matchStatus: 'matched', tmdbId: 9100001 })
    expect(alias('2').matchStatus).toBe('ambiguous')
    expect(alias('2').candidates?.map((c) => c.tmdb_id).sort()).toEqual([9100001, 9100002])
    expect(alias('3')).toMatchObject({ matchStatus: 'matched', tmdbId: 9100003 })
    expect(alias('4')).toMatchObject({ matchStatus: 'matched', tmdbId: 9100004 })
    expect(alias('5').matchStatus).toBe('not_film')
    expect(alias('6').matchStatus).toBe('not_film')
    expect(alias('7').matchStatus).toBe('not_film')
    expect(alias('8').matchStatus).toBe('ambiguous')

    // 非电影：不进片库计数、不进匹配率分母、不进统计；在观影记录里单列标题
    const stats = matchStats(user.id)
    expect(stats.not_film).toBe(3)
    expect(matchRate(stats)).toBeCloseTo(3 / 4)
    expect(libraryCounts(user.id)).toMatchObject({ films: 4, notFilm: 3, unresolved: 2 })
    const state = currentWatchState(user.id)
    expect(state.films.map((x) => x.title)).not.toContain('请回答1988')
    expect(state.log.text).toContain('## Also logged, not films (3 TV series')
    expect(state.log.text).toContain('请回答1988')
  })

  it('rematch re-runs only the unresolved entries', async () => {
    setTmdbClient(new CatalogTmdbClient(FILMS, TV))
    const { user, alias } = seed([{ id: '3', title: '牯岭街少年杀人事件' }, { id: '5', title: '请回答1988' }])
    enqueueJob('enrich_films', {}, user.id)
    await drainQueue(quiet)
    // 模拟旧规则留下的待确认 + 用户已标的非电影
    setAliasMatch(alias('3').id, { status: 'ambiguous', tmdbId: null, confidence: 0.7, candidates: [] })
    setAliasMatch(alias('5').id, { status: 'not_film', tmdbId: null, confidence: null, candidates: null })
    const job = enqueueJob('enrich_films', { rematch: true }, user.id)
    await drainQueue(quiet)
    expect(alias('3')).toMatchObject({ matchStatus: 'matched', tmdbId: 9100003 })
    expect(alias('5').matchStatus).toBe('not_film')
    const { getJob } = await import('@/db/repo/jobs')
    expect(getJob(job.id)!.result).toMatchObject({ rematched: 1 })
  })
})

describe('Wikidata hints', () => {
  const sparql = (rows: Record<string, string>[]) => ({
    results: { bindings: rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, { value: v }]))) },
  })

  it('parses SPARQL bindings into one hint per Douban id', () => {
    const hints = parseBindings(
      sparql([
        { douban: '1', tmdb: '9100002', imdb: 'tt3281548', date: '2019-12-25T00:00:00Z', type: 'http://www.wikidata.org/entity/Q11424' },
        { douban: '1', tmdb: '9100002', imdb: 'tt3281548', date: '2019-09-07T00:00:00Z', type: 'http://www.wikidata.org/entity/Q11424' },
        { douban: '2', tmdbtv: '64010', type: 'http://www.wikidata.org/entity/Q5398426' },
        { douban: '3', date: '1991-07-27T00:00:00Z' },
      ]),
    )
    expect(hints.get('1')).toEqual({ tmdbMovie: 9100002, imdb: 'tt3281548', year: 2019, tv: false })
    expect(hints.get('2')).toMatchObject({ tv: true })
    expect(hints.get('3')).toEqual({ tmdbMovie: undefined, imdb: undefined, year: 1991, tv: false })
    expect(buildQuery(['1', '2', 'x"; DROP'])).toContain('VALUES ?douban { "1" "2" }')
  })

  it('uses exact ids, years and TV flags from Wikidata, and falls back when it is unreachable', async () => {
    setTmdbClient(new CatalogTmdbClient(FILMS, TV))
    const { user, alias } = seed([
      { id: '2', title: '小妇人', wish: true },
      { id: '8', title: '白夜行' },
      { id: '9', title: '小妇人', date: '2023-01-01' },
    ])
    process.env.WIKIDATA_LOOKUP = '1'
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push(String(init.body))
      return new Response(JSON.stringify(sparql([
        { douban: '2', tmdb: '9100002' },
        { douban: '8', tmdbtv: '70002' },
        { douban: '9', date: '1994-12-21T00:00:00Z' },
      ])), { status: 200 })
    })
    enqueueJob('enrich_films', {}, user.id)
    await drainQueue(quiet)
    expect(calls).toHaveLength(1)
    expect(alias('2')).toMatchObject({ matchStatus: 'matched', tmdbId: 9100002 })
    expect(alias('8').matchStatus).toBe('not_film')
    expect(alias('9')).toMatchObject({ matchStatus: 'matched', tmdbId: 9100001, yearRaw: 1994 })

    const down = await doubanHintsFromWikidata(['1'], { fetchImpl: async () => { throw new TypeError('fetch failed') } })
    expect(down).toEqual({ hints: new Map(), error: 'fetch failed' })
  })
})
