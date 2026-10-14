/**
 * 豆瓣 subject id → Wikidata：精确拿到 TMDB / IMDb 编号、上映年份、是不是剧集。
 *
 *   P4529 豆瓣电影 ID · P4947 TMDB 电影 ID · P4983 TMDB 剧集 ID · P345 IMDb ID · P577 发行日期 · P31 类型
 *
 * 公开数据，按批（默认 150 个 id）查 SPARQL；只发豆瓣条目 id，不发任何用户信息。
 * 尽力而为：Wikidata 没收录、连不上、超时都不算错，匹配退回 TMDB 搜索。`WIKIDATA_LOOKUP=0` 关闭。
 */
import type { FetchLike } from '@/lib/http'

export type DoubanHint = { tmdbMovie?: number; imdb?: string; year?: number; tv: boolean }

export const WIKIDATA_SPARQL = 'https://query.wikidata.org/sparql'
const USER_AGENT = 'fest-of-one/0.1 (personal film diary; https://github.com/marc506/fest-of-one)'

/** 剧集类（电视剧、迷你剧、网剧、季、单集、电视节目、动画剧集） */
const TV_TYPES = new Set(['Q5398426', 'Q1259759', 'Q526877', 'Q3464665', 'Q21191270', 'Q15416', 'Q63952888', 'Q117467246'])

export function wikidataEnabled(): boolean {
  return process.env.WIKIDATA_LOOKUP !== '0'
}

export function buildQuery(ids: readonly string[]): string {
  const values = ids.filter((id) => /^\d+$/.test(id)).map((id) => `"${id}"`).join(' ')
  return `SELECT ?douban ?tmdb ?tmdbtv ?imdb ?date ?type WHERE {
  VALUES ?douban { ${values} }
  ?item wdt:P4529 ?douban .
  OPTIONAL { ?item wdt:P4947 ?tmdb }
  OPTIONAL { ?item wdt:P4983 ?tmdbtv }
  OPTIONAL { ?item wdt:P345 ?imdb }
  OPTIONAL { ?item wdt:P577 ?date }
  OPTIONAL { ?item wdt:P31 ?type }
}`
}

type Binding = Partial<Record<'douban' | 'tmdb' | 'tmdbtv' | 'imdb' | 'date' | 'type', { value: string }>>

/** SPARQL JSON 结果 → 每个豆瓣 id 一条提示（多行合并：年份取最早，类型取并集）。 */
export function parseBindings(json: { results?: { bindings?: Binding[] } }): Map<string, DoubanHint> {
  const acc = new Map<string, { movie: Set<number>; tv: Set<number>; imdb: Set<string>; years: number[]; types: Set<string> }>()
  for (const b of json.results?.bindings ?? []) {
    const id = b.douban?.value
    if (!id) continue
    const a = acc.get(id) ?? { movie: new Set(), tv: new Set(), imdb: new Set(), years: [], types: new Set() }
    const movie = Number(b.tmdb?.value)
    if (Number.isInteger(movie) && movie > 0) a.movie.add(movie)
    const tv = Number(b.tmdbtv?.value)
    if (Number.isInteger(tv) && tv > 0) a.tv.add(tv)
    if (b.imdb?.value && /^tt\d+$/.test(b.imdb.value)) a.imdb.add(b.imdb.value)
    const y = Number(b.date?.value.match(/^\+?(\d{4})-/)?.[1])
    if (y > 1880) a.years.push(y)
    const q = b.type?.value.split('/').at(-1)
    if (q) a.types.add(q)
    acc.set(id, a)
  }
  const out = new Map<string, DoubanHint>()
  for (const [id, a] of acc) {
    // 只在唯一时采信编号；同一豆瓣 id 对到多部片说明 Wikidata 那边有问题
    const tmdbMovie = a.movie.size === 1 ? [...a.movie][0] : undefined
    const isTv = !tmdbMovie && (a.tv.size > 0 || [...a.types].some((t) => TV_TYPES.has(t)))
    out.set(id, {
      tmdbMovie,
      imdb: a.imdb.size === 1 ? [...a.imdb][0] : undefined,
      year: a.years.length ? Math.min(...a.years) : undefined,
      tv: isTv,
    })
  }
  return out
}

export async function doubanHintsFromWikidata(
  ids: readonly string[],
  opts: { fetchImpl?: FetchLike; batch?: number; log?: (l: string) => void; timeoutMs?: number } = {},
): Promise<{ hints: Map<string, DoubanHint>; error: string | null }> {
  const f: FetchLike = opts.fetchImpl ?? ((i, init) => fetch(i, init))
  const batch = opts.batch ?? 150
  const hints = new Map<string, DoubanHint>()
  const unique = [...new Set(ids)].sort()
  for (let i = 0; i < unique.length; i += batch) {
    try {
      const res = await f(WIKIDATA_SPARQL, {
        method: 'POST',
        headers: { accept: 'application/sparql-results+json', 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
        body: new URLSearchParams({ query: buildQuery(unique.slice(i, i + batch)) }).toString(),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      for (const [id, h] of parseBindings(await res.json())) hints.set(id, h)
    } catch (err) {
      // 一批失败多半全部失败（连不上 / 被限流）：停下，剩下的交给 TMDB 搜索
      const msg = err instanceof Error ? err.message : String(err)
      opts.log?.(`[wikidata] lookup stopped after ${hints.size} hints: ${msg}`)
      return { hints, error: msg }
    }
  }
  return { hints, error: null }
}
