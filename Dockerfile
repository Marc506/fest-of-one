# fest-of-one — 一个镜像，两种进程（web / worker），SQLite 与上传文件放持久卷 /app/data
#   docker compose up -d --build              两个容器（web + worker）共享 ./data
#   docker run … fest-of-one pnpm start:all   单容器同时跑 web + worker（Fly.io 等卷只能挂一台机器的平台）
#
# 构建阶段用完整的 node:22-bookworm（自带 python3 / make / g++，better-sqlite3 没有预编译包时可以本地编译，不需要 apt-get），
# 运行阶段用同一 Debian 版本的 slim 镜像（原生模块 ABI 兼容）。
ARG NODE_IMAGE=node:22-bookworm

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM ${NODE_IMAGE}-slim AS runtime
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    NODE_ENV=production DATABASE_URL=file:/app/data/fest.db PORT=3000
# 构建时就把 pnpm 准备好，运行时不需要联网下载
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
# 不 prune：worker 用 tsx 直接跑 src，next.config.ts 运行时也需要编译
COPY --from=build /app/package.json /app/pnpm-lock.yaml /app/next.config.ts /app/tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
VOLUME ["/app/data"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# 默认跑 web（启动前迁移）；worker 用 `command: pnpm worker` 覆盖
CMD ["sh", "-c", "pnpm db:migrate && pnpm start"]
