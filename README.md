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
pnpm diagnose               # 自检 .env / 数据库 / TMDB / Claude API 连通性（只读，不花钱）
```

在中国大陆：Node 不走系统代理，TMDB 与 Claude API 需要在 `.env` 里设 `HTTPS_PROXY=http://127.0.0.1:7890`
（端口换成代理软件的 HTTP 代理端口），然后重启 `pnpm dev` 与 `pnpm worker`。注意 `pnpm doctor` 是 pnpm 自带命令，自检请用 `pnpm diagnose`。

`DEV_LOGIN=1` 时首页有「开发登录」，或直接访问 `/api/auth/dev`，以 `dev@local` 登录。

### 没有任何 key 也能走通全流程（离线演示）

```bash
pnpm tsx scripts/seed-fixtures.ts --as dev@local --persona sinophone   # 446 部离线片目 + 把一个合成画像的观影记录给 dev@local
export TMDB_FIXTURE_CATALOG=data/fixtures/catalog.json LLM_TRANSPORT=mock
pnpm dev & pnpm worker
```

`LLM_TRANSPORT=mock` 是确定性的离线桩，文本是占位；真实策展需要 `ANTHROPIC_API_KEY`（去掉 `LLM_TRANSPORT`）。

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

详细部署（Google OAuth、TMDB、单容器模式、备份、升级）见 [`docs/DEPLOY.md`](./docs/DEPLOY.md)。

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

### M6

- 豆瓣上传：CSV 与 Excel（多工作表时表名可表示「看过 / 想看」）；按列名启发式识别，「在看」跳过；缺必需列时给出明确错误。
- 豆瓣抓取：Cookie 用 AES-256-GCM 加密保存（`APP_ENCRYPTION_KEY`），UI 只显示「已设置」，可随时清除（`PATCH /api/sources/{id}`）；
  每请求 2–4 秒随机间隔、单次最多 100 页；403 / 跳转验证或登录页 → 立刻停止并提示「需要重新提供 Cookie 或改用上传」；
  游标 = 最新 subject id。新条目 ≤ 60 时顺带抓 subject 页的 IMDb 号（resolver 用 TMDB find 精确匹配），条目太多时不抓（否则一次同步要几个小时）。
  本环境访问不到豆瓣，用 HTML fixture 测试。
- Letterboxd RSS：影片键 `letterboxd:tmdb:{id}`（RSS 没有 boxd.it 影片链接），与 ZIP 的同一部片在 tmdb_id 层合并；
  RSS 写入时跳过「同 tmdb_id + 同观看日期」已存在的观看；ZIP 在 RSS 之后导入时无法在写入时去重（那时还没匹配 TMDB），
  所以「看了几次」统一按**不同的观看日期**计数（W 标记、片库 ×N）。worker 每 10 分钟检查，距上次 ≥ 12 小时的 RSS 来源自动增量同步。
- 跨来源合并：Letterboxd 与豆瓣的同一部片在片库里是一行（providers 同时列出两者）。

### M7

- 反馈：每场「看了 / 没看 / 不感兴趣」，再点一次撤回。「看了」写一条 `provider = fest` 的 watch_log（从此算看过）；
  「不感兴趣」进入落地校验的硬过滤，也写进 Call A user 消息的 avoid 列表；历史里的每部片带上反馈标注给策展人看。
  全部场次都有反馈 → 影展 `completed`；`/plan` 会提示上周还没反馈的影展。`{dismiss: true}` 把影展置 dismissed（并删除已写入的 Google 事件）。
- `/history`：历次影展（默认隐藏换掉的）、反馈统计。`/settings`：时区、语言、排期偏好、来源入口、webcal 地址与轮换、
  Google 授权状态、Claude API 用量（近 30 天 / 全部，按用途，含缓存命中率与估算美元）。
- 部署：构建阶段用完整的 `node:22-bookworm`（自带编译工具，不需要 apt-get），运行阶段用 slim；构建时预置 pnpm（运行时不联网）；
  `/api/health` + Docker HEALTHCHECK；compose 里 worker 等 web 健康后启动；`pnpm start:all` 单容器模式。
  已在本环境用 Docker 实测：`docker compose up` → web 健康、自动迁移，worker 从共享的 SQLite 卷取任务执行。
  （本地验证时为了走沙箱出口代理额外注入了代理 CA，那几行不在仓库里。）镜像约 1.7 GB（保留了 dev 依赖，worker 直接用 tsx 跑源码）。

### 豆瓣导出的实际格式（M6 补充）

- 社区工具 [douban-frodo-export](https://github.com/daymade/claude-code-skills/tree/main/douban-skill)（`DOUBAN_USER=<id> python3 scripts/douban-frodo-export.py`，
  不需要 Cookie，主页需公开）导出的 `影视.csv` 列为 `title, url, date, rating, status, comment`，评分是 `★`–`★★★★★`——已支持。
- 这份 CSV **没有年份**，匹配只能靠中文片名 + 热度；同名片会进「待确认」。`影视.csv` 里也有电视剧，TMDB 电影库匹配不上，会留在「待确认」，可以忽略。
- 豆瓣网页现在有 PoW 验证，Cookie 抓取多半会被拦（应用会立刻停下并提示改用上传）。

### TMDB 连不上时（M7 之后补充）

- 出站请求支持 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY`（`undici` 的 `EnvHttpProxyAgent` 设为全局 dispatcher；web 进程经 `instrumentation.ts`，worker / CLI 经 `load-env`）。
- `enrich_films` 先请求一次 genre 列表做预检：连不上或令牌错误时几秒内失败，并在页面上说明原因（网络 → 设代理；401 → 检查 Read Access Token），
  不再进入「逐条重试 → 整体重排队」。逐条匹配时若开头 20 条全部失败也会立刻停下。修好后点「重新同步」即可，导入幂等。
- 偏离：原先全部失败时抛 `RetryableError` 让 job 重排队一次；连不上是配置问题，重跑只会浪费时间，改为 `UserFacingError` 直接失败。

### 近期权重（M7 之后补充）

越早看的记录越不代表现在的口味。每部片按「距最近一次观看的时间」算一个 0–1 的权重（`src/taste/recency.ts`）：

- `base = floor + (1 − floor) · 0.5^(年数 / 半衰期)`；喜欢 / ≥9 / ≤4 的片找回失去权重的 60%，8 分找回 30%；重看会刷新时间。
- 档位在「设置」里选：关闭 / 轻微（8 年，0.6）/ **适中（4 年，0.4，默认）** / 较强（2 年，0.25）。改档位会自动重建画像。
- 锚点是记录里最晚的观看日期而不是今天，所以同一份记录的序列化字节不变（缓存前缀稳定），system 里也不出现日期。
- 偏离 6.1：统计层各桶多一个 `w`（折算后的有效部数）；导演 / 演员按 Σw ×（加权均分）排序，国别 / 类型 / 语言 / 关键词按 Σw 排序；`n` 与 `avg10` 仍是原始值。新增 `recency` 字段记录所用档位。
- 偏离 6.3：开启时 FULL 行末多一列 `|weight`，格式行里解释含义；关闭时与 6.3 完全一致。所有看过的片仍完整进入 prompt（P3），权重只影响「怎么读」，不影响「已看不可排」。
- prompt 升到 v2：策展 system 与画像备忘说明如何使用权重（以当下的口味为准，强烈表态的老片仍然算数）。

### 豆瓣条目的匹配：年份与剧集（M7 之后补充）

豆瓣导出没有年份，又混着剧集，第一次导入时大量条目进了「待确认」。现在的规则（`src/resolver/match.ts`、`src/resolver/wikidata.ts`）：

1. **Wikidata**：先用豆瓣 subject id 批量查 Wikidata（P4529 → TMDB 电影 P4947 / 剧集 P4983、IMDb P345、发行日期 P577、类型 P31）。
   有 TMDB 电影编号就直接对上；是剧集就标「非电影」；只有年份 / IMDb 就补到条目上再走 TMDB。只发豆瓣条目 id，不发用户信息；
   连不上或没收录都不算错（`WIKIDATA_LOOKUP=0` 关闭）。`pnpm diagnose` 会检查它能不能用。
2. **观看日期截断**：候选的上映年份不能晚于「最晚一次看过的年份 + 1」（豆瓣是标记日期），同名翻拍常常因此只剩一部。
3. **繁简统一**：标题比较前繁体转简体（`opencc-js`），港台片在 TMDB 上只有繁体原名时也能对上。
4. **别名**：没对上时，取前 3 个候选的 TMDB 别名 / 各语言译名重新打分（港台译名、旧译名）。
5. **唯一同名**：没有年份时，候选里恰好一部标题完全一致、其余都明显不像，就采信它（有同名剧集时不用这条）。
6. **剧集**：标题带「第 N 季」，或 TMDB 剧集库有同名剧而电影库没有（或同名剧热度远高于同名片）→ 新状态 `not_film`。
   同名的片和剧热度相当时留在待确认，由用户点「不是电影」。

`not_film` 不进片库、待确认、匹配率分母和画像统计；观影记录序列化里单列一段标题（「Also logged, not films」），策展人知道 TA 还看这些。
「待确认」页可以「重新匹配」（`enrich_films { rematch: true }`：只重跑 ambiguous / unmatched，已确认和已标非电影的不动），
底部列出已跳过的非电影条目，认错了点「其实是电影」恢复到待确认。

偏离：`film_aliases.match_status` 多了 `not_film`（SQLite 列没有 CHECK 约束，无需迁移）；`TmdbClient` 多了 `searchTv` 与 `movieAltTitles`。

### 提示词迭代记录（按用户反馈）

`PROMPT_VERSION` 写进每条 `llm_calls`，画像页可以切换历史版本对照。

- v2：加入近期权重的读法。问题：备忘里直接写出「权重已经下降」，并按年份记流水账。
- v3：禁止在任何文字里提权重、分数、统计、记录等机制（system 规则 9）；加入「影评人」文风。问题：过于文艺、术语和比喻难懂（如「TA回报的是同一套极简装置」，其实是英文提示词 "what they reward" 的直译），举例太多。
- v4：文风对标诺奖颁奖词——严肃、准确、普通读者一读就懂；分析优先，片名只作简短佐证；术语只在比日常说法更准确时用，比喻和抽象名词不能代替分析；目标语言原生写作、不直译提示词；画像概述改为三到四段、每段一个分析论点，鼓励比较「同一导演 / 国别里打高分与打低分的片差在哪」。
