# syntax=docker/dockerfile:1
#
# New API Dashboard —— 多阶段构建
#
# 目标镜像：
#   runner           默认，standalone 运行时（不含浏览器，体积小）
#   runner-snapshot  含 Playwright + chromium，支持 POST /api/snapshot（体积大，构建需联网）
#
# 构建：
#   docker build -t new-api-dashboard .
#   docker build --target runner-snapshot -t new-api-dashboard:snapshot .
#
# 注意：本仓库环境未安装 Docker，镜像构建/运行未在本机验证。

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /app

# 依赖层：完整依赖（含 dev，供构建阶段使用）
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# 构建层：生成 .next/standalone（next.config.ts 已开 output: "standalone"）
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm build

# 可选：Playwright + chromium（仅 runner-snapshot 使用；构建期需下载浏览器）
FROM node:22-slim AS snapshot-base
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN npm install -g playwright@1.49.1 \
 && playwright install --with-deps chromium

# 默认运行镜像
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=3088 \
    HOSTNAME=0.0.0.0 \
    DASHBOARD_BASE_URL=http://127.0.0.1:3088 \
    SNAPSHOT_DIR=/app/data/snapshots \
    NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=build /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
# /api/echarts/runtime 直接读取该文件（standalone 的依赖追踪不包含它）
COPY --from=build --chown=nextjs:nodejs /app/node_modules/echarts/dist/echarts.min.js ./node_modules/echarts/dist/echarts.min.js

RUN mkdir -p /app/data/snapshots \
 && chown -R nextjs:nodejs /app/data /app/public

USER nextjs
EXPOSE 3088

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3088/api/health').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]

# 含快照能力的运行镜像（chromium + 系统依赖 + playwright 包）
FROM snapshot-base AS runner-snapshot
WORKDIR /app
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    PORT=3088 \
    HOSTNAME=0.0.0.0 \
    DASHBOARD_BASE_URL=http://127.0.0.1:3088 \
    SNAPSHOT_DIR=/app/data/snapshots \
    NEXT_TELEMETRY_DISABLED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

COPY --from=build /app/public ./public
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=build --chown=nextjs:nodejs /app/node_modules/echarts/dist/echarts.min.js ./node_modules/echarts/dist/echarts.min.js
# 可选依赖以全局安装存在，复制到应用 node_modules 供服务端动态 import("playwright")
COPY --from=snapshot-base /usr/local/lib/node_modules/playwright ./node_modules/playwright
COPY --from=snapshot-base /usr/local/lib/node_modules/playwright-core ./node_modules/playwright-core

RUN mkdir -p /app/data/snapshots \
 && chown -R nextjs:nodejs /app

USER nextjs
EXPOSE 3088

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3088/api/health').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
