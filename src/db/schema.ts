/**
 * 数据模型（ARCHITECTURE.md 第 4 章）。
 *
 * 约定：
 * - 列名 snake_case，TS 字段 camelCase；Auth.js 表的 TS 字段名必须与 @auth/drizzle-adapter 期望一致。
 * - 时间一律 ISO 字符串（`created_at` / `updated_at`）。
 * - JSON 列用 `text({ mode: 'json' })` 存，类型在 `src/db/types.ts` 用 zod 定义，repo 层负责校验。
 * - schema 保持 Postgres 可迁移：不依赖 SQLite 独有特性（除 autoincrement）。
 */
import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'
import type { AdapterAccountType } from 'next-auth/adapters'
import { newCalendarToken, newId } from '@/lib/ids'
import { nowIso } from '@/lib/time'
import type {
  AuditOutputT,
  AvailabilityBlock,
  CastMember,
  FestivalAvoid,
  IdeateConceptT,
  PersonRef,
  TasteMemoT,
  TasteStatsT,
  UserPrefs,
} from './types'
import { DEFAULT_PREFS } from './types'

const timestamps = {
  createdAt: text('created_at').notNull().$defaultFn(nowIso),
  updatedAt: text('updated_at')
    .notNull()
    .$defaultFn(nowIso)
    .$onUpdateFn(nowIso),
}

// ───────────────────────────── 4.1 用户与来源 ─────────────────────────────

export const users = sqliteTable('users', {
  id: text('id').primaryKey().$defaultFn(newId),
  email: text('email').unique(),
  name: text('name'),
  // Auth.js 需要的字段
  emailVerified: integer('email_verified', { mode: 'timestamp_ms' }),
  image: text('image'),
  // 应用字段
  locale: text('locale', { enum: ['zh-CN', 'en'] }).notNull().default('zh-CN'),
  tz: text('tz').notNull().default('Asia/Shanghai'),
  calendarToken: text('calendar_token').notNull().unique().$defaultFn(newCalendarToken),
  prefs: text('prefs', { mode: 'json' })
    .$type<UserPrefs>()
    .notNull()
    .$defaultFn(() => DEFAULT_PREFS),
  ...timestamps,
})

export const sourceAccounts = sqliteTable(
  'source_accounts',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['letterboxd', 'douban'] }).notNull(),
    handle: text('handle').notNull(),
    authEnc: text('auth_enc'),
    syncMode: text('sync_mode', { enum: ['upload', 'rss', 'scrape'] }).notNull(),
    cursor: text('cursor', { mode: 'json' }).$type<unknown>(),
    lastSyncAt: text('last_sync_at'),
    lastError: text('last_error'),
    ...timestamps,
  },
  (t) => [index('source_accounts_user_idx').on(t.userId)],
)

// ───────────────────────────── Auth.js 表 ─────────────────────────────

export const accounts = sqliteTable(
  'auth_accounts',
  {
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').$type<AdapterAccountType>().notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (t) => [primaryKey({ columns: [t.provider, t.providerAccountId] })],
)

export const sessions = sqliteTable('auth_sessions', {
  sessionToken: text('session_token').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  expires: integer('expires', { mode: 'timestamp_ms' }).notNull(),
})

export const verificationTokens = sqliteTable(
  'auth_verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: integer('expires', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
)

// ───────────────────────────── 4.2 电影（全局缓存） ─────────────────────────────

export const films = sqliteTable('films', {
  tmdbId: integer('tmdb_id').primaryKey(),
  imdbId: text('imdb_id'),
  titleEn: text('title_en').notNull(),
  titleZh: text('title_zh'),
  originalTitle: text('original_title').notNull(),
  year: integer('year'),
  runtimeMin: integer('runtime_min'),
  countries: text('countries', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  languages: text('languages', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  genres: text('genres', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  directors: text('directors', { mode: 'json' }).$type<PersonRef[]>().notNull().default(sql`'[]'`),
  castTop: text('cast_top', { mode: 'json' }).$type<CastMember[]>().notNull().default(sql`'[]'`),
  keywords: text('keywords', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
  overviewEn: text('overview_en'),
  overviewZh: text('overview_zh'),
  posterPath: text('poster_path'),
  voteAvg: real('vote_avg'),
  voteCount: integer('vote_count'),
  popularity: real('popularity'),
  releaseDate: text('release_date'),
  enrichedAt: text('enriched_at'),
  ...timestamps,
})

export type MatchCandidate = {
  tmdb_id: number
  title: string
  year: number | null
  score: number
  original_title?: string
  vote_count?: number
}

export const filmAliases = sqliteTable(
  'film_aliases',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    provider: text('provider', { enum: ['letterboxd', 'douban', 'manual'] }).notNull(),
    externalId: text('external_id').notNull(),
    titleRaw: text('title_raw').notNull(),
    yearRaw: integer('year_raw'),
    /** 外部来源直接给出的 IMDb id（豆瓣 subject 页），供 resolver 第 2 步使用。 */
    imdbIdRaw: text('imdb_id_raw'),
    tmdbId: integer('tmdb_id').references(() => films.tmdbId),
    /** not_film：剧集 / 综艺 / 舞台录像等不在 TMDB 电影库里的条目（自动识别或用户标记），不进待确认 */
    matchStatus: text('match_status', {
      enum: ['pending', 'matched', 'ambiguous', 'unmatched', 'confirmed', 'not_film'],
    })
      .notNull()
      .default('pending'),
    matchConfidence: real('match_confidence'),
    candidates: text('candidates', { mode: 'json' }).$type<MatchCandidate[]>(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('film_aliases_provider_ext_uq').on(t.provider, t.externalId),
    index('film_aliases_tmdb_idx').on(t.tmdbId),
    index('film_aliases_status_idx').on(t.matchStatus),
  ],
)

// ───────────────────────────── 4.3 用户观影数据 ─────────────────────────────

export const watchLog = sqliteTable(
  'watch_log',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 来源账号；manual / fest 为 null。删除来源时级联删除。 */
    sourceId: text('source_id').references(() => sourceAccounts.id, { onDelete: 'cascade' }),
    aliasId: integer('alias_id')
      .notNull()
      .references(() => filmAliases.id),
    tmdbId: integer('tmdb_id'),
    provider: text('provider', { enum: ['letterboxd', 'douban', 'manual', 'fest'] }).notNull(),
    externalEntryId: text('external_entry_id').notNull(),
    watchedAt: text('watched_at'),
    loggedAt: text('logged_at'),
    rating10: integer('rating10'),
    liked: integer('liked', { mode: 'boolean' }).notNull().default(false),
    rewatch: integer('rewatch', { mode: 'boolean' }).notNull().default(false),
    reviewText: text('review_text'),
    tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
    raw: text('raw', { mode: 'json' }).$type<unknown>(),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('watch_log_entry_uq').on(t.userId, t.provider, t.externalEntryId),
    index('watch_log_user_tmdb_idx').on(t.userId, t.tmdbId),
    index('watch_log_alias_idx').on(t.aliasId),
  ],
)

export const watchlist = sqliteTable(
  'watchlist',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceId: text('source_id').references(() => sourceAccounts.id, { onDelete: 'cascade' }),
    aliasId: integer('alias_id')
      .notNull()
      .references(() => filmAliases.id),
    tmdbId: integer('tmdb_id'),
    provider: text('provider', { enum: ['letterboxd', 'douban', 'manual'] }).notNull(),
    addedAt: text('added_at'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('watchlist_user_alias_uq').on(t.userId, t.aliasId),
    index('watchlist_user_tmdb_idx').on(t.userId, t.tmdbId),
  ],
)

// ───────────────────────────── 4.4 画像、计划、影展 ─────────────────────────────

export const tasteProfiles = sqliteTable(
  'taste_profiles',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    watchLogHash: text('watch_log_hash').notNull(),
    /** 生成时的条目数，用于「新增 ≥ 20 条」的重建判断。 */
    watchLogCount: integer('watch_log_count').notNull().default(0),
    stats: text('stats', { mode: 'json' }).$type<TasteStatsT>().notNull(),
    memo: text('memo', { mode: 'json' }).$type<TasteMemoT>(),
    memoMd: text('memo_md'),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    ...timestamps,
  },
  (t) => [uniqueIndex('taste_profiles_user_version_uq').on(t.userId, t.version)],
)

export const availability = sqliteTable(
  'availability',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    weekStart: text('week_start').notNull(),
    mode: text('mode', { enum: ['available', 'unavailable'] }).notNull(),
    blocks: text('blocks', { mode: 'json' }).$type<AvailabilityBlock[]>().notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex('availability_user_week_uq').on(t.userId, t.weekStart)],
)

export type AvailabilitySnapshot = {
  mode: 'available' | 'unavailable'
  blocks: AvailabilityBlock[]
  prefs: UserPrefs
  tz: string
}

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    type: text('type', {
      enum: [
        'sync_source',
        'enrich_films',
        'build_taste',
        'generate_festival',
        'push_google_calendar',
        'demo',
      ],
    }).notNull(),
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
    status: text('status', { enum: ['queued', 'running', 'done', 'failed'] })
      .notNull()
      .default('queued'),
    progress: integer('progress').notNull().default(0),
    message: text('message'),
    attempts: integer('attempts').notNull().default(0),
    error: text('error'),
    heartbeatAt: text('heartbeat_at'),
    result: text('result', { mode: 'json' }).$type<unknown>(),
    ...timestamps,
  },
  (t) => [
    index('jobs_status_created_idx').on(t.status, t.createdAt),
    index('jobs_user_idx').on(t.userId),
  ],
)

export const festivalRequests = sqliteTable(
  'festival_requests',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    weekStart: text('week_start').notNull(),
    days: integer('days').notNull(),
    filmCount: integer('film_count').notNull(),
    availabilitySnapshot: text('availability_snapshot', { mode: 'json' })
      .$type<AvailabilitySnapshot>()
      .notNull(),
    avoid: text('avoid', { mode: 'json' })
      .$type<FestivalAvoid>()
      .notNull()
      .$defaultFn(() => ({ kinds: [], subjects: [], tmdb_ids: [] })),
    rerollCount: integer('reroll_count').notNull().default(0),
    jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  (t) => [index('festival_requests_user_idx').on(t.userId)],
)

export type FestivalKind = 'director' | 'country' | 'actor' | 'motif' | 'single'

export type FestivalConcept = {
  ideate: IdeateConceptT
  audit: AuditOutputT | null
}

export const festivals = sqliteTable(
  'festivals',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    requestId: text('request_id')
      .notNull()
      .references(() => festivalRequests.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['director', 'country', 'actor', 'motif', 'single'] }).notNull(),
    subject: text('subject').notNull(),
    title: text('title').notNull(),
    statementMd: text('statement_md').notNull(),
    concept: text('concept', { mode: 'json' }).$type<FestivalConcept>().notNull(),
    alternatives: text('alternatives', { mode: 'json' }).$type<unknown[]>().notNull(),
    selectionTrace: text('selection_trace', { mode: 'json' }).$type<unknown>().notNull(),
    status: text('status', { enum: ['draft', 'published', 'dismissed', 'completed'] })
      .notNull()
      .default('draft'),
    googleCalendarSyncedAt: text('google_calendar_synced_at'),
    ...timestamps,
  },
  (t) => [
    index('festivals_user_created_idx').on(t.userId, t.createdAt),
    index('festivals_request_idx').on(t.requestId),
  ],
)

export const screenings = sqliteTable(
  'screenings',
  {
    id: text('id').primaryKey().$defaultFn(newId),
    festivalId: text('festival_id')
      .notNull()
      .references(() => festivals.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tmdbId: integer('tmdb_id')
      .notNull()
      .references(() => films.tmdbId),
    position: integer('position').notNull(),
    role: text('role', { enum: ['opening', 'centerpiece', 'closing', 'regular'] }).notNull(),
    programNoteMd: text('program_note_md').notNull(),
    startsAt: text('starts_at'),
    endsAt: text('ends_at'),
    unscheduledReason: text('unscheduled_reason'),
    calendarUid: text('calendar_uid').notNull(),
    calendarSequence: integer('calendar_sequence').notNull().default(0),
    googleEventId: text('google_event_id'),
    feedback: text('feedback', { enum: ['watched', 'skipped', 'not_interested'] }),
    feedbackAt: text('feedback_at'),
    ...timestamps,
  },
  (t) => [
    index('screenings_festival_idx').on(t.festivalId),
    index('screenings_user_starts_idx').on(t.userId, t.startsAt),
  ],
)

// ───────────────────────────── 4.5 基础设施 ─────────────────────────────

export const llmCalls = sqliteTable(
  'llm_calls',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    jobId: text('job_id').references(() => jobs.id, { onDelete: 'set null' }),
    purpose: text('purpose', { enum: ['taste_memo', 'ideate', 'audit', 'other'] }).notNull(),
    promptVersion: text('prompt_version'),
    model: text('model').notNull(),
    effort: text('effort'),
    inputTokens: integer('input_tokens').notNull().default(0),
    cacheCreationInputTokens: integer('cache_creation_input_tokens').notNull().default(0),
    cacheReadInputTokens: integer('cache_read_input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    costUsd: real('cost_usd').notNull().default(0),
    requestHash: text('request_hash').notNull(),
    response: text('response', { mode: 'json' }).$type<unknown>(),
    durationMs: integer('duration_ms'),
    ...timestamps,
  },
  (t) => [
    index('llm_calls_user_idx').on(t.userId, t.createdAt),
    index('llm_calls_request_hash_idx').on(t.requestHash),
  ],
)

export type User = typeof users.$inferSelect
export type Job = typeof jobs.$inferSelect
export type JobType = Job['type']
export type Film = typeof films.$inferSelect
export type FilmAlias = typeof filmAliases.$inferSelect
export type WatchLogRow = typeof watchLog.$inferSelect
export type SourceAccount = typeof sourceAccounts.$inferSelect
export type Festival = typeof festivals.$inferSelect
export type Screening = typeof screenings.$inferSelect
export type FestivalRequest = typeof festivalRequests.$inferSelect
export type TasteProfile = typeof tasteProfiles.$inferSelect
