/**
 * 策展引擎 CLI（M3 / 13 章）：打印概念、落地、审查、评分、排期、不变量、token 与缓存命中率。
 *
 *   pnpm curate --persona slow --days 3 --count 4 --mock
 *   pnpm curate --persona all --mock                  三个 fixture 画像各出 1 个影展 + 1 个单部推荐
 *   pnpm curate --user dev@local --days 3 --count 4    真实 Claude（需要 ANTHROPIC_API_KEY）
 *   pnpm curate ... --replay                           用 llm_calls 里录制的响应离线重放
 *   pnpm curate ... --dry                              不落库
 *
 * --persona 会把 fixture 画像与离线片目写进数据库（幂等），并强制使用离线片目代替 TMDB。
 */
import '@/lib/load-env'
import { parseArgs } from 'node:util'
import { createFestivalRequest } from '@/db/repo/festivals'
import { getUser, getUserByEmail } from '@/db/repo/users'
import { latestTasteProfile } from '@/db/repo/taste'
import { runMigrations } from '@/db/migrate'
import type { User } from '@/db/schema'
import { curate, persistCuration, type CurationResult } from '@/curator'
import { assembleContext, estimateTokens } from '@/curator/context'
import { checkInvariants } from '@/curator/invariants'
import { getDefaultAvailability } from '@/db/repo/availability'
import { llmConfigured, setTransport } from '@/llm/client'
import { cacheHitRate, type UsageTotals } from '@/llm/cost'
import { MockCuratorTransport } from '@/llm/mock-curator'
import { ReplayTransport } from '@/llm/replay'
import { setTmdbClient } from '@/resolver/tmdb'
import { addDays, currentWeekStart, DOW_ZH, minToHhmm } from '@/scheduler/slots'
import { buildTasteProfile } from '@/taste/profile'

const { values: args } = parseArgs({
  options: {
    persona: { type: 'string' },
    user: { type: 'string' },
    days: { type: 'string', default: '3' },
    count: { type: 'string', default: '4' },
    week: { type: 'string' },
    today: { type: 'string' },
    mock: { type: 'boolean', default: false },
    replay: { type: 'boolean', default: false },
    dry: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    'rebuild-memo': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
})

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
}
const pad = (s: string | number, n: number) => String(s).padEnd(n)
const h = (s: string) => console.log(`\n${C.bold('── ' + s + ' ' + '─'.repeat(Math.max(0, 60 - s.length)))}`)

function printUsage(u: UsageTotals, label: string) {
  const hit = cacheHitRate(u)
  const hitStr = `${(hit * 100).toFixed(1)}%`
  console.log(
    `${label}: ${u.calls} calls · input ${u.input_tokens} · cache_write ${u.cache_creation_input_tokens} · cache_read ${u.cache_read_input_tokens} · output ${u.output_tokens} · $${u.cost_usd.toFixed(4)} · hit ${hit >= 0.8 ? C.green(hitStr) : C.yellow(hitStr)}`,
  )
}

function report(r: CurationResult, user: User) {
  h('概念（Call A）')
  r.ideate.concepts.forEach((c, i) => {
    const s = c.self_scores
    console.log(`${i}. [${c.kind}] ${c.subject} — ${c.title}  ${C.dim(`fit ${s.taste_fit} nov ${s.novelty} coh ${s.coherence} amb ${s.ambition} · ${c.candidates.length} 候选`)}`)
  })
  h('落地（7.4）')
  for (const g of r.grounded) {
    const drops = g.dropped.map((d) => `${d.tmdb_id}:${d.reason}`).join(' ')
    const infeasible = g.candidates.filter((c) => c.infeasible).length
    console.log(`${g.index}. 保留 ${g.candidates.length}${infeasible ? `（${infeasible} 部排不下）` : ''}${g.insufficient ? C.red(' · 不足') : ''}${drops ? C.dim(' · 剔除 ' + drops) : ''}`)
  }
  console.log(C.dim(`幻觉剔除率 ${(r.dropRate * 100).toFixed(1)}%（> 30% 需要调 prompt / 工具）`))
  h('审查（Call B）与评分（7.6）')
  for (const t of [...r.trace].sort((a, b) => (b.score ?? -1) - (a.score ?? -1))) {
    const a = r.audited.find((x) => x.g.index === t.index)
    const kept = a ? a.audit.decisions.filter((d) => d.keep).length : 0
    const pen = Object.entries(t.penalties).map(([k, v]) => `-${v} ${k}`).join(' ')
    const bon = Object.entries(t.bonuses).map(([k, v]) => `+${v} ${k}`).join(' ')
    const mark = t.index === r.chosen.audited.g.index ? C.green('★') : ' '
    console.log(`${mark} ${pad(t.score?.toFixed(3) ?? '  —  ', 6)} [${t.kind}] ${t.subject} ${C.dim(`keep ${kept}`)} ${t.excluded ? C.red(t.excluded) : C.dim(`${pen} ${bon}`)}`)
  }
  if (r.relaxed) console.log(C.yellow('（放宽了「同 kind 连续两周」规则）'))
  h(r.mode === 'single' ? '本周一部' : '本周影展')
  console.log(`${C.bold(r.chosen.title)}  ${C.dim(`${r.chosen.kind} · ${r.chosen.subject}`)}`)
  console.log(r.chosen.statement)
  for (const s of r.chosen.slate) {
    const p = s.placement
    const when = p.date ? `${p.date} ${DOW_ZH[(new Date(p.date + 'T00:00:00Z').getUTCDay() + 6) % 7]} ${minToHhmm(p.start!)}` : C.red(`未排入：${p.unscheduledReason}`)
    const title = user.locale === 'zh-CN' ? (s.film.titleZh ?? s.film.titleEn) : s.film.titleEn
    console.log(`\n  ${s.position}. ${C.bold(title)} (${s.film.year}) · ${s.film.directors.map((d) => d.name).join(' & ')} · ${s.film.runtimeMin} 分钟 · ${s.role}`)
    console.log(`     ${when}`)
    console.log(`     ${C.dim(s.programNote)}`)
  }
  if (r.feasibility.notes.length) console.log(C.yellow(r.feasibility.notes.join('\n')))
  h('token / 缓存')
  printUsage(r.usage, '本次')
}

async function prepareUser(): Promise<User[]> {
  if (args.persona) {
    const { PERSONAS, seedCatalogFilms, seedPersona, fixtureClient } = await import('@/fixtures/seed')
    setTmdbClient(fixtureClient())
    const n = await seedCatalogFilms()
    console.log(C.dim(`离线片目：${n} 部（fixture 模式，不访问 TMDB）`))
    const list = args.persona === 'all' ? PERSONAS : PERSONAS.filter((p) => p.key === args.persona)
    if (!list.length) throw new Error(`没有这个 persona：${args.persona}（可选 ${PERSONAS.map((p) => p.key).join(' / ')} / all）`)
    return list.map((p) => seedPersona(p))
  }
  if (!args.user) throw new Error('需要 --persona 或 --user')
  const u = getUser(args.user) ?? getUserByEmail(args.user)
  if (!u) throw new Error(`用户不存在：${args.user}`)
  return [u]
}

async function runOne(user: User, filmCount: number, days: number): Promise<{ violations: string[]; usage: UsageTotals }> {
  // 画像：没有（或要求重建）就先建
  const profile = latestTasteProfile(user.id)
  if (!profile || args['rebuild-memo'] || (!profile.memo && llmConfigured())) {
    console.log(C.dim('生成品味画像…'))
    await buildTasteProfile(user.id, { log: (l) => console.log(C.dim(l)) })
  }
  const weekStart = args.week ?? addDays(currentWeekStart(user.tz), 7)
  const availability = getDefaultAvailability(user, weekStart)
  const ctx = assembleContext(user.id)
  h(`${user.name ?? user.email} · ${weekStart} 起一周 · ${filmCount} 部 / ${days} 天 · ${args.mock ? 'mock' : args.replay ? 'replay' : 'claude-opus-5-5'}`)
  console.log(
    C.dim(
      `system 块约 ${ctx.system.map((b) => estimateTokens(b.text)).join(' / ')} tokens · 看过 ${ctx.seen.size} 部 · watchlist ${ctx.watchlist.size} · memo ${ctx.memo ? '有' : '无（只有统计层）'}`,
    ),
  )
  const r = await curate({
    userId: user.id,
    weekStart,
    days,
    filmCount,
    availability,
    avoid: { kinds: [], subjects: [], tmdb_ids: [] },
    today: args.today,
    now: new Date(`${weekStart}T00:00:00Z`),
    log: (l) => console.log(C.dim(l)),
    progress: () => {},
  })
  if (args.json) console.log(JSON.stringify({ chosen: r.chosen, trace: r.trace, usage: r.usage }, null, 2))
  else report(r, user)
  const violations = checkInvariants(r, { seen: ctx.seen, n: filmCount, locale: user.locale, weekStart, prefs: availability.prefs })
  h('不变量')
  console.log(violations.length ? C.red(violations.join('\n')) : C.green('全部通过'))
  if (!args.dry) {
    const req = createFestivalRequest({
      userId: user.id,
      weekStart,
      days,
      filmCount,
      availabilitySnapshot: { mode: availability.mode, blocks: availability.blocks, prefs: availability.prefs, tz: availability.tz },
    })
    const saved = persistCuration(req.id, user.id, r)
    console.log(C.dim(`已保存影展 ${saved.festival.id}（--dry 不保存）`))
  }
  return { violations, usage: r.usage }
}

async function main() {
  if (args.help) {
    console.log(
      'pnpm curate (--persona slow|genre|sinophone|all | --user <id|email>) [--days 3] [--count 4] [--week YYYY-MM-DD] [--today YYYY-MM-DD] [--mock|--replay] [--dry] [--json] [--rebuild-memo]',
    )
    return
  }
  runMigrations()
  if (args.mock) setTransport(new MockCuratorTransport())
  else if (args.replay) setTransport(new ReplayTransport())
  else if (!llmConfigured()) throw new Error('没有 ANTHROPIC_API_KEY：用 --mock（离线桩）或 --replay（录制回放）')

  const users = await prepareUser()
  const days = Number(args.days)
  const count = Number(args.count)
  const all: string[] = []
  const totals: UsageTotals[] = []
  for (const u of users) {
    const runs = args.persona === 'all' ? [{ c: count, d: days }, { c: 1, d: 1 }] : [{ c: count, d: days }]
    for (const run of runs) {
      const res = await runOne(u, run.c, run.d)
      all.push(...res.violations.map((v) => `${u.email}: ${v}`))
      totals.push(res.usage)
    }
  }
  if (totals.length > 1) {
    h('合计')
    const sum = totals.reduce(
      (a, b) => ({
        calls: a.calls + b.calls,
        input_tokens: a.input_tokens + b.input_tokens,
        output_tokens: a.output_tokens + b.output_tokens,
        cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
        cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
        cost_usd: a.cost_usd + b.cost_usd,
      }),
    )
    printUsage(sum, '全部')
  }
  if (args.mock) console.log(C.yellow('\n注意：--mock 是离线桩，文本是占位、用量是模拟值；prompt 质量要用真实 Claude 评估。'))
  if (all.length) {
    console.error(C.red(`\n${all.length} 条不变量未通过`))
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(C.red(err instanceof Error ? err.message : String(err)))
  process.exit(1)
})
