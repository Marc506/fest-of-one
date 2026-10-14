/**
 * 自检：`pnpm diagnose`
 * 检查 .env、代理、TMDB（令牌 + 中文片名搜索）、Wikidata（豆瓣编号查询）、Claude API（免费的模型列表请求）、数据库。只读，不花钱。
 */
import '@/lib/load-env'
import Anthropic from '@anthropic-ai/sdk'
import { getSqlite, resolveDbPath } from '@/db/client'
import { runMigrations } from '@/db/migrate'
import { explainError } from '@/lib/net-errors'
import { maskProxy, proxyUrl } from '@/lib/proxy'
import { MODEL } from '@/llm/client'
import { HttpTmdbClient } from '@/resolver/tmdb'
import { doubanHintsFromWikidata, wikidataEnabled } from '@/resolver/wikidata'

const ok = (s: string) => console.log(`\x1b[32m✓\x1b[0m ${s}`)
const bad = (s: string) => console.log(`\x1b[31m✗\x1b[0m ${s}`)
const info = (s: string) => console.log(`  ${s}`)
let failures = 0
const fail = (s: string) => {
  failures++
  bad(s)
}

async function main() {
  console.log('fest-of-one 自检\n')

  // 1. .env
  const e = process.env
  for (const k of ['AUTH_SECRET', 'ANTHROPIC_API_KEY', 'TMDB_READ_TOKEN'] as const) {
    if (e[k]) ok(`${k} 已设置`)
    else fail(`${k} 没有设置（.env）`)
  }
  // 复制时被打码 / 截断（· … * 空格、全角字符）的密钥：服务端只会回 401，看不出原因
  for (const k of ['AUTH_SECRET', 'ANTHROPIC_API_KEY', 'TMDB_READ_TOKEN', 'APP_ENCRYPTION_KEY'] as const) {
    const v = e[k]
    if (v && (/[^\x21-\x7e]/.test(v) || /\*{3,}|\.{3,}/.test(v)))
      fail(`${k} 里有 ·、…、*** 或空格之类的字符，多半是复制时被打码或截断了：从原网页重新复制完整的值`)
  }
  if (e.APP_ENCRYPTION_KEY) {
    if (Buffer.from(e.APP_ENCRYPTION_KEY, 'base64').length === 32) ok('APP_ENCRYPTION_KEY 是 32 字节')
    else fail('APP_ENCRYPTION_KEY 不是 32 字节的 base64（用 openssl rand -base64 32 生成）')
  }
  if (e.TMDB_READ_TOKEN && !e.TMDB_READ_TOKEN.startsWith('eyJ'))
    fail('TMDB_READ_TOKEN 看起来不是「API Read Access Token」（应以 eyJ 开头的长串，而不是 32 位的 API Key）')
  const proxy = proxyUrl()
  info(proxy ? `代理：${maskProxy(proxy)}` : '代理：未设置（在中国大陆通常需要设置 HTTPS_PROXY）')

  // 2. 数据库
  try {
    runMigrations()
    const db = getSqlite()
    db.prepare('select count(*) from users').get()
    ok(`数据库可用：${resolveDbPath()}`)
    const pending = db.prepare("select count(*) as n from film_aliases where match_status = 'pending'").get() as { n: number }
    if (pending.n) info(`待匹配 TMDB 的条目：${pending.n}`)
    const failed = db
      .prepare("select type, error, updated_at as at from jobs where status = 'failed' order by updated_at desc limit 3")
      .all() as { type: string; error: string | null; at: string }[]
    for (const j of failed) info(`最近失败的任务 ${j.type}（${j.at}）：${(j.error ?? '').split('\n')[0]}`)
  } catch (err) {
    fail(`数据库不可用：${err instanceof Error ? err.message : err}`)
  }

  // 3. TMDB
  if (e.TMDB_READ_TOKEN) {
    const tmdb = new HttpTmdbClient(e.TMDB_READ_TOKEN, undefined, { retries: 0 })
    try {
      const t0 = Date.now()
      await tmdb.movieGenres()
      ok(`TMDB 连通、令牌有效（${Date.now() - t0} ms）`)
      const r = await tmdb.searchMovie('花样年华', { language: 'zh-CN' })
      if (r[0]) ok(`TMDB 中文搜索正常：「花样年华」→ ${r[0].title}（${r[0].original_title}, ${r[0].release_date?.slice(0, 4)}）`)
      else fail('TMDB 中文搜索没有结果')
    } catch (err) {
      fail(explainError(err, 'TMDB'))
    }
  }

  // 4. Wikidata（豆瓣编号 → TMDB；可选，连不上只影响豆瓣匹配率）
  if (wikidataEnabled()) {
    const r = await doubanHintsFromWikidata(['1292052'], { timeoutMs: 20_000 })
    const h = r.hints.get('1292052')
    if (h?.tmdbMovie) ok(`Wikidata 可用：豆瓣 1292052（肖申克的救赎）→ TMDB ${h.tmdbMovie}`)
    else if (r.error) info(`Wikidata 连不上（${r.error}）：不影响使用，豆瓣条目会只靠 TMDB 搜索匹配`)
    else info('Wikidata 能连上，但没查到测试条目：豆瓣条目会只靠 TMDB 搜索匹配')
  }

  // 5. Claude API（列模型，不产生费用）
  if (e.ANTHROPIC_API_KEY) {
    try {
      const client = new Anthropic({ maxRetries: 0, timeout: 20_000 })
      const m = await client.models.retrieve(MODEL)
      ok(`Claude API 连通，可用模型 ${m.id}`)
    } catch (err) {
      fail(explainError(err, 'Claude API'))
    }
  }

  console.log(failures ? `\n${failures} 项有问题，按上面的提示修好后再运行 pnpm diagnose。` : '\n全部正常。')
  process.exitCode = failures ? 1 : 0
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
