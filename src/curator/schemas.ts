/**
 * LLM 结构化输出与工具入参的 zod schema（ARCHITECTURE.md 7.10）。
 *
 * - 所有对象 strict（additionalProperties: false）。
 * - 不用 min/max 数值约束——API 不支持，约束写进 .describe()，代码侧另行校验。
 * - 所有字段 required（不可选），避免结构化输出对 optional 的歧义；「没有」用空数组 / 空串表达。
 * - 发给 API 的 JSON Schema 由 `outputFormat()` 生成：沿用 SDK `zodOutputFormat` 的解析 / 校验，
 *   但 schema 本身自己转换——保留 `enum` / `const`（SDK 0.133 的 transformJSONSchema 会把 enum 挪进 description，
 *   失去约束），去掉 API 不支持的数值 / 字符串约束（zod `.int()` 生成的 ±2^53 边界等）。
 */
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { z } from 'zod'

const id = (what = 'tmdb_id') => z.number().int().describe(what)
const ids = (what: string) => z.array(z.number().int()).describe(what)

const score01 = (what: string) => z.number().describe(`${what}. A number between 0 and 1.`)

// ───────────────────────────── TasteMemo（6.2） ─────────────────────────────

export const TasteMemo = z
  .strictObject({
    summary: z
      .string()
      .describe(
        'Written in the requested locale, 250–450 words: a senior programmer’s portrait of this viewer — what they return to, what they reward, how they watch.',
      ),
    register: z
      .strictObject({
        art_house: score01('How much of their viewing and enthusiasm sits in art-house cinema'),
        auteur_genre: score01(
          'Appetite for auteur-driven genre cinema (Carpenter, Mann, Park Chan-wook, Johnnie To …)',
        ),
        mainstream_commercial: score01('Tolerance for and enjoyment of mainstream commercial cinema'),
        note: z
          .string()
          .describe(
            'Locale. How they treat genre/commercial films: which kinds work for them and which do not, citing evidence.',
          ),
      })
      .describe('Register / commercial tolerance.'),
    affinities: z
      .array(
        z.strictObject({
          kind: z.enum(['director', 'country', 'era', 'movement', 'form', 'theme', 'actor', 'studio']),
          name: z.string(),
          strength: score01('Strength of the affinity'),
          evidence: ids('tmdb_ids from the viewer’s log that support this.'),
          note: z.string().describe('Locale. One or two sentences.'),
        }),
      )
      .describe('8–20 affinities, strongest first.'),
    aversions: z
      .array(
        z.strictObject({
          pattern: z.string().describe('Locale. What they reliably dislike or avoid.'),
          strength: score01('Strength of the aversion'),
          evidence: ids('tmdb_ids from the log (low ratings etc.).'),
        }),
      )
      .describe('0–10 aversions.'),
    frontiers: z
      .array(
        z.strictObject({
          description: z.string().describe('Locale. A direction worth programming that they have not explored systematically.'),
          why_adjacent: z.string().describe('Locale. Why it is adjacent to what they already love.'),
          seed_films: ids('tmdb_ids from their log that point toward it.'),
        }),
      )
      .describe('3–8 frontiers.'),
    habits: z.strictObject({
      pace_per_week: z.number().describe('Films per week recently.'),
      runtime_tolerance_min: z.number().describe('Longest runtime they comfortably watch, minutes.'),
      rewatch_tendency: z.enum(['low', 'mid', 'high']),
    }),
    do_not_program: z
      .array(z.string())
      .describe('Locale. Inferred hard rules, e.g. "superhero franchises", "Hollywood remakes of Asian films".'),
  })
  .describe('The curatorial memo about this viewer.')

export type TasteMemoT = z.infer<typeof TasteMemo>

// ───────────────────────────── IdeateOutput（7.3） ─────────────────────────────

export const CONCEPT_KINDS = ['director', 'country', 'actor', 'motif'] as const
export type ConceptKind = (typeof CONCEPT_KINDS)[number]

export const IdeateCandidate = z.strictObject({
  tmdb_id: id('tmdb_id. Must come from a tool result in this conversation.'),
  title: z.string(),
  year: z.number().int().describe('Release year.'),
  director: z.string().describe('Director name as given by the tool result.'),
  role_in_program: z.string().describe('Locale. What this film does in the programme.'),
  connection: z
    .string()
    .describe(
      'Locale. The concrete link to the subject/motif — for motif programmes, name the scene, image, or device.',
    ),
  if_only_one: z
    .boolean()
    .describe('Single mode: true for the one film you would pick if only one could be shown. Otherwise false.'),
})

export const IdeateConcept = z.strictObject({
  kind: z.enum(CONCEPT_KINDS),
  subject: z
    .string()
    .describe('Canonical subject: a person’s name in its usual romanisation, a country/region/movement with era, or a short English motif phrase.'),
  title: z.string().describe('Locale. Programme title.'),
  thesis: z
    .string()
    .describe('Locale, 150–300 words. The argument for this programme, citing films the viewer has seen.'),
  evidence: ids('tmdb_ids of films FROM THE VIEWER’S LOG that the thesis cites as evidence.'),
  why_now: z.string().describe('Locale. Relation to their recent viewing and frontiers.'),
  candidates: z
    .array(IdeateCandidate)
    .describe('Festival mode: 2N–3N unseen films. Single mode: 3–5. All must be unseen by the viewer.'),
  self_scores: z.strictObject({
    taste_fit: score01('Fit to this viewer’s taste'),
    novelty: score01('How new this territory is for them'),
    coherence: score01('How tightly the films argue one thesis'),
    ambition: score01('Curatorial ambition'),
  }),
})

export const IdeateOutput = z.strictObject({
  concepts: z.array(IdeateConcept).describe('4–6 concepts covering at least 3 distinct kinds.'),
})

export type IdeateCandidateT = z.infer<typeof IdeateCandidate>
export type IdeateConceptT = z.infer<typeof IdeateConcept>
export type IdeateOutputT = z.infer<typeof IdeateOutput>

// ───────────────────────────── AuditOutput（7.5） ─────────────────────────────

export const REGISTERS = ['art', 'auteur_genre', 'commercial_good', 'commercial_disposable'] as const
export const SCREENING_ROLES = ['opening', 'centerpiece', 'closing', 'regular'] as const

export const AuditOutput = z.strictObject({
  decisions: z
    .array(
      z.strictObject({
        tmdb_id: id(),
        keep: z.boolean(),
        register: z.enum(REGISTERS),
        fit_to_thesis: score01('How truly this film belongs to the thesis'),
        reason: z.string().describe('Locale. One or two sentences.'),
      }),
    )
    .describe('One decision per candidate, in the order given.'),
  insufficient: z
    .boolean()
    .describe('True if fewer than N candidates survive. Never refill from seen or rejected films.'),
  slate: z
    .array(
      z.strictObject({
        tmdb_id: id('tmdb_id. Must be a kept candidate.'),
        position: z.number().int().describe('1..N, contiguous.'),
        role: z.enum(SCREENING_ROLES),
        program_note: z.string().describe('Locale, 60–120 words. Specific, no spoilers past the first act.'),
        order_rationale: z.string().describe('Locale. Why it sits at this position.'),
      }),
    )
    .describe('Exactly N films (fewer only if insufficient).'),
  single_pick: id('tmdb_id of the one film you would show if only one could be shown.'),
  revised_title: z.string().describe('Locale. Final programme title.'),
  revised_statement: z.string().describe('Locale, 120–220 words. Curatorial statement addressed to the viewer.'),
  coherence: score01('Coherence of the final slate'),
  confidence: score01('Confidence that this programme will land with this viewer'),
})

export type AuditOutputT = z.infer<typeof AuditOutput>

// ───────────────────────────── 工具入参（7.3） ─────────────────────────────

export const SearchFilmsInput = z.strictObject({
  query: z.string().describe('Title in any language.'),
  year: z.number().int().nullable().describe('Release year if known, else null.'),
})

export const GetFilmographyInput = z.strictObject({
  person: z.string().describe('Person name.'),
  role: z.enum(['director', 'actor']),
})

export const DiscoverFilmsInput = z.strictObject({
  countries: z.array(z.string()).describe('ISO 3166-1 alpha-2 origin countries; empty for any.'),
  year_from: z.number().int().nullable().describe('First release year, or null.'),
  year_to: z.number().int().nullable().describe('Last release year, or null.'),
  keywords: z.array(z.string()).describe('TMDB keyword phrases (English); empty for any.'),
  genres: z.array(z.string()).describe('TMDB genre names (English); empty for any.'),
  sort: z.enum(['vote_average', 'popularity', 'release_date']),
})

export const GetFilmInput = z.strictObject({
  tmdb_id: id(),
})

/** 结构化输出 / 严格工具不支持的关键字（7.10）。 */
const UNSUPPORTED = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'uniqueItems', '$schema'])
const FORMATS = new Set(['date-time', 'time', 'date', 'duration', 'email', 'hostname', 'uri', 'ipv4', 'ipv6', 'uuid'])

function strictify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictify)
  if (!node || typeof node !== 'object') return node
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (UNSUPPORTED.has(k)) continue
    if (k === 'format' && typeof v === 'string' && !FORMATS.has(v)) continue
    out[k] = k === 'properties' || k === '$defs' ? Object.fromEntries(Object.entries(v as object).map(([pk, pv]) => [pk, strictify(pv)])) : strictify(v)
  }
  if (out.type === 'object') out.additionalProperties = false
  return out
}

/** zod → 严格 JSON Schema（内联，不生成 $defs；保留 enum / const）。 */
export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return strictify(z.toJSONSchema(schema, { reused: 'inline', io: 'output' })) as Record<string, unknown>
}

/** SDK `zodOutputFormat`（解析 + zod 校验）配上 `strictJsonSchema` 生成的 schema。 */
export function outputFormat<T>(schema: z.ZodType<T>) {
  const f = zodOutputFormat(schema)
  return { ...f, schema: strictJsonSchema(schema) }
}
