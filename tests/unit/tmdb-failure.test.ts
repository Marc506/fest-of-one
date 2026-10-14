/**
 * TMDB 不可用时：错误要说清原因（网络 / 令牌），enrich_films 快速失败、不重排队、不逐条硬撑。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getJob } from '@/db/repo/jobs'
import { matchStats, upsertAlias, upsertWatchEntry } from '@/db/repo/library'
import { createSource } from '@/db/repo/sources'
import { upsertUserByEmail } from '@/db/repo/users'
import { enqueueJob } from '@/jobs/queue'
import { drainQueue } from '@/jobs/worker'
import { HttpError } from '@/lib/http'
import { explainError } from '@/lib/net-errors'
import { HttpTmdbClient, setTmdbClient } from '@/resolver/tmdb'
import { quiet } from '../helpers'

function netError(code: string) {
  return new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) })
}

function seedDoubanUser(n: number) {
  const user = upsertUserByEmail('tmdb-down@test')
  const source = createSource({ userId: user.id, provider: 'douban', handle: '1', syncMode: 'upload' })
  for (let i = 0; i < n; i++) {
    const a = upsertAlias({ provider: 'douban', externalId: String(1000 + i), titleRaw: `片${i}`, yearRaw: 2000 })
    upsertWatchEntry({ userId: user.id, sourceId: source.id, aliasId: a.id, tmdbId: null, provider: 'douban', externalEntryId: `w${i}` })
  }
  return user
}

const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'] as const
let savedProxy: Record<string, string | undefined> = {}
beforeEach(() => {
  savedProxy = Object.fromEntries(PROXY_VARS.map((k) => [k, process.env[k]]))
  for (const k of PROXY_VARS) delete process.env[k]
})
afterEach(() => {
  for (const k of PROXY_VARS) if (savedProxy[k] === undefined) delete process.env[k]
  else process.env[k] = savedProxy[k]
})

describe('explainError', () => {
  it('turns DNS / connect failures into a proxy hint', () => {
    const msg = explainError(netError('ENOTFOUND'), 'TMDB')
    expect(msg).toContain('连不上 api.themoviedb.org（ENOTFOUND）')
    expect(msg).toContain('HTTPS_PROXY=')
  })

  it('says the configured proxy is not working (without leaking credentials)', () => {
    process.env.HTTPS_PROXY = 'http://me:secret@127.0.0.1:7890'
    const msg = explainError(netError('ECONNREFUSED'), 'TMDB')
    expect(msg).toContain('已经设置了代理 http://***@127.0.0.1:7890')
    expect(msg).not.toContain('secret')
  })

  it('points a TMDB 401 at the read access token', () => {
    expect(explainError(new HttpError(401, 'u', ''), 'TMDB')).toContain('TMDB_READ_TOKEN')
  })

  it('keeps the original message for anything else', () => {
    expect(explainError(new Error('boom'), 'TMDB')).toBe('TMDB 请求失败：boom')
  })
})

describe('enrich_films when TMDB is unreachable', () => {
  it('fails on the preflight with an actionable message, without requeueing', async () => {
    let calls = 0
    setTmdbClient(new HttpTmdbClient('tok', async () => {
      calls++
      throw netError('ENOTFOUND')
    }, { retries: 0 }))
    const user = seedDoubanUser(3)
    const job = enqueueJob('enrich_films', {}, user.id)
    await drainQueue(quiet)
    const j = getJob(job.id)!
    expect(j.status).toBe('failed')
    expect(j.attempts).toBe(1)
    expect(j.error).toContain('连不上 api.themoviedb.org')
    expect(calls).toBe(1)
    expect(matchStats(user.id).pending).toBe(3)
  })

  it('stops after the first 20 alias lookups all fail and reports the first error', async () => {
    let searches = 0
    setTmdbClient(new HttpTmdbClient('tok', async (input) => {
      if (String(input).includes('/genre/movie/list')) return new Response('{"genres":[]}', { status: 200 })
      searches++
      return new Response('nope', { status: 500 })
    }, { retries: 0 }))
    const user = seedDoubanUser(60)
    const job = enqueueJob('enrich_films', {}, user.id)
    await drainQueue(quiet)
    const j = getJob(job.id)!
    expect(j.status).toBe('failed')
    expect(j.error).toContain('匹配 TMDB 失败：TMDB 返回 HTTP 500')
    expect(j.error).toContain('重新同步')
    // 并发 4：中止时最多再多跑几条，远少于 60 条 × 2 次搜索
    expect(searches).toBeLessThan(30)
  })
})
