# fest-of-one — 一个镜像，两个进程（web / worker），SQLite 放持久卷 /app/data
FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

FROM base AS deps
# better-sqlite3 若无预编译包需要本地编译
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build && pnpm prune --prod --ignore-scripts

FROM base AS runtime
ENV NODE_ENV=production DATABASE_URL=file:/app/data/fest.db
COPY --from=build /app/package.json /app/next.config.ts /app/tsconfig.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/drizzle ./drizzle
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
VOLUME ["/app/data"]
EXPOSE 3000
# 默认跑 web；worker 用 `command: pnpm worker` 覆盖
CMD ["sh", "-c", "pnpm db:migrate && pnpm start"]
