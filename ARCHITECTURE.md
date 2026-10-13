# fest-of-one · 一个人的影展 — 架构文档 v1

> 本文档是给执行者（Claude Opus / 其他工程师）的**实施规格**，不是概念稿。
> 读法：第 1–2 章定产品边界与选型；第 4–9 章是各子系统的精确规格（数据模型、接口、算法、prompt）；第 15 章是按顺序执行的里程碑与验收标准。
> 文中「必须 / 禁止」为硬约束；「建议」可按实现时的实际情况调整，但要在 PR 里说明理由。

---

## 0. 一句话

用户把 Letterboxd / 豆瓣的观影记录接进来，填好本周的可用（或不可用）时间、想看几天、看几部；系统用 Claude 读完**全部**观影记录，自行决定一个策展角度（导演回顾、国别、演员回顾、或围绕服饰/土地等母题的专题展），生成有策展陈述和场刊的排片，并一键加入 Apple / Google 日历（地点留空）。只需要一部时，直接推一部，不包装成影展。

---

## 1. 产品定义

### 1.1 用户流程

1. **接入**：绑定 Letterboxd 用户名（上传官方导出 ZIP，或 RSS 增量）/ 豆瓣 ID（上传第三方导出 CSV，或提供登录 Cookie 抓取）。
2. **建库**：系统把条目统一匹配到 TMDB，补全导演、演员、国别、片长、关键词；展示「未匹配」让用户手工确认。
3. **画像**：系统生成品味画像（统计层 + LLM 备忘层），用户可查看但不需编辑。
4. **计划**：用户在周视图里涂抹可用 / 不可用时段，填「几天」「几部」，点「生成本周影展」。
5. **推送**：页面展示影展（标题、策展陈述、海报墙、逐日排片、每部的场刊短评）。用户只有两个动作：「换一个」和「加入日历」。
6. **回访**：一周后勾选看了 / 没看 / 不感兴趣，反馈进入下一次策展。

### 1.2 关键产品决策（硬约束）

| # | 决策 | 原因 |
|---|------|------|
| P1 | **系统决定影展类型，用户不选**。只提供「换一个」。 | 用户明确要求；品味由系统替他表达。 |
| P2 | **部数 = 1 时不成展**。输出单部推荐，但数据上仍是 `festival.kind = 'single'`，复用日历与反馈链路。 | 统一下游，UI 层区分。 |
| P3 | **LLM 必须看到完整观影记录**，不做 RAG 式抽样。靠 prompt caching 控制成本。 | 用户要求「真的完全了解」。 |
| P4 | **LLM 不生成时间戳**。LLM 只给顺序与场刊；排期由确定性算法完成。 | 可靠、可测试、可重排。 |
| P5 | **所有候选片必须在 TMDB 落地**（存在、片长、导演核对），且**不在已看列表**。 | 防幻觉、防重复。 |
| P6 | 演员回顾展必须经过**片单审查**：与画像的「类型/商业片容忍度」不符的片剔除；好的类型片可留。 | 用户明确要求。 |
| P7 | 日历事件 **LOCATION 留空**。 | 用户要求。 |
| P8 | 多用户：所有用户数据按 `user_id` 隔离；电影元数据是全局缓存。 | 「针对每一个用户」。 |

### 1.3 非目标（v1 不做）

- 不做流媒体可看性查询（哪儿能看）。
- 不做社交 / 分享。
- 不写回 Letterboxd / 豆瓣。
- 不做移动端原生 App（响应式 Web 即可）。

---

## 2. 技术选型

| 层 | 选择 | 理由 |
|----|------|------|
| 框架 | **Next.js 15 (App Router) + TypeScript + React 19 + Tailwind** | 单仓库同时承载 UI、API、Server Actions；执行者熟悉。 |
| 数据库 | **SQLite (better-sqlite3) + Drizzle ORM**；schema 保持 Postgres 可迁移 | 个人工具、少量用户、部署简单。 |
| 认证 | **Auth.js v5**，Google provider（顺便拿 Google Calendar 权限）；本地开发 `DEV_LOGIN=1` 直登 | 一键 Google 日历需要 OAuth。 |
| 后台任务 | **DB 表 `jobs` + 独立 worker 进程**（`pnpm worker`），无 Redis | 同步 / 富化 / 生成都要跑分钟级。 |
| LLM | **`@anthropic-ai/sdk`**，模型 **`claude-opus-5-5`**，结构化输出 `client.messages.parse` + `zodOutputFormat`，prompt caching | 见第 7.11 节。 |
| 元数据 | **TMDB API v3**（Bearer token） | 统一 ID、片长、导演演员、国别、关键词、多语言标题。 |
| 日历 | 自产 **ICS (RFC 5545)** + **webcal 订阅** + Google 模板链接 + Google Calendar API 批量写入 | Apple 只能走 ICS；Google 两条路都给。 |
| 抓取 | `undici` fetch + `cheerio`；CSV 用 `papaparse`；ZIP 用 `adm-zip` | — |
| 校验 | `zod` 贯穿：API 入参、LLM 输出、CSV 行 | — |
| 部署 | Docker，两进程（web + worker），SQLite 放持久卷；Fly.io / Railway / 任意 VPS。**不用 Vercel**（worker 需常驻） | — |

包管理用 `pnpm`。Node ≥ 20。

---

## 3. 系统总览

```
 ┌──────────────┐   ZIP/CSV/RSS/HTML    ┌───────────────┐
 │ Letterboxd   │ ───────────────────▶  │               │
 │ 豆瓣         │                        │  Ingestion    │──▶ watch_log / watchlist
 │ 手动添加     │                        │  (adapters)   │        │
 └──────────────┘                        └───────┬───────┘        │
                                                 │ RawEntry       │
                                          ┌──────▼──────┐         │
                                          │  Resolver   │◀──TMDB──┤
                                          │ (match+rich)│         │
                                          └──────┬──────┘         │
                                                 │ films (global cache)
                                    ┌────────────▼─────────────┐
                                    │   Taste Profile          │
                                    │  stats (code) + memo(LLM)│
                                    └────────────┬─────────────┘
                                                 │ cached prompt blocks
 availability + days + count ──▶ ┌───────────────▼────────────────┐
                                 │  Curator pipeline              │
                                 │  A ideate(tools) → ground →    │
                                 │  B audit → select → schedule   │
                                 └───────────────┬────────────────┘
                                                 │ festival + screenings
                        ┌────────────────────────┼─────────────────────────┐
                        ▼                        ▼                         ▼
                  Festival page             ICS / webcal            Google Calendar API
                  (换一个 / 反馈)            (Apple + Google)         (批量 insert)
```

所有耗时操作（同步、富化、画像、生成、推 Google）都是 `jobs` 表里的任务，由 worker 执行，UI 轮询进度。

---

## 4. 数据模型（Drizzle，SQLite）

以下为字段级规格；类型写 TS 风格，执行者转成 Drizzle 定义。所有表带 `created_at`、`updated_at`（ISO 字符串）。JSON 列用 `text` 存 JSON，读写经 zod。

### 4.1 用户与来源

```ts
users {
  id: text PK (nanoid)
  email: text unique
  name: text?
  locale: 'zh-CN' | 'en' = 'zh-CN'        // 场刊/陈述输出语言
  tz: text = 'Asia/Shanghai'               // IANA
  calendar_token: text unique              // webcal 订阅用，32 字节随机，可轮换
  prefs: json {
    day_bounds: { start: '10:00', end: '24:00' }   // 「不可用」取补集时的一天边界
    buffer_min: 20                                  // 场次间隔
    max_films_per_day: 2
    weekday_max_runtime_min: 170                    // 工作日不排超长片
    preferred_start: '19:30' | null                 // 若窗口允许，优先从此时间开始
    alarm_min: 30 | null
  }
}

source_accounts {
  id, user_id FK
  provider: 'letterboxd' | 'douban'
  handle: text                 // letterboxd username / douban people id
  auth_enc: text?              // 豆瓣 Cookie，AES-256-GCM 加密，密钥来自 env APP_ENCRYPTION_KEY
  sync_mode: 'upload' | 'rss' | 'scrape'
  cursor: json?                // 增量同步游标（RSS 最新 guid / 抓取页码）
  last_sync_at, last_error
}
```

### 4.2 电影（全局缓存）

```ts
films {
  tmdb_id: integer PK
  imdb_id: text?
  title_en: text               // TMDB en-US title
  title_zh: text?              // TMDB zh-CN title
  original_title: text
  year: integer?
  runtime_min: integer?
  countries: json string[]     // ISO 3166-1 alpha-2，production_countries ∪ origin_country
  languages: json string[]
  genres: json string[]        // TMDB genre names (en)
  directors: json { tmdb_person_id, name }[]
  cast_top: json { tmdb_person_id, name, character, order }[]   // 前 10
  keywords: json string[]
  overview_en, overview_zh: text?
  poster_path: text?
  vote_avg: real?, vote_count: integer?, popularity: real?
  release_date: text?
  enriched_at: text?           // null 表示只有 search 结果，未拉详情
}

film_aliases {                 // 外部条目 → TMDB 的映射，含未匹配项
  id PK
  provider: 'letterboxd' | 'douban' | 'manual'
  external_id: text            // letterboxd URI (https://boxd.it/xxxx) / douban subject id
  title_raw: text, year_raw: integer?
  tmdb_id: integer? FK films
  match_status: 'matched' | 'ambiguous' | 'unmatched' | 'confirmed'   // confirmed = 用户手工确认
  match_confidence: real?
  candidates: json? { tmdb_id, title, year, score }[]                 // ambiguous 时给 UI 选
  unique(provider, external_id)
}
```

### 4.3 用户观影数据

```ts
watch_log {
  id PK
  user_id FK
  alias_id FK film_aliases
  tmdb_id: integer?            // 冗余，便于查询；alias 匹配后回填
  provider: 'letterboxd' | 'douban' | 'fest'      // fest = 本应用标记「看了」
  external_entry_id: text      // letterboxd diary 行 hash / douban subject id；用于幂等
  watched_at: text?            // YYYY-MM-DD，可空（Letterboxd watched.csv 只有加入日期）
  logged_at: text?
  rating10: integer?           // 统一到 1–10：Letterboxd 星数×2；豆瓣星数×2
  liked: boolean = false
  rewatch: boolean = false
  review_text: text?
  tags: json string[]
  raw: json
  unique(user_id, provider, external_entry_id)
}

watchlist { id, user_id, alias_id, tmdb_id?, provider, added_at }
```

### 4.4 画像、计划、影展

```ts
taste_profiles {
  id PK, user_id FK
  version: integer             // 单调递增
  watch_log_hash: text         // 生成时观影记录的 hash，用于判断是否需要重建
  stats: json TasteStats       // 见 6.1
  memo: json TasteMemo         // 见 6.2
  memo_md: text                // memo.summary 的渲染版
  model: text, input_tokens, output_tokens
}

availability {
  id PK, user_id FK
  week_start: text             // YYYY-MM-DD，用户时区的周一；'template' 表示每周默认模板
  mode: 'available' | 'unavailable'
  blocks: json { dow: 0-6, start: 'HH:mm', end: 'HH:mm' }[]     // dow 0 = 周一
  unique(user_id, week_start)
}

festival_requests {
  id PK, user_id FK
  week_start: text
  days: integer, film_count: integer
  availability_snapshot: json   // 生成时的 blocks + mode + prefs，保证可复现
  avoid: json { kinds: string[], subjects: string[], tmdb_ids: number[] }   // reroll 累积
  job_id FK
}

festivals {
  id PK, request_id FK, user_id FK
  kind: 'director' | 'country' | 'actor' | 'motif' | 'single'
  subject: text                 // "Hou Hsiao-hsien" / "Iran, 1990s" / "Isabelle Huppert" / "Costume as armor"
  title: text                   // 影展标题（locale）
  statement_md: text            // 策展陈述（locale）
  concept: json                 // Call A 的该概念原文 + Call B 审查结果，便于复盘
  alternatives: json            // 落选概念（kind, subject, title, score, 原因），仅内部/调试用，不展示给用户
  selection_trace: json         // 评分明细与惩罚项
  status: 'draft' | 'published' | 'dismissed' | 'completed'
  google_calendar_synced_at: text?
}

screenings {
  id PK, festival_id FK, user_id FK
  tmdb_id FK films
  position: integer             // 策展顺序 1..N
  role: 'opening' | 'centerpiece' | 'closing' | 'regular'
  program_note_md: text         // 场刊短评（locale，60–120 词）
  starts_at: text?              // ISO UTC；null = 未能排入
  ends_at: text?
  unscheduled_reason: text?
  calendar_uid: text            // `screening-{id}@fest-of-one`
  calendar_sequence: integer = 0
  google_event_id: text?
  feedback: 'watched' | 'skipped' | 'not_interested' | null
  feedback_at: text?
}
```

### 4.5 基础设施

```ts
jobs {
  id PK, user_id FK?
  type: 'sync_source' | 'enrich_films' | 'build_taste' | 'generate_festival' | 'push_google_calendar'
  payload: json
  status: 'queued' | 'running' | 'done' | 'failed'
  progress: integer 0-100, message: text?
  attempts: integer, error: text?
  heartbeat_at: text?           // worker 每 10s 刷新；超 2 分钟视为僵死可重试
  result: json?
}

llm_calls {
  id PK, user_id FK?, job_id FK?
  purpose: 'taste_memo' | 'ideate' | 'audit' | 'other'
  model, effort
  input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens
  cost_usd: real
  request_hash: text            // sha256(system + messages + tools)，用于调试复现
  response: json                // 完整 response（含 parsed_output）
  duration_ms
}
```

---

## 5. 数据接入层（Ingestion）

### 5.1 适配器接口

```ts
// src/sources/types.ts
export interface RawEntry {
  provider: 'letterboxd' | 'douban' | 'manual'
  externalId: string            // 去重键
  title: string                 // 原始标题（豆瓣可能是「中文名 / 原名」）
  year?: number
  tmdbId?: number               // Letterboxd RSS 直接给
  imdbId?: string               // 豆瓣 subject 页可抓到
  watchedAt?: string            // YYYY-MM-DD
  loggedAt?: string
  rating10?: number
  liked?: boolean
  rewatch?: boolean
  review?: string
  tags?: string[]
  listKind: 'watched' | 'watchlist'
  raw: unknown
}

export interface SourceAdapter {
  readonly provider: 'letterboxd' | 'douban'
  readonly mode: 'upload' | 'rss' | 'scrape'
  fetchAll(ctx: AdapterCtx): AsyncIterable<RawEntry>          // 全量
  fetchIncremental?(ctx: AdapterCtx, cursor: unknown): AsyncIterable<RawEntry>  // 可选
}
// AdapterCtx: { account, http (限速 fetch), log, onProgress(pct, msg) }
```

同步任务 `sync_source`：`adapter → upsert film_aliases → upsert watch_log/watchlist → 入队 enrich_films`。每一步幂等（以 `external_entry_id` 去重）。

### 5.2 Letterboxd

| 模式 | 输入 | 覆盖 | 说明 |
|------|------|------|------|
| `upload` | 官方导出 ZIP（Settings → Import & Export → Export your data） | 全量 | **主路径**。无需登录、无反爬。 |
| `rss` | `https://letterboxd.com/{username}/rss/` | 最近 ~50 条 diary | 增量同步用；每条含 `tmdb:movieId`，可直接匹配。 |
| `scrape` | `/{username}/films/by/date/page/N/` + 影片页 | 全量 | 可选，v1 不做；HTML 结构不稳定。 |

**ZIP 内文件与字段**（执行时用真实导出文件核对一次；以下为已知格式）：

| 文件 | 列 | 用途 |
|------|----|------|
| `watched.csv` | Date, Name, Year, Letterboxd URI | 看过（全集） |
| `ratings.csv` | Date, Name, Year, Letterboxd URI, Rating (0.5–5) | 评分 |
| `diary.csv` | Date, Name, Year, Letterboxd URI, Rating, Rewatch (Yes/空), Tags, Watched Date | 观看日期、重看、标签 |
| `likes/films.csv` | Date, Name, Year, Letterboxd URI | liked |
| `watchlist.csv` | Date, Name, Year, Letterboxd URI | 想看 |
| `reviews.csv` | Date, Name, Year, Letterboxd URI, Rating, Rewatch, Review, Tags, Watched Date | 影评文本 |

合并规则：以 Letterboxd URI 为 `externalId`。`watched.csv` 定全集；`diary.csv` 每行一条 `watch_log`（可多次观看）；没有 diary 行的 watched 条目生成一条 `watched_at = null` 的记录；`ratings.csv` 的评分覆盖到该片所有记录的最新一条；`likes` 置 `liked`。

**RSS 字段**：`title`、`link`、`guid`、`letterboxd:filmTitle`、`letterboxd:filmYear`、`letterboxd:memberRating`、`letterboxd:watchedDate`、`letterboxd:rewatch`、`tmdb:movieId`、`description`（含 HTML 影评）。注意：只在影片页打星、没写 diary 的评分不会出现在 RSS。游标 = 最新 `guid`。

### 5.3 豆瓣

豆瓣无官方 API（2018 年关闭），无官方导出。提供两条路径，**都要在设置页明确标注「非官方、可能失效」**：

| 模式 | 输入 | 说明 |
|------|------|------|
| `upload` | 第三方导出 CSV / Excel | **主路径**。常见格式（如社区工具导出的 `影视.csv`）：`title, url, date, rating, status, comment`。解析时按列名启发式识别：含 `url`/`链接` 的列取 subject id；`status`/`状态` 含「看过」「想看」；`rating`/`评分` 1–5 或「力荐/推荐/还行/较差/很差」映射 5..1。 |
| `scrape` | 豆瓣 people id + 登录 Cookie | 抓 `https://movie.douban.com/people/{id}/collect?start={n}&sort=time&rating=all&filter=all&mode=grid`，每页 15 条；想看为 `/wish`。每条取 subject id（`a[href*="/subject/"]`）、标题、`span.date`、评分 class `rating{1-5}-t`、`span.comment`。限速：**每请求 2–4 秒随机间隔**，单次同步最多 100 页；遇 403 / 跳转验证页立即停止并报错「需要重新提供 Cookie 或改用上传」。游标 = 已抓页数 + 最新 subject id（增量只抓到上次最新为止）。有报告称豆瓣网页已加 PoW 挑战，若抓取确实不可行，退化为只支持上传。 |

**豆瓣 → TMDB 匹配**（在 Resolver 中）：
1. 若允许抓取，访问 `https://movie.douban.com/subject/{id}/` 取 `IMDb: tt…`（同样限速），用 TMDB `/find/{imdb_id}?external_source=imdb_id`。
2. 否则把标题按 ` / ` 拆成「中文名」「原名」，分别用 TMDB `search/movie`（`language=zh-CN` 和 `en-US`）+ 年份匹配。

### 5.4 Resolver（匹配）

```
resolve(alias):
  1. alias.tmdb_id 已有（RSS）          → matched, confidence 1.0
  2. imdb_id 已有                        → TMDB find → matched 0.98
  3. search/movie(query=title, year=y)   → 对前 10 个候选打分：
       score = 0.6·titleSim + 0.25·yearMatch + 0.15·log(vote_count+1)/10
       titleSim = max(sim(q, title), sim(q, original_title), sim(q, title_zh))（规范化：小写、去标点、全半角）
       yearMatch = 1 (同年) / 0.6 (±1) / 0
     ≥ 0.85 且与第二名差 ≥ 0.1 → matched
     0.6–0.85 或差距小          → ambiguous（存 candidates 给 UI）
     < 0.6 / 无结果             → unmatched
  4. 用户在 /library 手工选择 → confirmed（永不再自动覆盖）
```

匹配结果回填 `watch_log.tmdb_id`。同一 TMDB id 来自两个 provider 时视为同一部片。

### 5.5 TMDB 富化

- `GET /3/movie/{id}?append_to_response=credits,keywords,external_ids&language=zh-CN`，再用 `language=en-US` 取英文标题 / 简介（两次请求；或一次取 en，再 `/translations` 取 zh）。
- `directors` = crew 中 `job == 'Director'`；`cast_top` = cast 前 10；`countries` = production_countries ∪ origin_country。
- 并发 4，429 时指数退避；`enriched_at` 非空则跳过（30 天后可刷新）。
- 认证：`Authorization: Bearer ${TMDB_READ_TOKEN}`。

### 5.6 手动添加

`/library` 页有搜索框直接调用 TMDB search，用户可把片加为「看过」（provider `manual`）；也用于解决 `ambiguous`。

---

## 6. 品味画像（Taste Profile）

目标：给策展引擎两样东西——(a) 可计算的统计事实；(b) 一段 LLM 写的、结构化的「这个人是什么样的观众」。两者都要**确定性序列化**，作为缓存前缀复用。

### 6.1 统计层 `TasteStats`（纯代码）

```ts
TasteStats {
  counts: { films, rated, liked, rewatched, last90d }
  rating_dist: Record<'1'..'10', number>
  directors: { name, n, avg10, liked, evidence: tmdb_id[] }[]   // n ≥ 2，按 n·avg 排序，取前 40
  countries: { code, n, avg10 }[]
  decades: { decade, n, avg10 }[]
  genres: { name, n, avg10 }[]
  languages: { code, n }[]
  actors: { name, n, avg10 }[]                                  // n ≥ 3，前 40
  keywords: { kw, n }[]                                         // 前 60
  loved: tmdb_id[]        // rating10 ≥ 9 或 liked
  disliked: tmdb_id[]     // rating10 ≤ 4
  register: {             // 商业/类型片容忍度指标，仅作参考
    share_high_popularity: number      // popularity 在该年 top 分位的片占比
    avg10_high_popularity: number      // 他给这类片的平均分
    share_festival_core: number        // 关键词/国别/低 vote_count 组合的艺术片占比
  }
  pace_per_week: number                 // 近 180 天
  runtime_tolerance_p90: number
}
```

### 6.2 备忘层 `TasteMemo`（LLM，`purpose: 'taste_memo'`）

输入：第 6.3 节的完整观影记录 + `TasteStats`。输出 zod schema：

```ts
TasteMemo {
  summary: string                       // locale，250–450 词，像一位资深策展人写的观众素描
  register: {
    art_house: number                   // 0–1
    auteur_genre: number                // 作者性类型片（Carpenter、Mann、朴赞郁…）
    mainstream_commercial: number
    note: string                        // 他如何对待类型/商业片：哪种能看、哪种不行
  }
  affinities: { kind: 'director'|'country'|'era'|'movement'|'form'|'theme'|'actor'|'studio',
                name: string, strength: number, evidence: number[] /* tmdb_id */, note: string }[]
  aversions: { pattern: string, strength: number, evidence: number[] }[]
  frontiers: { description: string, why_adjacent: string, seed_films: number[] }[]   // 值得被策展去开拓、但他还没系统看过的方向
  habits: { pace_per_week: number, runtime_tolerance_min: number, rewatch_tendency: 'low'|'mid'|'high' }
  do_not_program: string[]              // 推断出的硬规则，如「超级英雄系列」「翻拍的好莱坞版本」
}
```

重建时机：`watch_log_hash` 变化且新增 ≥ 20 条，或距上次 ≥ 30 天，或用户点「重建画像」。`effort: 'high'`。

### 6.3 观影记录序列化（给 prompt 用）

**必须确定性**：按 `tmdb_id` 升序，字段固定，不含时间戳、不含随机 ID。每行：

```
{tmdb_id}|{title_en} ({year})|{directors joined by &}|{countries joined by ,}|{rating10 or -}|{flags}|{last_watched YYYY-MM or -}
6977|No Country for Old Men (2007)|Joel Coen & Ethan Coen|US|9|L|2024-03
```

flags：`L` liked、`R` rewatch、`W` 多次观看、`D` 不喜欢(≤4)。未匹配 TMDB 的条目也要进（`tmdb_id` 写 `?`，用 raw title），保证「全部看过的都在」。

约 18–25 token/行。> 6000 行时分两段：`FULL`（有评分、liked、近 3 年）保留完整行，`INDEX` 段只保留 `tmdb_id|title (year)`。两段仍覆盖全部片名。

Watchlist 单独一段（`WATCHLIST:` 前缀），策展时可优先从中选（他已经表达过兴趣），但不强制。

---

## 7. 策展引擎（Curator）— 核心

### 7.1 流水线

```
generateFestival(request):
  0. slots   = deriveSlots(availability, prefs)          // 第 8 章
     if film_count == 1: mode = 'single'
     feasibility check（可用槽位 ≥ film_count，否则 job 失败并给出提示）
  1. ctx     = assembleContext(user)                      // 缓存前缀：curator system + memo + watch log
  2. ideate  = callA(ctx, request, avoid, recentHistory)  // 4–6 个概念，每个 2N–3N 候选；可调 TMDB 工具
  3. ground  = groundCandidates(ideate)                   // TMDB 落地、剔除已看、补片长
  4. audits  = Promise.all(concepts.map(c => callB(ctx, c, N)))   // 片单审查，输出恰好 N 部的 slate
  5. choice  = select(audits, history, slots, mode)      // 确定性评分 → 唯一结果
  6. sched   = schedule(choice.slate, slots, days, prefs) // 确定性排期
  7. persist festival + screenings; emit calendar; done
```

每个 LLM 调用都用相同的 `tools` 数组 + 相同的 `system` 前缀，保证 cache 命中。

### 7.2 上下文装配与缓存布局

渲染顺序 `tools → system → messages`。前缀稳定性从前到后：

```
tools:   [search_films, get_filmography, discover_films, get_film]   // 固定顺序，字面相同
system:
  [0] CURATOR_SYSTEM_PROMPT（冻结文本，见 7.9）                              cache_control: ephemeral, ttl 1h
  [1] "## Viewer memo\n" + JSON.stringify(memo, sortedKeys) + "\n## Stats\n" + stats   cache_control: ephemeral, ttl 1h
  [2] "## Complete watch log\n" + serializedWatchLog + "\n## Watchlist\n" + ...        cache_control: ephemeral, ttl 1h
messages:
  user: 本次请求（N、D、槽位摘要、近期影展、avoid 列表、locale、今天日期）  ← 只有这里变
```

- `system[2]` 是最大的一块（几万 token），同一用户同一天内的 A/B 调用、reroll 全部命中缓存。
- **禁止**在 system 里插入日期、用户 ID、随机数。日期只放在最后一条 user 消息。
- 4 个断点上限：这里用 3 个，第 4 个留给 Call B 的 concept 块（Call B 的多次并行调用共享前三个断点）。

### 7.3 Call A：概念生成（`purpose: 'ideate'`，effort `high`）

**工具**（TMDB 封装，服务器在每条结果上标注 `seen_by_viewer: boolean`，模型因此不会再选已看的片）：

| 工具 | 入参 | 返回 |
|------|------|------|
| `search_films` | `{ query, year? }` | 前 5：tmdb_id, title_en, original_title, year, directors, countries, runtime_min, vote_count, seen_by_viewer |
| `get_filmography` | `{ person: string, role: 'director' \| 'actor' }` | 人物匹配 + 全部作品按年：tmdb_id, title, year, character?, genres, vote_count, vote_avg, runtime_min, seen_by_viewer |
| `discover_films` | `{ countries?, year_from?, year_to?, keywords?, genres?, sort: 'vote_average' \| 'popularity' \| 'release_date' }` | 最多 40 条，同上字段 |
| `get_film` | `{ tmdb_id }` | 详情：overview, keywords, cast_top, directors, runtime |

实现用 `client.messages.create` 的手动循环（`while stop_reason === 'tool_use'`），并在同一请求上带 `output_config.format = zodOutputFormat(IdeateOutput)`；最多 12 轮工具调用；`end_turn` 后用 zod 解析 text 块，失败则追加一条 user `"Emit the final JSON now."` 再解析一次（合计最多两次）。工具定义 `strict: true`。

**user 消息内容**：

```
Today: 2026-10-13. Locale for all viewer-facing text: zh-CN.
Request: {N} films over {D} days this week. Mode: festival | single.
Available slots summary: 5 windows; longest 4h (Sat), weekday evenings ~2.5h. Max runtime that fits: 230 min.
Recent festivals (do not repeat kind 3 weeks running, never repeat subject within 12 weeks):
  - 2026-10-06 director · Hou Hsiao-hsien · [films]
  - 2026-09-29 motif · "Rooms without windows" · [films]
Avoid (from rerolls / feedback): kinds=[], subjects=["Tsai Ming-liang"], films=[...]
Propose 4–6 concepts covering at least 3 distinct kinds. ...
```

**输出 schema** `IdeateOutput`：

```ts
{
  concepts: {
    kind: 'director' | 'country' | 'actor' | 'motif'
    subject: string
    title: string                     // locale
    thesis: string                    // locale，150–300 词；必须引用观众自己看过的片（tmdb_id）作为依据
    why_now: string                   // 与他近期观看、frontiers 的关系
    candidates: {                     // 2N–3N 部，全部 seen_by_viewer=false
      tmdb_id: number                 // 必须来自工具结果
      title: string, year: number, director: string
      role_in_program: string         // 这部在展里承担什么
      connection: string              // 与母题/主体的具体联系（motif 类尤其要具体到场景/手法）
    }[]
    self_scores: { taste_fit: number, novelty: number, coherence: number, ambition: number }   // 0–1
  }[]
}
```

### 7.4 落地校验（代码）

对每个 candidate：
1. `tmdb_id` 在 `films` 里不存在 → 调 TMDB 详情；仍不存在 → 剔除。
2. 导演核对：候选的 `director` 与 TMDB `directors` 模糊相似度 < 0.7 → 剔除（幻觉信号）。
3. `tmdb_id ∈ watch_log(user)` → 剔除（硬规则，即使模型声称是重看企划）。
4. `tmdb_id ∈ avoid.tmdb_ids` 或 `not_interested` 反馈 → 剔除。
5. 缺 `runtime_min` → 富化；仍缺 → 剔除。
6. `runtime_min > 最长槽位` → 标记 `infeasible`（不剔除，交给审查，审查会避开）。
7. 剩余 < N → 该概念标记 `insufficient`，不进入审查。

### 7.5 Call B：片单审查（`purpose: 'audit'`，effort `medium`，各概念并行）

system 前三块同 A；第 4 块（带 cache 断点）是该概念的 thesis + 落地后的候选（含 TMDB 事实：genres、vote_count、keywords、runtime、infeasible 标记）。user 消息给 N、槽位约束、locale。

**审查规则（写进 prompt）**：
- 每一部都要回答：它是否真的属于这个论题？（演员回顾展：这是不是该演员「被论题谈论的那种表演」，还是为了凑数而放进来的商业片？）
- 对照 memo.register：`art` / `auteur_genre` / `commercial_good` / `commercial_disposable` 四档判定；`commercial_disposable` 一律剔除；`commercial_good` 只有当 `register.auteur_genre ≥ 0.4` 或论题本身就是类型片时保留。
- 母题类（motif）：每部的 `connection` 必须能落到具体的画面 / 手法 / 叙事装置，泛泛的「也涉及土地」不算。
- 剔除后若不足 N 部，不许从已看、已剔除里补；输出 `insufficient: true`。
- 给出顺序：`opening` 要能定调，`closing` 要有收束感；中段按时间、或按论证推进排列，说明理由。

**输出 schema** `AuditOutput`：

```ts
{
  decisions: { tmdb_id: number, keep: boolean, register: 'art'|'auteur_genre'|'commercial_good'|'commercial_disposable',
               fit_to_thesis: number, reason: string }[]
  insufficient: boolean
  slate: { tmdb_id: number, position: number, role: 'opening'|'centerpiece'|'closing'|'regular',
           program_note: string /* locale, 60–120 词 */, order_rationale: string }[]   // 恰好 N 部（insufficient 时可少）
  single_pick: number                   // 若只能放一部，选哪部
  revised_title: string, revised_statement: string      // locale，120–220 词，面向观众
  coherence: number, confidence: number                 // 0–1
}
```

代码再做一次校验：slate 全在 `keep=true` 内、无重复、无已看、`position` 1..N 连续；否则该概念作废。

### 7.6 选择策略（代码，确定性）

```
for each audited concept c (not insufficient):
  base = 0.35·taste_fit + 0.25·novelty + 0.20·coherence + 0.10·ambition + 0.10·confidence
  penalties:
    kind == lastWeek.kind                       −0.15
    kind == lastWeek.kind == twoWeeksAgo.kind   → 直接排除
    subject 在 12 周内出现过                     → 直接排除
    slate 总片长 > 槽位总容量                    → 直接排除
    任一 slate 片 infeasible 且无法换位           → 直接排除
  bonus:
    kind == 'motif' && coherence ≥ 0.75         +0.05   // 让有把握的专题展浮上来
    kind 4 周内未出现                             +0.03
  score = base + bonus − penalties
pick argmax；tie-break: motif > actor > country > director（偏向更难做的）
```

若全部被排除：放宽「同 kind 两周」惩罚重算；仍为空 → job 失败，提示增加可用时间或减少部数。`selection_trace` 记录每个概念的分项。

### 7.7 单部模式（N = 1）

- Call A 仍生成概念（给模型「为什么是这部」的推理空间），但 user 消息声明 `Mode: single`，要求每个概念给 `candidates` 3–5 部并标注 `if_only_one`。
- 跳过 Call B 的 slate 构造；改为一次轻量审查（同 prompt，N=1），各概念的 `single_pick` 汇总后按 `taste_fit·0.5 + novelty·0.3 + confidence·0.2` 选一。
- `festival.kind = 'single'`，`title` = 片名，`statement_md` = 150 词内的推荐语；UI 不出现「影展」字样。

### 7.8 换一个（reroll）

- 把当前 `festival` 置 `dismissed`；`festival_requests.avoid` 追加 `{ kinds: [], subjects: [cur.subject], tmdb_ids: slate }`。
- 重跑 2–7 步；缓存前缀不变，只多付输出 token。
- 同一 request 最多 reroll 5 次。

### 7.9 Prompt 文本

Prompt 用英文写（质量更稳），**所有面向观众的字段用 locale**。文本存为 `src/curator/prompts/*.md`，启动时读入并冻结；**修改 prompt 要同时 bump `PROMPT_VERSION`** 并写入 `llm_calls`。

**`curator.system.md`（冻结块 0）** — 要点，执行者据此成文：

```
You are the programmer of a one-person cinematheque. Your audience is a single viewer whose
complete viewing history, a curatorial memo about their taste, and statistics follow below.

Your job each week is to decide ONE programme for them — a retrospective (director, country/
region/movement, or actor) or a thematic programme built around a motif (costume, land, labour,
weather, rooms, money, voice, …) — and to argue for it the way a serious festival programmer would:
a thesis, a slate, an order, and short programme notes.

Rules you never break:
1. Never propose a film the viewer has already seen. Tool results mark seen_by_viewer; treat
   any such film as unavailable. If in doubt, call search_films to check.
2. Every film must come from tool results (it must have a tmdb_id). Do not invent titles.
3. Argue from THIS viewer's log. Cite the films they rated or liked as evidence for why a
   programme fits, and where it pushes them somewhere adjacent they have not been.
4. Respect the memo's register. An actor retrospective must be about the performances the
   thesis is about; do not pad with the actor's disposable commercial work. Well-made genre
   cinema is welcome when the viewer's register allows it or the thesis is about genre.
5. Avoid canon-dumping. A list of "important films" is not a programme. Prefer a sharp,
   defensible angle over breadth.
6. Thematic (motif) programmes must connect films through concrete images, devices or
   situations, not vague subject matter.
7. Write all viewer-facing text (titles, theses, statements, programme notes) in the locale
   given in the request. Keep programme notes 60–120 words, specific, no spoilers past the
   first act, no star ratings, no marketing language.
8. Do not output dates or times. Scheduling is done elsewhere; you only decide order.
```

**`ideate.user.md`**：7.3 的 user 消息模板。
**`audit.system.md` / `audit.user.md`**：7.5 的规则 + 概念块。
**`taste_memo.user.md`**：「Write the memo a programmer would keep about this viewer…」+ schema 说明。

### 7.10 Zod schema 位置

`src/curator/schemas.ts` 导出 `IdeateOutput`、`AuditOutput`、`TasteMemo`、各工具入参 schema。所有对象 `.strict()`；不用 `min/max` 数值约束（API 不支持，SDK 会剥掉并在客户端校验，但不要依赖它来约束模型）；用 `.describe()` 把约束写进描述。

### 7.11 LLM 调用规范

- SDK：`@anthropic-ai/sdk`，`new Anthropic()`（从 `ANTHROPIC_API_KEY` 读取）。
- 模型：**`claude-opus-5-5`**，全流程单一模型（缓存按模型隔离，混用会丢缓存）。
- 思考：不传 `thinking`（该模型默认 adaptive，`disabled` 会 400）。深度用 `output_config.effort`：`taste_memo`/`ideate` = `high`，`audit` = `medium`。
- 结构化输出：`client.messages.parse({ ..., output_config: { format: zodOutputFormat(Schema) } })`；`parsed_output` 为 null 时按解析失败处理。
- `max_tokens`：16000。
- 缓存：按 7.2 放 `cache_control: { type: 'ephemeral', ttl: '1h' }`；每次调用记录 `cache_read_input_tokens`，开发期在日志里打印命中率；连续为 0 即是前缀被污染。
- 工具：`strict: true`；`tool_choice` 保持默认 `auto`（该模型不支持强制 `any`/`tool`）。
- 错误：按 `Anthropic.RateLimitError` → `Anthropic.APIError` → 连接错误的顺序分别处理；SDK 自带 2 次重试，job 层再给 1 次。
- `stop_reason === 'refusal'`：本领域基本不会发生；记录并让 job 失败。可选：启用服务端 fallbacks（beta `server-side-fallback-2026-07-01`，`fallbacks: 'default'`，需走 `client.beta.messages`），作为 `LLM_ENABLE_FALLBACKS` 开关，默认关。
- 统一封装 `src/llm/call.ts`：`callStructured({ purpose, system, messages, tools?, schema, effort })`，负责：装配、调用、zod 校验、写 `llm_calls`、算成本。
- 成本参考（Opus 5.5：输入 $4 / 输出 $20 / 缓存读 $0.20 每百万 token；缓存写约 1.25× 输入价）：3000 部的观影记录 ≈ 60k token；一次生成 ≈ 1 次 A + 5 次 B，缓存冷启动一次。粗估每次生成 **$0.8–1.5**，reroll 约一半。

---

## 8. 排期器（Scheduler）

### 8.1 可用时间输入

- 周视图网格：7 天 × 30 分钟格；用户选择模式 `available`（涂的是能看的时间）或 `unavailable`（涂的是不能看的时间）。
- `unavailable` 模式在生成时取补集：`day_bounds` 内减去涂抹块。
- 保存一份 `week_start = 'template'` 的每周默认；具体周可覆盖。
- 「几天」`days`、「几部」`film_count` 与可用时间一起提交。

### 8.2 槽位推导 `deriveSlots`

```
windows = 合并相邻/重叠块，得到 { date, start, end }[]（用户时区）
每个 window 的容量 = floor((len + buffer) / (typicalRuntime + buffer))，typicalRuntime 取 110 分钟估算，仅用于可行性预检
feasibility:
  usableDays = 有 window 且最长 window ≥ 80 min 的天数
  if days > usableDays → 提示并把 days 降到 usableDays
  if film_count > Σcapacity → job 失败：「本周可用时间最多排 X 部」
```

### 8.3 分配算法 `schedule(slate, windows, days, prefs)`

输入：有序 slate（position 1..N，每部有 runtime）、windows、`days`、prefs。

```
1. 选天：从有 window 的日期里选 `days` 天，目标：
   - 总可用时长最大
   - 分布均匀（相邻选中日之间的间隔尽量平均）
   - 周末优先给最长的片
   枚举组合（周内最多 C(7,days) ≤ 35），按上述加权打分。
2. 配额：每天至少 1 部；N − days 部按「该天最长 window」降序分配，受 prefs.max_films_per_day 限制。
3. 放置（保持 position 顺序，不允许跨天乱序）：
   for day in 选中日按日期:
     for 该天配额内的下一部影片:
       在该天 windows 里找最早可放位置：start = max(window.start, prefs.preferred_start if fits)，
       要求 start + runtime + buffer ≤ window.end；工作日且 runtime > weekday_max_runtime_min 则跳过该位置
       放不下 → 回溯：尝试把这部换到后一天 / 把前一部提前
4. 回溯深度上限 N²；仍失败 → 放宽顺序约束（只固定 opening 第一、closing 最后）再试；
   仍失败 → 该片 starts_at = null，unscheduled_reason 写明，UI 提示用户加时间或减部数。
5. 产出 screenings[starts_at, ends_at]（UTC ISO），ends_at = starts_at + runtime（不含 buffer）。
```

### 8.4 规则与边界

- 两场之间至少 `buffer_min`。
- 单部模式只用第 3 步，选「最长的那个 window 的最早合适时间」。
- 重排（用户在日历里拖动）不由系统处理；系统只在 reroll 时重算。
- 所有时间计算用 `date-fns` + `date-fns-tz`，内部存 UTC，展示按 `user.tz`。

---

## 9. 日历导出

统一由 `src/calendar/` 产出，事件内容由 `buildEvent(screening)` 单点生成：

```
SUMMARY      : {festival.title} · {film.title_local} ({year})          // single: {film.title_local} ({year})
DESCRIPTION  : {program_note}\n\n导演 {directors} · {countries} · {runtime} 分钟\n{festival_url}\nTMDB: https://www.themoviedb.org/movie/{tmdb_id}
LOCATION     : （留空，不输出该行）
URL          : {festival_url}
UID          : screening-{id}@fest-of-one
SEQUENCE     : screening.calendar_sequence
DTSTART/DTEND: UTC（带 Z），避免 VTIMEZONE 复杂度
VALARM       : prefs.alarm_min 非空时，-PT{min}M
```

### 9.1 ICS 下载（Apple / 任意客户端）

`GET /api/festivals/{id}/calendar.ics` → `text/calendar; charset=utf-8`，`Content-Disposition: attachment`。一个 VCALENDAR 含 N 个 VEVENT。macOS/iOS 打开即导入全部场次。实现用 `ics` npm 包或手写（折行 75 字节、CRLF、转义 `,;\n`）。写完用 `node-ical` 解析回来做测试。

### 9.2 webcal 订阅（Apple + Google 都能用，推荐作为「一键」主路径）

`GET /api/cal/{calendar_token}.ics` → 用户所有 `published`/`completed` 影展、过去 30 天至未来 60 天的场次。页面提供 `webcal://{host}/api/cal/{token}.ics` 链接（Apple 点击即弹「订阅」）和「复制 URL」（Google 日历 → 其他日历 → 通过 URL 添加）。设置页可轮换 token。注意：Google 对订阅源刷新慢（可达数小时到一天），页面要写明。

### 9.3 Google 模板链接（单场、零授权）

每个场次一个按钮：
```
https://calendar.google.com/calendar/render?action=TEMPLATE
  &text={SUMMARY}&dates={YYYYMMDDTHHMMSSZ}/{YYYYMMDDTHHMMSSZ}&details={DESCRIPTION}&location=
```
值 `encodeURIComponent`。适合只加一场。

### 9.4 Google Calendar API 批量（「全部加入 Google 日历」）

- Auth.js Google provider 增量授权：scope `https://www.googleapis.com/auth/calendar.events`，`access_type=offline`、`prompt=consent` 拿 refresh token；token 存在 Auth.js 的 account 表。
- job `push_google_calendar`：对每个 screening `events.insert`（`calendarId=primary`，`iCalUID = calendar_uid` 保证幂等），记录 `google_event_id`；reroll/dismiss 时 `events.delete`；重排时 `events.update`。
- 用 `googleapis` 包或直接 fetch `https://www.googleapis.com/calendar/v3/calendars/primary/events`。
- 未授权时按钮触发授权流程后回到影展页自动继续。

### 9.5 Apple

没有 API；9.1 + 9.2 即为 Apple 的全部路径。

---

## 10. API 与页面

### 10.1 Route Handlers（`app/api/**`，全部需登录，除 webcal）

| 方法 路径 | 作用 |
|-----------|------|
| `POST /api/sources` | 新建来源：`{provider, handle, mode, cookie?}`；`multipart` 时接收 ZIP/CSV |
| `POST /api/sources/{id}/sync` | 入队 `sync_source`，返回 `job_id` |
| `DELETE /api/sources/{id}` | 删除来源及其 watch_log |
| `GET /api/jobs/{id}` | `{status, progress, message, result}` |
| `GET /api/library?status=ambiguous` | 观影记录 / 未匹配列表 |
| `POST /api/library/resolve` | `{alias_id, tmdb_id}` → confirmed |
| `POST /api/library/manual` | `{tmdb_id, watched_at?, rating10?}` |
| `GET /api/taste` / `POST /api/taste/rebuild` | 画像 |
| `GET/PUT /api/availability?week=YYYY-MM-DD\|template` | 可用时间 |
| `POST /api/festivals/generate` | `{week_start, days, film_count}` → `job_id` |
| `POST /api/festivals/{id}/reroll` | → `job_id` |
| `GET /api/festivals/{id}` | 影展 + screenings + films |
| `POST /api/festivals/{id}/feedback` | `{screening_id, feedback}` 或 `{dismiss: true}` |
| `GET /api/festivals/{id}/calendar.ics` | ICS |
| `POST /api/festivals/{id}/google-calendar` | 入队 `push_google_calendar` |
| `GET /api/cal/{token}.ics` | webcal（token 鉴权，无 session） |
| `POST /api/settings/calendar-token/rotate` | 轮换 |

入参全部 zod 校验；错误统一 `{ error: { code, message } }`。

### 10.2 页面（`app/**`）

| 路径 | 内容 |
|------|------|
| `/` | 未登录：介绍 + 登录；已登录：跳 `/plan` |
| `/onboarding` | 绑定来源（三张卡：Letterboxd 上传 / Letterboxd RSS / 豆瓣），同步进度 |
| `/library` | 观影记录表（搜索、按评分/年份筛）；「待确认」标签页做 ambiguous 解决；手动添加 |
| `/taste` | 画像展示：summary、register 三个条、affinities 芯片、frontiers；「重建」按钮 |
| `/plan` | 周选择器（本周/下周）、模式开关、涂抹网格、days / film_count、「生成」；底部显示上次模板 |
| `/festival/{id}` | 标题、陈述、海报墙；按日分组的排片（时间、片名、片长、场刊）；按钮：「换一个」「下载 .ics」「订阅日历」「加入 Google 日历（全部）」；每场旁有 Google 单场链接；反馈开关 |
| `/history` | 历次影展列表，状态与反馈 |
| `/settings` | 时区、locale、prefs、来源管理、日历 token、Google 授权状态、成本统计 |

UI 文案默认中文。海报用 `https://image.tmdb.org/t/p/w342{poster_path}`。

---

## 11. 后台任务

- `src/jobs/worker.ts`：循环 `SELECT ... WHERE status='queued' ORDER BY created_at LIMIT 1`，`UPDATE ... SET status='running'` 用条件更新防并发；每 10s 刷 `heartbeat_at`；处理完写 `done/failed`。
- 僵死恢复：启动与每分钟扫描 `running` 且 `heartbeat_at` 超 2 分钟 → 回 `queued`（`attempts+1`，≤ 3）。
- 每个 handler 幂等、可中断：同步用游标、富化跳过已富化、生成以 request 为单位（失败不留半个 festival；用事务）。
- 单 worker 进程即可；`generate_festival` 内部对 Call B 并行度 ≤ 6。
- 进度回报粒度：同步按条目数、富化按影片数、生成按步骤（`ideating` → `grounding` → `auditing (3/5)` → `scheduling`）。

---

## 12. 配置、安全、隐私

```
DATABASE_URL=file:./data/fest.db
AUTH_SECRET=
AUTH_GOOGLE_ID= / AUTH_GOOGLE_SECRET=
DEV_LOGIN=1                        # 本地：/api/auth/dev 直接以 dev@local 登录
ANTHROPIC_API_KEY=
TMDB_READ_TOKEN=
APP_ENCRYPTION_KEY=                # 32 字节 base64，加密豆瓣 Cookie
APP_BASE_URL=https://…
LLM_ENABLE_FALLBACKS=0
```

- 豆瓣 Cookie 只用于抓取，加密存储，UI 只显示「已设置」；用户可随时清除。
- `calendar_token` 泄露只暴露排片，不暴露评分；可轮换。
- 所有查询带 `user_id`；Drizzle 查询封装在 `src/db/repo/*` 中，禁止页面层直接拼 SQL。
- 日志不打印 Cookie、token、完整观影记录。
- 对 Letterboxd / 豆瓣 的请求带合理 UA、限速；不绕过验证码。

---

## 13. 测试与评估

| 层 | 方法 |
|----|------|
| 解析器 | `tests/fixtures/letterboxd-export/*.csv`、`douban-export.csv`、`douban-collect.html` 快照；断言 RawEntry |
| Resolver | 用录制的 TMDB 响应（`msw` 或 JSON fixture）测评分与阈值；中文标题、同名不同年、原名/译名用例 |
| 序列化 | 快照测试：同一输入两次输出字节相同；顺序改变输入顺序仍相同 |
| Scheduler | 基于属性的测试（`fast-check`）：不重叠、在窗口内、顺序单调、buffer 满足、单部模式；若干手写边界（只有一个 4h 窗口放 3 部、工作日超长片） |
| ICS | 生成后用 `node-ical` 解析回来比对字段；RFC 折行 |
| LLM 流水线 | `pnpm curate --user <id> --days 3 --count 4 [--dry]` CLI：打印概念、审查、评分、排期。固定 3 个合成画像作为 fixture（慢电影信徒 / 类型片通的影迷 / 华语片为主），跑后断言不变量：无已看片、恰好 N 部、全部 tmdb 落地、kind 轮换生效、所有文本为 locale。LLM 调用可用录制回放（`llm_calls.response`）离线跑。 |
| 成本 | 每次 CLI 运行打印 token 与缓存命中率；命中率 < 80%（热态）视为回归 |

---

## 14. 目录结构

```
fest-of-one/
  app/                         # Next.js App Router
    (auth)/…  plan/  festival/[id]/  library/  taste/  history/  settings/  onboarding/
    api/…
  src/
    db/        schema.ts  client.ts  migrate.ts  repo/*.ts
    sources/   types.ts  letterboxd-zip.ts  letterboxd-rss.ts  douban-csv.ts  douban-scrape.ts  manual.ts
    resolver/  tmdb.ts  match.ts  enrich.ts  normalize.ts
    taste/     stats.ts  memo.ts  serialize.ts
    curator/   context.ts  tools.ts  ideate.ts  ground.ts  audit.ts  select.ts  schemas.ts  prompts/*.md  index.ts
    scheduler/ slots.ts  schedule.ts
    calendar/  event.ts  ics.ts  google.ts  links.ts
    jobs/      queue.ts  worker.ts  handlers/*.ts
    llm/       client.ts  call.ts  cost.ts
    lib/       crypto.ts  http.ts(限速 fetch)  time.ts  ids.ts
  scripts/     curate.ts  dev-login.ts  seed-fixtures.ts
  tests/       fixtures/  unit/  property/  pipeline/
  drizzle/     migrations
  Dockerfile  docker-compose.yml  .env.example  package.json  pnpm-lock.yaml
```

`package.json` scripts：`dev`、`build`、`start`、`worker`、`db:migrate`、`db:studio`、`curate`、`test`、`lint`、`typecheck`。

---

## 15. 实施里程碑（按序执行，每步有验收）

| M | 内容 | 验收 |
|---|------|------|
| **M0** | 脚手架：Next.js + TS + Tailwind + Drizzle/SQLite + Auth.js（Google + DEV_LOGIN）+ jobs 表与 worker 骨架 + `.env.example` + Dockerfile | `pnpm dev` 与 `pnpm worker` 同时跑；dev 登录；一个 demo job 能排队→完成 |
| **M1** | Letterboxd ZIP 导入 → Resolver → TMDB 富化 → `/library`（含 ambiguous 解决、手动添加） | 用真实导出 ZIP 导入；匹配率 ≥ 95%；未匹配可手工确认 |
| **M2** | 画像：stats + memo + 序列化 + `/taste` | `/taste` 展示合理画像；序列化快照测试通过 |
| **M3** | 策展引擎（A→ground→B→select）+ `pnpm curate` CLI + 3 个 fixture 画像 + 不变量测试。**先在 CLI 上把 prompt 打磨到满意再接 UI** | CLI 对 3 个画像各出 1 个影展与 1 个单部推荐，通过不变量；缓存命中率热态 ≥ 80% |
| **M4** | `/plan` 可用时间 UI + scheduler + `/festival/{id}` + reroll | 端到端：涂时间 → 生成 → 页面展示带时间的排片；property 测试通过 |
| **M5** | 日历：ICS 下载、webcal、Google 模板链接、Google API 批量 | macOS 日历导入 .ics 全部场次；Google 通过 URL 订阅可见；API 批量写入后 reroll 能删旧事件 |
| **M6** | 豆瓣 CSV 上传 + 豆瓣抓取（带限速与失败提示）+ Letterboxd RSS 增量 | 两个来源的同一部片合并为一条 TMDB 记录；RSS 增量不重复 |
| **M7** | 反馈闭环（看了/跳过/不感兴趣 → 下一次策展的 avoid 与历史）+ `/history` + `/settings` + 成本统计 + 部署文档 | 反馈后再生成，被标「不感兴趣」的片不再出现；Docker 一键起 |

每个里程碑一个 PR；PR 描述里写「偏离本文档之处及原因」。

---

## 16. 已知风险与未决项

| 风险 | 应对 |
|------|------|
| 豆瓣反爬（PoW / 验证码）导致抓取不可用 | 上传 CSV 是主路径；抓取失败要给清晰指引而非静默空结果 |
| Letterboxd 导出字段变化 | 解析器按列名而非列序读取；缺列降级 |
| TMDB 中文标题缺失 / 片长缺失 | 回退 en 标题；片长缺失的片不进 slate |
| 模型提出的片在 TMDB 不存在或导演对不上 | 7.4 硬过滤；统计剔除率，> 30% 说明 prompt 或工具需要调 |
| 观影记录极大（> 8000 部）导致前缀过大 | 6.3 的 FULL/INDEX 分段；仍保证全部片名在场 |
| 缓存前缀被无意污染（日期、排序不稳定） | 7.2 规则 + 命中率监控 |
| Google 订阅源刷新慢 | 页面写明；提供 API 批量路径 |
| 用户可用时间太碎，排不下 | 8.2 预检 + 8.3 的「未排入」显式提示 |

**未决项（执行时按默认处理，之后可改）**：
- 影展页是否展示落选概念：默认**不展示**（P1）。
- 单部模式是否允许 watchlist 优先：默认允许但不强制。
- 是否支持「下周」以外更远的周：默认只支持本周与下周。

---

## 附录 A · TMDB 端点清单

| 用途 | 端点 |
|------|------|
| 搜索 | `GET /3/search/movie?query=&year=&language=zh-CN\|en-US&include_adult=false` |
| 外部 ID 查找 | `GET /3/find/{imdb_id}?external_source=imdb_id` |
| 详情 | `GET /3/movie/{id}?append_to_response=credits,keywords,external_ids&language=…` |
| 人物搜索 | `GET /3/search/person?query=` |
| 人物作品 | `GET /3/person/{id}/movie_credits` |
| 发现 | `GET /3/discover/movie?with_origin_country=&primary_release_date.gte=&primary_release_date.lte=&with_keywords=&with_genres=&sort_by=&vote_count.gte=` |
| 关键词搜索 | `GET /3/search/keyword?query=` |
| 海报 | `https://image.tmdb.org/t/p/w342{poster_path}` |

所有请求 `Authorization: Bearer {TMDB_READ_TOKEN}`；本地 `films` 表作缓存，详情 30 天内不重复拉。

## 附录 B · 评分映射

| 来源 | 原始 | rating10 |
|------|------|----------|
| Letterboxd | 0.5–5 星（步长 0.5） | ×2 → 1–10 |
| 豆瓣 | 1–5 星 / 很差·较差·还行·推荐·力荐 | ×2 → 2,4,6,8,10 |
| 本应用「看了」 | 无评分 | null |

## 附录 C · 影展类型定义（供 prompt 与 UI 共用）

| kind | 定义 | 典型 subject |
|------|------|--------------|
| `director` | 一位导演的作品切片（不必全集，可以是「早期」「某一母题」） | "Claire Denis, the colonial body" |
| `country` | 国家 / 地区 / 运动 / 时代 | "Iran after 1997", "Taiwanese New Cinema's second wave" |
| `actor` | 一位演员的表演切片，经片单审查 | "Isabelle Huppert, refusal as a style" |
| `motif` | 跨导演跨国别的母题 / 装置 / 物 | "Costume as armour", "Land that outlives its owners", "Phone calls we never hear the other side of" |
| `single` | N = 1 | — |
