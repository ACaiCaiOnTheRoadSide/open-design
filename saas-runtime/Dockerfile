###############################################################################
# Open Design — SaaS per-turn 运行时镜像
#
# 对应《open-design-saas-技术方案.md》第二部分:
#   容器内 = od daemon + opencode。每发一轮对话起一个这样的容器,
#   restore 状态 → 跑一轮 → save 状态 → 优雅关闭 → 销毁。
#
# 构建上下文必须是「仓库根」(因为要装整个 pnpm monorepo):
#   docker build -f saas-runtime/Dockerfile -t od-saas-runtime .
#
# 详见同目录 README.md。
###############################################################################

# ============================================================================
# Stage 1: builder — 安装整个 monorepo 并只构建 daemon 子图
# ============================================================================
# 需要编译 native 模块(better-sqlite3 / node-pty / sharp),故用完整 bookworm
# 并带上 python3 / make / g++。仓库要求 Node ~24。
FROM node:24-bookworm AS builder

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
# 仓库用 corepack 锁定 pnpm@10.33.2(见根 package.json 的 packageManager)
RUN corepack enable

# native 模块的编译工具链
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 根 .dockerignore 已排除 node_modules / dist / .git / .od 等,
# 所以这里 COPY 进来的是干净源码,随后全新 install + build。
COPY . .

# corepack 首次调用 pnpm 时会从 npm registry 下载 pnpm 本体;容器内网络可能
# 瞬时抖动(ECONNRESET / TLS reset)。先单独把 pnpm 备好,失败自动重试。
RUN n=0; until corepack prepare pnpm@10.33.2 --activate; do \
      n=$((n+1)); [ "$n" -ge 6 ] && echo ">>> corepack prepare 重试用尽" && exit 1; \
      echo ">>> corepack prepare 第 $n 次未成功(网络抖动),重试中"; sleep 5; \
    done

# 安装(含 devDependencies,构建需要 esbuild/tsc;native 模块在此编译)。
# 提高 pnpm 自身 fetch 重试,并对整个 install 再包一层重试,抵御 npm registry 抖动。
RUN pnpm config set fetch-retries 6 \
 && pnpm config set fetch-retry-mintimeout 20000 \
 && pnpm config set fetch-retry-maxtimeout 120000
RUN n=0; until pnpm install --frozen-lockfile; do \
      n=$((n+1)); [ "$n" -ge 6 ] && echo ">>> pnpm install 重试用尽" && exit 1; \
      echo ">>> pnpm install 第 $n 次未成功(网络抖动),重试中"; sleep 10; \
    done

# 只构建 daemon 子图:@open-design/daemon 及其依赖的 8 个 workspace 包
# (contracts / platform / sidecar / sidecar-proto / registry-protocol /
#  diagnostics / plugin-runtime / agui-adapter),按拓扑序构建。
# 不构建 web / desktop —— SaaS 容器里用不到,省时省体积。
RUN pnpm --filter "@open-design/daemon..." run build

# 瘦身:用 pnpm deploy 提取「daemon + 生产依赖」的自包含子集(~150MB,替代原
# 1.4GB 全量 node_modules —— 去掉 devDeps 与 web/desktop/tools/e2e 的依赖)。
# 然后清掉全量 node_modules 与 runtime 用不到的源码目录;**保留 daemon 本体
# (apps/daemon,使 project-root.ts 的 ../.. 仍解析到 /app)与设计资源**
# (plugins/skills/design-*/craft/assets,daemon 启动要加载它们)。
RUN pnpm --filter @open-design/daemon deploy --prod --legacy /deploy \
 && rm -rf /app/node_modules \
           /app/apps/*/node_modules /app/packages/*/node_modules /app/tools/*/node_modules \
           /app/apps/web /app/apps/desktop /app/apps/landing-page \
           /app/apps/packaged /app/apps/telemetry-worker \
           /app/e2e /app/docs /app/mocks /app/.git

# ============================================================================
# Stage 2: runtime — 仅运行所需:Node + 构建产物 + opencode + 脚本
# ============================================================================
FROM node:24-bookworm-slim AS runtime

# opencode 版本可在构建时覆盖:--build-arg OPENCODE_VERSION=x.y.z
ARG OPENCODE_VERSION=latest

ENV NODE_ENV=production \
    OD_BIND_HOST=0.0.0.0 \
    OD_PORT=7456 \
    OD_DATA_DIR=/data

# 运行时系统依赖:
#   ca-certificates  opencode / undici 出站 HTTPS
#   curl             entrypoint 健康检查
#   jq               解析 od CLI 的 --json 输出
#   openssl          entrypoint 兜底生成 OD_API_TOKEN
#   tini             作 PID 1,把 SIGTERM 正确转给 daemon(优雅关闭刷 WAL)+ 收割僵尸
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl jq openssl tini \
 && rm -rf /var/lib/apt/lists/*

# 安装 opencode。daemon 优先找 `opencode-cli`,fallback 找 `opencode`
# (见 apps/daemon/src/runtimes/defs/opencode.ts);两个名字都建好。
# 注:若 npm 包名/安装方式变化,改用官方 install 脚本(见 README「opencode 安装」)。
RUN n=0; until npm install -g "opencode-ai@${OPENCODE_VERSION}"; do \
      n=$((n+1)); [ "$n" -ge 6 ] && echo ">>> opencode 安装重试用尽" && exit 1; \
      echo ">>> opencode 安装第 $n 次未成功(网络抖动),重试中"; sleep 8; \
    done \
 && ln -sf "$(command -v opencode)" /usr/local/bin/opencode-cli \
 && (opencode --version || true)

WORKDIR /app
# 瘦身后的源码结构(builder 已删全量 node_modules 与无关源码,保留 daemon 本体
# + 设计资源;daemon 仍在 /app/apps/daemon,PROJECT_ROOT 解析到 /app 不变)。
COPY --from=builder /app /app
# daemon 生产依赖子集(pnpm deploy 产物,~150MB,替代原 1.4GB 全量)。放在
# /app/node_modules:daemon dist 在 /app/apps/daemon/dist,Node 向上解析依赖时
# 命中这里;deploy 已带齐 @open-design/* 的 dist 与 better-sqlite3 等 native 模块。
COPY --from=builder /deploy/node_modules /app/node_modules

# 运行脚本(从构建上下文复制,路径稳定不依赖 /app 内部结构)
COPY saas-runtime/entrypoint.sh saas-runtime/run-turn.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/run-turn.sh

# per-turn 时由 restore 填充;serve 时为空的全新数据盘
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 7456

# tini 作 PID 1,保证容器停止时 SIGTERM 正确传到 daemon → db.close() 刷 WAL
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
# 默认 serve 模式:常驻起 daemon(调试 / 常驻容器形态)。
# 跑一轮:  docker run ... turn --prompt-file /input/prompt.txt [--conversation <id>]
CMD ["serve"]
