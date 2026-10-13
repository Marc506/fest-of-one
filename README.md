# fest-of-one · 一个人的影展

读取 Letterboxd / 豆瓣观影记录 → 品味画像 → Claude 自行决定策展角度并排片 → 一键加入 Apple / Google 日历。

完整规格见 [`ARCHITECTURE.md`](./ARCHITECTURE.md)；执行约定见 [`CLAUDE.md`](./CLAUDE.md)。

## 本地开发

```bash
pnpm install
cp .env.example .env        # 填 AUTH_SECRET；本地可 DEV_LOGIN=1
pnpm db:migrate
pnpm dev                    # web  → http://localhost:3000
pnpm worker                 # 另开终端：后台任务
```

`DEV_LOGIN=1` 时首页有「开发登录」，或直接访问 `/api/auth/dev`，以 `dev@local` 登录。

| 命令 | 作用 |
|------|------|
| `pnpm dev` / `build` / `start` | Next.js |
| `pnpm worker` | 常驻 worker（`--once` 处理完队列即退出） |
| `pnpm db:generate` | 改了 `src/db/schema.ts` 后生成迁移到 `drizzle/` |
| `pnpm db:migrate` / `db:studio` | 迁移 / Drizzle Studio |
| `pnpm curate` | 策展引擎 CLI（M3） |
| `pnpm test` / `lint` / `typecheck` | 测试 / 静态检查 |

## Docker

```bash
cp .env.example .env   # 填好
docker compose up -d --build   # web + worker 两个容器，SQLite 在 ./data
```

## 实现说明与偏离（按里程碑累积）

### M0

- `jobs.type` 增加 `demo`（仅开发，用来验收「demo job 排队→完成」）。
- 数据模型一次性按第 4 章全部建好（一个初始迁移），后续里程碑只做增量迁移。
- 额外字段：`watch_log.source_id` / `watchlist.source_id`（支持「删除来源及其 watch_log」的级联）；
  `film_aliases.imdb_id_raw`（resolver 第 2 步要用）与 `match_status = 'pending'`（尚未解析）；
  `taste_profiles.watch_log_count`（「新增 ≥ 20 条」判断）；`festival_requests.reroll_count`（reroll 上限 5）；
  `llm_calls.prompt_version`（7.9 要求写入）。
- Auth.js 用 JWT 会话（Credentials 形式的 DEV_LOGIN 需要），账户 / refresh token 仍由 Drizzle adapter 落库；
  Auth.js 表名加 `auth_` 前缀。
- 非 Next 进程（worker、CLI）用 `@next/env` 加载 `.env*`，与 Next 同规则。

### M1

- `RawEntry` 增加 `entryId`：Letterboxd `diary.csv` / `reviews.csv` 里的 URI 是「日志条目」链接而不是影片链接，
  所以 diary 行按 (Name, Year) 关联到 `watched.csv` 的影片，条目 URI 作为 `watch_log.external_entry_id`。
- Resolver 打分中 `log` 取自然对数并截到 1；**年份未知时**（部分豆瓣条目）年份权重按比例分给标题与热度，否则永远到不了 0.85。
  ambiguous 候选额外存 `original_title` / `vote_count`，方便同名同年片在 UI 上区分。
- 富化在 `enrich_films` 任务里一并做「解析 pending 条目」；同步只负责落 alias / watch_log。
- 新增 `GET /api/tmdb/search`（/library 搜索框用）与 `GET /api/sources`（列来源）。
- 上传模式的全量同步会清理该来源下本次导出里已不存在的条目（用户在 Letterboxd 删除了）。
- **离线 TMDB**：设置 `TMDB_FIXTURE_CATALOG=<catalog.json>` 时用本地片目（`CatalogTmdbClient`，返回与 TMDB 同形的数据）
  代替 HTTP；用于测试、`pnpm curate` fixture，以及无 TMDB 网络时的本地开发。
- 验收「真实导出 ZIP 匹配率 ≥ 95%」在本环境无法执行（TMDB 与 Letterboxd 被网络策略拦截，也没有真实导出），
  用合成导出 + 录制的 TMDB 响应 + 离线片目做了等价测试；拿到 token 后请用真实 ZIP 复核一次。

### M2

- 画像 LLM 调用的 system 布局：`[0]` 策展 system（与策展调用共享缓存）`[1]` `## Stats` `[2]` 完整观影记录；三块都带 1h 缓存断点。
- `TasteStats.register` 的三个指标是近似：「高热度」用 TMDB `vote_count ≥ 4000` 代替「该年 popularity 分位」；
  「影展核心」= `vote_count < 1500` 且非美国出品，或 `vote_count < 800` 的剧情片。演员只统计前 5 位主演。
- 序列化 FULL / INDEX 分段里的「近 3 年」以记录中最晚的观看日期为锚点（不是今天），保证同一份记录永远同样的字节。
- 重建策略：记录 hash 变化且（新增 ≥ 20 部 或 距上次 ≥ 30 天），或手动「重建画像」；记录完全没变时 30 天到期不重建。
  策展时观影记录块总是从数据库现取（P3），只有备忘可能略旧。
- 未配置 `ANTHROPIC_API_KEY` 时 `build_taste` 只写统计层（memo 为空），`/taste` 照常展示统计。
- LLM 层：无工具的结构化调用用 `messages.parse`；Call A 的工具循环用 `messages.create` + 本地 zod 校验（7.3）。
  `messages.parse` 在解析失败时抛错、拿不到原始响应，所以只能「整次重试一次」，部分文本的 refusal 也会表现为解析失败。
- 备忘的数值在代码侧夹到 0–1，证据 tmdb_id 只保留观影记录里真实存在的。prompt 要求不假设观众性别。

### M3

- `pnpm curate`：`--persona slow|genre|sinophone|all` 用 3 个合成画像 + 446 部离线片目（`tests/fixtures/catalog`，
  部分 tmdb_id 是合成的，只用于离线测试）；`--mock` 用确定性桩代替 Claude（文本是占位、用量是模拟值，
  用来跑通流水线与不变量，**不代表 prompt 质量**）；`--replay` 按 request_hash 回放 `llm_calls` 里的录制响应；
  不带这两个开关时调用真实的 `claude-opus-5-5`（需要 `ANTHROPIC_API_KEY`）。
- **prompt 未经真实 API 打磨**：本环境没有 API key、TMDB 也不可达。CLAUDE.md 要求 M3 先在 CLI 上把 prompt 打磨满意再接 UI；
  这一步需要有 key 的人来做：`pnpm curate --user <你> --days 3 --count 4`，看概念 / 审查 / 评分 / 缓存命中，改
  `src/curator/prompts/*.md` 并 bump `PROMPT_VERSION`。
- 结构化输出的 JSON Schema 自己生成（`strictJsonSchema`），解析与校验仍用 SDK 的 `zodOutputFormat`：
  SDK 0.133 的 transformJSONSchema 会把 `enum` 挪进 description（失去约束），zod 的 `.int()` 还会带 ±2^53 边界。
- Call A 的工具循环在最后一条消息上放第 4 个缓存断点（7.2 说第 4 个留给 Call B 的概念块——Call A 里它本来空着）。
- Call B 先单独跑一个「暖缓存」，再并行其余（≤ 6）：并发请求互相读不到对方刚写的缓存。
- 选择时 coherence / confidence 取 Call B（审查后），taste_fit / novelty / ambition 取 Call A 自评；
  「slate 排不进可用时间」用真实排期器判定（而不是只比总片长与容量）。
- 落地校验额外剔除「近 12 周已经排过的片」；注定会被排除的概念（回避 / 12 周内同主题）不再花钱审查。
- 排期器：天数排不下时依次尝试「放宽顺序」→「相邻天数」→ 贪心兜底（结果标记 `order: strict | relaxed | any`）；
  preferred_start 只在当天所有场次仍放得下时采用。
- 单部模式的 festival.subject 用「片名 (年份)」，标题用片库里的本地化片名（没有中文译名时是原名 / 英文名）。
- 日本片的纯汉字原名在无 zh-CN 译名时也作为中文标题（之前会被丢弃）。

### M4

- `/plan`：本周 / 下周、「涂能看的时间 / 涂没空的时间」两种模式、7 天 × 30 分钟格（08:00–24:00，鼠标与触屏都能拖涂）、
  几天 / 几部；生成前先把这一周的涂抹存为该周可用时间，也可「存为每周模板」。没有任何设置时用默认模板（工作日晚上 + 周末下午）。
- 生成：API 先做同步可行性预检（不可行直接 422 告诉用户），再入队 `generate_festival`；同一 request 被重试时复用已生成的影展（幂等）。
- 换一个：当前影展置 dismissed，`avoid.subjects` / `avoid.tmdb_ids` 累积，同一 request 最多 5 次；`avoid.kinds` 保持空（7.8）。
- 开发 / 演示开关 `LLM_TRANSPORT=mock|replay`（默认真实 API）与 `scripts/seed-fixtures.ts`（把某个 fixture 画像的观影记录复制给
  dev@local），配合 `TMDB_FIXTURE_CATALOG=data/fixtures/catalog.json` 可在没有任何 key 的情况下走通整个 UI。
- API 错误码：业务上不可行（UserFacingError）统一 422 `unprocessable`。

### M5

- ICS 手写（RFC 5545）：CRLF、按 75 字节折行且不切断多字节字符与转义序列、UTC 时间、无 LOCATION（P7）、`alarm_min` → VALARM；
  用 `node-ical` 回读做测试。webcal 订阅源带 `REFRESH-INTERVAL` / `X-PUBLISHED-TTL`（6 小时，客户端未必遵守）。
- Google API：`insert` 带 `iCalUID = calendar_uid`，409 时按 iCalUID 查到已有事件再 `update`（幂等）；已有 `google_event_id` 直接 update；
  换一个时，若旧影展写过 Google 日历，自动入队 `push_google_calendar(action=delete)`。
- Auth.js 只在第一次关联账户时保存 OAuth 令牌，增量授权后的新 scope / refresh token 不会写回——用 `events.signIn` 每次 Google 登录时更新 account 行。
- 增量授权用 server action `signIn('google', …, { scope: '… calendar.events', access_type: 'offline', prompt: 'consent' })`，
  回到 `/festival/{id}?gcal=1` 后自动继续写入。
- 验收「macOS 日历导入 / Google 订阅可见 / API 写入后 reroll 删除旧事件」在本环境只能用回读与假 Google API 测试覆盖
  （没有 Google OAuth 凭据、没有 macOS）；部署后请用真实账号复核一次。
