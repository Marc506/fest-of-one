# fest-of-one · 一个人的影展

个人影展策展工具：读取 Letterboxd / 豆瓣观影记录 → 品味画像 → Claude 自行决定策展角度并排片 → 一键加入 Apple / Google 日历。

## 从这里开始

**完整规格在 `ARCHITECTURE.md`，先通读再动手。** 它定义了数据模型、各子系统接口、策展流水线、prompt 要点、排期算法、日历导出、API/页面清单，以及第 15 章的里程碑顺序（M0 → M7）与验收标准。

## 执行约定

- 按 `ARCHITECTURE.md` 第 15 章的里程碑顺序做，一个里程碑一个 PR（或一组提交）。每个里程碑完成前跑通其验收标准。
- 偏离文档的地方允许，但要在 PR 描述 / 提交信息里写明「偏离了什么、为什么」。
- `ARCHITECTURE.md` 1.2 节的 P1–P8 是硬约束，不要改：系统替用户选影展类型；N=1 不成展；LLM 看完整观影记录；LLM 不产时间；候选片必须 TMDB 落地且未看过；演员展必须经审查；日历地点留空；用户数据按 user_id 隔离。
- M3（策展引擎）先在 `pnpm curate` CLI 上把 prompt 打磨到满意，再接 UI。

## 技术栈速记

pnpm · Node ≥ 20 · Next.js 15 App Router · TypeScript strict · Tailwind · Drizzle + SQLite(better-sqlite3) · Auth.js v5 · zod · `@anthropic-ai/sdk` · TMDB API v3 · 独立 worker 进程（`pnpm worker`）跑 `jobs` 表。

## Claude API 用法（不要凭记忆改）

- 模型：`claude-opus-5-5`（全流程单一模型，缓存按模型隔离）。不要加日期后缀。
- 不传 `thinking`（默认 adaptive；`disabled` / `budget_tokens` 会 400）。深度用 `output_config.effort`。
- 结构化输出：`client.messages.parse({ output_config: { format: zodOutputFormat(Schema) } })`，`zodOutputFormat` 来自 `@anthropic-ai/sdk/helpers/zod`。
- 工具：`strict: true`；`tool_choice` 保持 `auto`（该模型不支持强制 `any` / `tool`）。
- 不要用 assistant prefill。
- prompt caching：`system` 文本块上 `cache_control: { type: 'ephemeral', ttl: '1h' }`；system 里禁止日期 / 随机 ID；观影记录序列化必须确定性（按 tmdb_id 排序）。每次调用记录 `cache_read_input_tokens`。

## 目录与命令

目录结构见 `ARCHITECTURE.md` 第 14 章。约定的 scripts：`dev` `build` `start` `worker` `db:migrate` `db:studio` `curate` `test` `lint` `typecheck`。

## 不做的事

不查流媒体可看性、不做社交分享、不写回 Letterboxd / 豆瓣、不做原生 App。
