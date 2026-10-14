# 部署

一个镜像、两种进程：**web**（Next.js）与 **worker**（`jobs` 表的后台任务）。两者共用一个 SQLite 文件，
所以必须能访问同一个持久卷。不要部署到 Vercel 这类无常驻进程的平台（2 章）。

## 1. 准备

| 变量 | 说明 |
|------|------|
| `AUTH_SECRET` | `openssl rand -base64 33` |
| `AUTH_GOOGLE_ID` / `AUTH_GOOGLE_SECRET` | Google Cloud Console → APIs & Services → Credentials → OAuth client（Web）。授权重定向 URI：`https://<你的域名>/api/auth/callback/google`。在「Enabled APIs」里启用 **Google Calendar API**；OAuth consent screen 加上 scope `.../auth/calendar.events`，测试阶段把自己加为 test user。 |
| `ANTHROPIC_API_KEY` | 策展与画像（模型固定 `claude-opus-5-5`）。 |
| `TMDB_READ_TOKEN` | TMDB → Settings → API → **API Read Access Token**（v4 Bearer，用于 v3 API）。 |
| `APP_ENCRYPTION_KEY` | `openssl rand -base64 32`；加密豆瓣 Cookie。**丢了就只能让用户重新填 Cookie。** |
| `APP_BASE_URL` | 对外的 https 地址。日历事件里的链接、webcal 订阅地址都用它；Google 订阅日历要求公网可访问。 |
| `DEV_LOGIN` | 生产必须是 `0`。 |
| `LLM_ENABLE_FALLBACKS` | `1` 时启用服务端 refusal fallback（beta `server-side-fallback-2026-07-01`），默认关。 |

## 2. 单机 Docker（推荐）

```bash
git clone … && cd fest-of-one
cp .env.example .env    # 填好上表
docker compose up -d --build
docker compose logs -f
```

- `web` 启动前自动 `pnpm db:migrate`；`worker` 等 `web` 健康检查通过后启动。
- 数据都在 `./data`：`fest.db`（+ `-wal` / `-shm`）与 `uploads/`（导出文件原件，重新同步时用）。
- 反向代理（Caddy / nginx）把 443 转到 3000 即可；Auth.js 已 `trustHost`。

## 3. 卷只能挂一台机器的平台（Fly.io 等）

用单容器模式，同一台机器里同时跑 web 和 worker：

```bash
# fly.toml 里：[processes] app = "pnpm start:all"，[mounts] destination = "/app/data"
```

`pnpm start:all` 先迁移，再同时启动两个进程；任一退出就整体退出，交给平台重启。
（不要用两个 process group：它们会在不同机器上，看不到同一个 SQLite 文件。）

## 4. 运维

- **备份**：`sqlite3 data/fest.db ".backup 'backup-$(date +%F).db'"`（在线、一致），再备份 `data/uploads/`。
- **升级**：`git pull && docker compose up -d --build`（迁移随 web 启动执行，只做增量）。
- **任务卡住**：worker 每 10 秒刷心跳；超过 2 分钟没心跳的任务会被下一次扫描放回队列（最多 3 次）。
- **成本**：`/settings` 里按用途列出 token、缓存命中率和估算美元；`llm_calls` 表有每次调用的完整响应，
  `pnpm curate --replay` 可以按 request hash 离线重放。热态缓存命中率低于 80% 通常意味着 system 前缀被污染。
- **Letterboxd RSS** 每 12 小时自动增量同步；豆瓣抓取只在用户点「重新同步」时运行（避免触发反爬）。
