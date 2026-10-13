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
