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
