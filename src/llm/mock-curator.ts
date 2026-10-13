/**
 * 离线「模拟策展人」transport —— 不是 LLM，只是一个读得懂我们自己 prompt 结构的确定性桩：
 *
 * - taste_memo：从 system[1] 的统计里拼一份备忘。
 * - ideate：第一轮按统计发出 get_filmography / discover_films 工具调用；拿到结果后，
 *   用未看过、片长放得下的片拼 4–6 个概念（导演 / 演员 / 国别 / 母题）。
 * - audit：从 system[3] 的概念块里保留非 infeasible、非一次性商业片的候选，按年份排出 slate。
 * - 用量：按「工具 + system 前缀 + 消息断点」的字节哈希模拟 prompt caching，
 *   因此可以离线检查前缀是否稳定（热态命中率）。
 *
 * 用途：`pnpm curate --mock`、流水线不变量测试。文本是中文占位，**不代表真实策展质量**。
 */
import { createHash } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
import type { CreateParams, LlmTransport, ParseParams, ParsedResult } from './client'

type Json = Record<string, unknown>
type Stats = {
  directors: { name: string; n: number; avg10: number | null; evidence: number[] }[]
  actors: { name: string; n: number; avg10: number | null }[]
  countries: { code: string; n: number; avg10: number | null }[]
  decades: { decade: number; n: number; avg10: number | null }[]
  keywords: { kw: string; n: number }[]
  loved: number[]
  disliked: number[]
  register: { share_high_popularity: number; share_festival_core: number }
  pace_per_week: number
  runtime_tolerance_p90: number | null
  counts: { films: number }
}

const COUNTRY_ZH: Record<string, string> = {
  TW: '台湾',
  HK: '香港',
  CN: '中国大陆',
  JP: '日本',
  KR: '韩国',
  FR: '法国',
  IT: '意大利',
  IR: '伊朗',
  US: '美国',
  SU: '苏联',
  RU: '俄罗斯',
  DE: '德国',
  GB: '英国',
  TH: '泰国',
  BE: '比利时',
  HU: '匈牙利',
  GR: '希腊',
  TR: '土耳其',
  PT: '葡萄牙',
  AR: '阿根廷',
  FI: '芬兰',
}

const textOf = (c: Anthropic.MessageParam['content']): string =>
  typeof c === 'string'
    ? c
    : c
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('\n')

function tokens(s: string): number {
  const cjk = (s.match(/[㐀-鿿]/g) ?? []).length
  return Math.max(1, Math.round((s.length - cjk) / 4 + cjk / 1.5))
}

function stripCache(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(stripCache)
  if (x && typeof x === 'object') {
    const o: Json = {}
    for (const [k, v] of Object.entries(x as Json)) if (k !== 'cache_control') o[k] = stripCache(v)
    return o
  }
  return x
}

function parseStats(system: Anthropic.TextBlockParam[]): Stats {
  const block = system.find((b) => b.text.includes('## Stats\n'))?.text ?? ''
  return JSON.parse(block.slice(block.indexOf('## Stats\n') + 9)) as Stats
}

function message(content: Anthropic.ContentBlock[], stop: Anthropic.Message['stop_reason'], usage: Anthropic.Usage): Anthropic.Message {
  return { id: `msg_mock_${Math.random().toString(36).slice(2, 10)}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason: stop, stop_sequence: null, usage } as Anthropic.Message
}

export class MockCuratorTransport implements LlmTransport {
  readonly name = 'mock'
  private readonly cache = new Set<string>()

  /** 模拟 prompt caching：返回 usage。 */
  private usage(params: CreateParams, outText: string): Anthropic.Usage {
    const pieces: { text: string; breakpoint: boolean }[] = []
    pieces.push({ text: JSON.stringify(params.tools ?? []), breakpoint: false })
    for (const b of (params.system as Anthropic.TextBlockParam[]) ?? []) pieces.push({ text: b.text, breakpoint: Boolean(b.cache_control) })
    for (const m of params.messages) {
      const content = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content
      const hasBp = (content as Json[]).some((b) => b.cache_control)
      pieces.push({ text: JSON.stringify(stripCache(m)), breakpoint: hasBp })
    }
    // 每个块边界的累计哈希；读缓存可以落在「之前任何一次请求写过断点」的边界上（真实 API 有 20 块回看窗口）
    const h = createHash('sha256')
    let cum = 0
    let read = 0
    let lastBp = 0
    const newKeys: string[] = []
    const boundaries: { key: string; cum: number; bp: boolean }[] = []
    for (const p of pieces) {
      h.update(p.text)
      cum += tokens(p.text)
      boundaries.push({ key: h.copy().digest('hex'), cum, bp: p.breakpoint })
      if (p.breakpoint) lastBp = cum
    }
    for (const b of boundaries) {
      if (b.cum > lastBp) break
      if (this.cache.has(b.key)) read = b.cum
      else if (b.bp) newKeys.push(b.key)
    }
    for (const k of newKeys) this.cache.add(k)
    const write = Math.max(0, lastBp - read)
    return {
      input_tokens: Math.max(0, cum - read - write),
      cache_creation_input_tokens: write,
      cache_read_input_tokens: read,
      output_tokens: tokens(outText) + 200,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: write },
    } as Anthropic.Usage
  }

  async create(params: CreateParams): Promise<Anthropic.Message> {
    const system = (params.system ?? []) as Anthropic.TextBlockParam[]
    const firstUser = textOf(params.messages[0]!.content)
    let content: Anthropic.ContentBlock[]
    let stop: Anthropic.Message['stop_reason'] = 'end_turn'
    if (system.length === 4 && system[3]!.text.includes('## Programme under review')) {
      content = [this.text(JSON.stringify(this.audit(system, firstUser)))]
    } else if (params.tools?.length) {
      const r = this.ideate(params, system, firstUser)
      content = r.content
      stop = r.stop
    } else if (firstUser.includes('This time you are not programming')) {
      content = [this.text(JSON.stringify(this.memo(system)))]
    } else {
      content = [this.text('{}')]
    }
    const out = content.map((b) => (b.type === 'text' ? b.text : JSON.stringify((b as Anthropic.ToolUseBlock).input))).join('')
    return message(content, stop, this.usage(params, out))
  }

  async parse<T>(params: ParseParams<T>): Promise<ParsedResult<T>> {
    const res = await this.create(params as unknown as CreateParams)
    const text = res.content.find((b): b is Anthropic.TextBlock => b.type === 'text')?.text
    return { ...res, parsed_output: text != null ? params.output_config.format.parse(text) : null }
  }

  private text(text: string): Anthropic.TextBlock {
    return { type: 'text', text, citations: null } as Anthropic.TextBlock
  }

  // ───────────── taste memo ─────────────
  private memo(system: Anthropic.TextBlockParam[]) {
    const s = parseStats(system)
    const dirs = s.directors.slice(0, 8)
    return {
      summary: `（模拟备忘）这位观众看过 ${s.counts.films} 部片，常回到 ${dirs.slice(0, 3).map((d) => d.name).join('、') || '若干作者'} 的作品；${
        s.countries.slice(0, 3).map((c) => COUNTRY_ZH[c.code] ?? c.code).join('、')
      } 的电影占比最高。`,
      register: {
        art_house: Math.min(1, 0.3 + s.register.share_festival_core),
        auteur_genre: 0.5,
        mainstream_commercial: Math.min(1, s.register.share_high_popularity),
        note: '（模拟）作者签名清晰的类型片可以排。',
      },
      affinities: dirs.map((d, i) => ({ kind: 'director', name: d.name, strength: Math.max(0.3, 0.9 - i * 0.07), evidence: d.evidence.slice(0, 4), note: `看过 ${d.n} 部。` })),
      aversions: s.disliked.length ? [{ pattern: '低分商业片', strength: 0.5, evidence: s.disliked.slice(0, 4) }] : [],
      frontiers: s.countries.slice(0, 3).map((c) => ({ description: `${COUNTRY_ZH[c.code] ?? c.code}电影里还没系统看过的部分`, why_adjacent: '与已看过的高分片相邻。', seed_films: s.loved.slice(0, 3) })),
      habits: { pace_per_week: s.pace_per_week, runtime_tolerance_min: s.runtime_tolerance_p90 ?? 150, rewatch_tendency: 'low' },
      do_not_program: ['超级英雄系列'],
    }
  }

  // ───────────── Call A ─────────────
  private ideate(params: CreateParams, system: Anthropic.TextBlockParam[], user: string): { content: Anthropic.ContentBlock[]; stop: Anthropic.Message['stop_reason'] } {
    const n = Number(user.match(/Request: (\d+) film/)?.[1] ?? 3)
    const mode = user.match(/Mode: (festival|single)/)?.[1] ?? 'festival'
    const maxRuntime = Number(user.match(/Max runtime that fits: (\d+) min/)?.[1] ?? 999)
    const avoided = new Set<string>()
    for (const m of user.matchAll(/^\s*- \d{4}-\d{2}-\d{2} \w+ · (.+?) · \[/gm)) avoided.add(m[1]!.toLowerCase())
    try {
      for (const s of JSON.parse(user.match(/subjects=(\[.*?\])/)?.[1] ?? '[]') as string[]) avoided.add(s.toLowerCase())
    } catch {
      // ignore
    }
    const avoidKinds = new Set<string>(JSON.parse(user.match(/kinds=(\[.*?\])/)?.[1] ?? '[]') as string[])
    const stats = parseStats(system)

    // 已有的工具往返
    const uses = new Map<string, { name: string; input: Json }>()
    const results: { name: string; input: Json; result: Json }[] = []
    for (const m of params.messages) {
      if (typeof m.content === 'string') continue
      for (const b of m.content) {
        if (b.type === 'tool_use') uses.set(b.id, { name: b.name, input: b.input as Json })
        if (b.type === 'tool_result') {
          const u = uses.get(b.tool_use_id)
          const raw = typeof b.content === 'string' ? b.content : ''
          if (u && !b.is_error) {
            try {
              results.push({ ...u, result: JSON.parse(raw) as Json })
            } catch {
              // ignore
            }
          }
        }
      }
    }

    if (!results.length) {
      const calls: { name: string; input: Json }[] = []
      const ok = (s: string) => !avoided.has(s.toLowerCase())
      if (!avoidKinds.has('director'))
        for (const d of stats.directors.filter((d) => ok(d.name)).slice(0, 2)) calls.push({ name: 'get_filmography', input: { person: d.name, role: 'director' } })
      if (!avoidKinds.has('actor'))
        for (const a of stats.actors.filter((a) => ok(a.name)).slice(0, 1)) calls.push({ name: 'get_filmography', input: { person: a.name, role: 'actor' } })
      const decade = [...stats.decades].sort((a, b) => b.n - a.n)[0]?.decade ?? 1990
      if (!avoidKinds.has('country'))
        for (const c of stats.countries.filter((c) => c.code !== 'US').slice(0, 1))
          calls.push({ name: 'discover_films', input: { countries: [c.code], year_from: decade - 10, year_to: decade + 19, keywords: [], genres: [], sort: 'vote_average' } })
      if (!avoidKinds.has('motif'))
        for (const k of stats.keywords.filter((k) => k.n >= 2 && ok(k.kw)).slice(0, 2))
          calls.push({ name: 'discover_films', input: { countries: [], year_from: null, year_to: null, keywords: [k.kw], genres: [], sort: 'vote_average' } })
      return {
        // id 由请求内容决定：同样的请求永远得到同样的字节（缓存模拟 / 回放都依赖这一点）
        content: calls.map((c, i) => ({ type: 'tool_use', id: `toolu_mock_${createHash('sha1').update(JSON.stringify(stripCache(params.messages))).digest('hex').slice(0, 10)}_${i}`, name: c.name, input: c.input }) as Anthropic.ToolUseBlock),
        stop: 'tool_use',
      }
    }

    type F = { tmdb_id: number; title: string; year: number | null; directors: string[]; runtime_min: number | null; vote_avg: number; seen_by_viewer: boolean; countries?: string[] }
    const usable = (fs: F[]) =>
      fs
        .filter((f) => !f.seen_by_viewer && f.runtime_min != null && f.runtime_min <= maxRuntime && f.directors.length)
        .sort((a, b) => b.vote_avg - a.vote_avg || a.tmdb_id - b.tmdb_id)
    const per = mode === 'single' ? 5 : n * 3
    const concepts: Json[] = []
    for (const r of results) {
      const films = usable(((r.result.films ?? r.result.results) as F[]) ?? []).slice(0, per)
      if (!films.length) continue
      let kind: string
      let subject: string
      let title: string
      if (r.name === 'get_filmography') {
        kind = r.input.role === 'director' ? 'director' : 'actor'
        subject = String((r.result.person as Json | null)?.name ?? r.input.person)
        title = kind === 'director' ? `${subject}：你还没走进的那几间屋子` : `${subject}：另一种表演`
      } else if ((r.input.keywords as string[]).length) {
        kind = 'motif'
        subject = String((r.input.keywords as string[])[0])
        title = `母题 · ${subject}`
      } else {
        kind = 'country'
        const c = (r.input.countries as string[])[0]!
        subject = `${c}, ${r.input.year_from}–${r.input.year_to}`
        title = `${COUNTRY_ZH[c] ?? c}，${r.input.year_from} – ${r.input.year_to}`
      }
      const dir = stats.directors.find((d) => d.name === subject)
      const evidence = (dir?.evidence ?? stats.loved).slice(0, 3)
      concepts.push({
        kind,
        subject,
        title,
        thesis: `（模拟论题）从你看过并打了高分的片出发，这个方案把 ${films.length} 部你还没看过的片放在一起，围绕「${subject}」展开。`,
        evidence,
        why_now: '（模拟）与你近期的观看相邻。',
        candidates: films.map((f, i) => ({
          tmdb_id: f.tmdb_id,
          title: f.title,
          year: f.year ?? 0,
          director: f.directors[0] ?? '',
          role_in_program: i === 0 ? '定调' : '展开',
          connection: `（模拟）与「${subject}」的具体联系。`,
          if_only_one: mode === 'single' && i === 0,
        })),
        self_scores: {
          taste_fit: dir?.avg10 ? Math.min(1, dir.avg10 / 10) : 0.65,
          novelty: kind === 'director' ? 0.4 : kind === 'actor' ? 0.55 : 0.7,
          coherence: kind === 'motif' ? 0.78 : 0.72,
          ambition: { director: 0.5, country: 0.6, actor: 0.65, motif: 0.8 }[kind] ?? 0.5,
        },
      })
    }
    return { content: [this.text(JSON.stringify({ concepts: concepts.slice(0, 6) }))], stop: 'end_turn' }
  }

  // ───────────── Call B ─────────────
  private audit(system: Anthropic.TextBlockParam[], user: string) {
    const block = system[3]!.text
    const programme = JSON.parse(block.slice(block.indexOf('## Programme under review\n') + 26)) as {
      title: string
      subject: string
      thesis: string
      candidates: { tmdb_id: number; title: string; year: number | null; directors: string[]; genres: string[]; vote_count: number | null; infeasible: boolean; connection: string; if_only_one: boolean }[]
    }
    const n = Number(user.match(/for (\d+) film/)?.[1] ?? 1)
    const single = /Mode: single/.test(user)
    const decisions = programme.candidates.map((c) => {
      const disposable = c.genres.includes('Action') && (c.vote_count ?? 0) >= 8000
      return {
        tmdb_id: c.tmdb_id,
        keep: !c.infeasible && !disposable,
        register: disposable ? 'commercial_disposable' : 'art',
        fit_to_thesis: disposable ? 0.2 : 0.8,
        reason: disposable ? '（模拟）一次性商业片，剔除。' : c.infeasible ? '（模拟）片长放不进本周空档。' : '（模拟）属于这个论题。',
      }
    })
    const kept = programme.candidates.filter((c) => decisions.find((d) => d.tmdb_id === c.tmdb_id)!.keep)
    let chosen = single ? [kept.find((c) => c.if_only_one) ?? kept[0]].filter(Boolean) : [...kept.slice(0, n)].sort((a, b) => (a.year ?? 0) - (b.year ?? 0))
    chosen = chosen.slice(0, n) as typeof kept
    const roleFor = (i: number, len: number) => (len === 1 || i === 0 ? 'opening' : i === len - 1 ? 'closing' : len >= 3 && i === Math.floor(len / 2) ? 'centerpiece' : 'regular')
    return {
      decisions,
      insufficient: chosen.length < n,
      slate: chosen.map((c, i) => ({
        tmdb_id: c!.tmdb_id,
        position: i + 1,
        role: roleFor(i, chosen.length),
        program_note: `（模拟场刊）《${c!.title}》（${c!.year ?? '?'}，${c!.directors.join('、')}）。${c!.connection}这一段文字只用于离线测试，真实的场刊由 Claude 写成，六十到一百二十字，具体、不剧透。`,
        order_rationale: '（模拟）按年份推进。',
      })),
      single_pick: chosen[0]?.tmdb_id ?? programme.candidates[0]?.tmdb_id ?? 0,
      revised_title: programme.title,
      revised_statement: single
        ? `（模拟推荐语）这周只放一部：《${chosen[0]?.title ?? ''}》。`
        : `（模拟策展陈述）${programme.thesis} 这一段文字只用于离线测试。`,
      coherence: 0.8,
      confidence: 0.75,
    }
  }
}
