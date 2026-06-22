# ============================================================================
# Open Design — 单用户完整 demo 镜像
#
# 一个容器 = 完整的 Open Design(Web 界面 + daemon 后端 + opencode)。
# 浏览器打开就能用:聊天、生成设计稿、多轮迭代。预置 BYOK,单用户,无 SaaS 层。
#
# 关键:
#   · OD Web 默认构建成静态导出(apps/web/out/),由 daemon 直接 serve
#     → 一个 daemon 进程同时提供界面和 /api/*(见 next.config.ts / server.ts:1378)
#   · daemon 绑 127.0.0.1(loopback 免 token);socat 把外部 :8080 转成 loopback 访问
#     → 浏览器经端口映射也能用,且 OD 代码零改动(见 server.ts:4659 的 peer 豁免)
#
# 构建上下文 = 仓库根:
#   docker build -f saas-runtime/demo/Dockerfile -t open-design-demo .
# 或用同目录 docker-compose.yml。
# ============================================================================

# ---------- builder:装依赖 + 构建 daemon 子图 + 构建 web 静态导出 ----------
FROM node:24-bookworm AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

RUN n=0; until corepack prepare pnpm@10.33.2 --activate; do \
      n=$((n+1)); [ "$n" -ge 6 ] && echo ">>> corepack prepare 重试用尽" && exit 1; \
      echo ">>> corepack prepare 第 $n 次未成功(网络抖动),重试中"; sleep 5; \
    done
RUN pnpm config set fetch-retries 6 \
 && pnpm config set fetch-retry-mintimeout 20000 \
 && pnpm config set fetch-retry-maxtimeout 120000
RUN n=0; until pnpm install --frozen-lockfile; do \
      n=$((n+1)); [ "$n" -ge 6 ] && echo ">>> pnpm install 重试用尽" && exit 1; \
      echo ">>> pnpm install 第 $n 次未成功(网络抖动),重试中"; sleep 10; \
    done

# 构建 daemon 子图(daemon + 它依赖的 workspace 包)
RUN pnpm --filter "@open-design/daemon..." run build
# 构建 web:NODE_ENV 非 development → next.config 走静态导出 → apps/web/out/
RUN pnpm --filter "@open-design/web..." run build

# 提取 daemon 生产依赖子集(瘦身),并清掉无关源码;
# 保留 daemon 本体(PROJECT_ROOT)、设计资源、以及 apps/web/out(daemon 要 serve)
RUN pnpm --filter @open-design/daemon deploy --prod --legacy /deploy \
 && rm -rf /app/node_modules \
           /app/apps/*/node_modules /app/packages/*/node_modules /app/tools/*/node_modules \
           /app/apps/desktop /app/apps/landing-page /app/apps/packaged /app/apps/telemetry-worker \
           /app/apps/web/.next /app/apps/web/src \
           /app/e2e /app/docs /app/mocks /app/.git

# ---------- runtime ----------
FROM node:24-bookworm-slim AS runtime
ARG OPENCODE_VERSION=latest
ENV NODE_ENV=production \
    OD_BIND_HOST=127.0.0.1 \
    OD_PORT=7456 \
    OD_DATA_DIR=/data

# ca-certificates:出站 HTTPS · curl:健康检查 · jq:脚本 · tini:PID1 信号 · socat:loopback 端口转发
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl jq tini socat \
 && rm -rf /var/lib/apt/lists/*

# opencode(daemon 找 opencode-cli / opencode 两个名字)
RUN n=0; until npm install -g "opencode-ai@${OPENCODE_VERSION}"; do \
      n=$((n+1)); [ "$n" -ge 6 ] && echo ">>> opencode 安装重试用尽" && exit 1; \
      echo ">>> opencode 安装第 $n 次未成功(网络抖动),重试中"; sleep 8; \
    done \
 && ln -sf "$(command -v opencode)" /usr/local/bin/opencode-cli \
 && (opencode --version || true)

WORKDIR /app
# 复制构建产物(含 apps/web/out —— daemon 要 serve 的 web 界面)
COPY --from=builder /app /app
COPY --from=builder /deploy/node_modules /app/node_modules
COPY saas-runtime/demo/entrypoint.sh /usr/local/bin/od-demo-entrypoint.sh
RUN chmod +x /usr/local/bin/od-demo-entrypoint.sh

RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=5s --start-period=40s --retries=5 \
  CMD curl -fsS http://127.0.0.1:8080/api/health || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/od-demo-entrypoint.sh"]
