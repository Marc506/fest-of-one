/**
 * 限速 fetch：并发上限 + 最小请求间隔 + 429/5xx 指数退避（尊重 Retry-After）。
 * 用于 TMDB、Letterboxd RSS、豆瓣抓取。
 */
import { sleep } from './time'

export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>

export type RateLimitedFetchOptions = {
  /** 同时在途的请求数上限 */
  concurrency?: number
  /** 两次请求开始之间的最小间隔（ms）；可给函数返回随机间隔（豆瓣 2–4s） */
  minIntervalMs?: number | (() => number)
  /** 429 / 5xx / 网络错误最多重试次数 */
  retries?: number
  baseBackoffMs?: number
  userAgent?: string
  fetchImpl?: FetchLike
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} for ${url}`)
  }
}

export function createRateLimitedFetch(opts: RateLimitedFetchOptions = {}): FetchLike {
  const concurrency = opts.concurrency ?? 4
  const retries = opts.retries ?? 4
  const base = opts.baseBackoffMs ?? 1000
  const doFetch: FetchLike = opts.fetchImpl ?? ((i, init) => fetch(i, init))
  const interval = typeof opts.minIntervalMs === 'function' ? opts.minIntervalMs : () => (opts.minIntervalMs as number) ?? 0

  let active = 0
  const waiters: (() => void)[] = []
  let nextStart = 0

  async function acquire() {
    if (active >= concurrency) await new Promise<void>((r) => waiters.push(r))
    active++
    const now = Date.now()
    const wait = Math.max(0, nextStart - now)
    nextStart = Math.max(now, nextStart) + interval()
    if (wait > 0) await sleep(wait)
  }
  function release() {
    active--
    waiters.shift()?.()
  }

  return async (input, init) => {
    const headers = new Headers(init?.headers)
    if (opts.userAgent && !headers.has('user-agent')) headers.set('user-agent', opts.userAgent)
    for (let attempt = 0; ; attempt++) {
      await acquire()
      let res: Response | undefined
      let netErr: unknown
      try {
        res = await doFetch(input, { ...init, headers })
      } catch (err) {
        netErr = err
      } finally {
        release()
      }
      const retryable = netErr !== undefined || (res && (res.status === 429 || res.status >= 500))
      if (!retryable || attempt >= retries) {
        if (netErr) throw netErr
        return res!
      }
      const retryAfter = Number(res?.headers.get('retry-after'))
      const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : base * 2 ** attempt
      await sleep(delay)
    }
  }
}

export async function getJson<T>(f: FetchLike, url: string, init?: RequestInit): Promise<T> {
  const res = await f(url, init)
  if (!res.ok) throw new HttpError(res.status, url, await res.text().catch(() => ''))
  return (await res.json()) as T
}

/** 并发受限的 map（保持输入顺序）。 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i]!, i)
    }
  })
  await Promise.all(workers)
  return out
}
