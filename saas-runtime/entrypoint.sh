#!/usr/bin/env bash
###############################################################################
# 容器主入口 —— 基础设施层:起 daemon + 健康等待 + 优雅关闭。
#
# 两种模式:
#   serve  (默认)  常驻起 daemon,保持运行。供本地调试,或「常驻容器」形态
#                  下让网关直接发 HTTP。停止时 SIGTERM 优雅关闭 daemon。
#   turn           per-turn 形态:起 daemon → 跑一轮(run-turn.sh)→ 优雅关闭
#                  daemon(刷 WAL)→ 退出。容器随后被销毁。
#
# 业务逻辑(restore / run / save)在 run-turn.sh 里;这里只管进程生命周期。
# 对应《open-design-saas-技术方案.md》§2.4(容器内 daemon)与 §2.5.1(收尾屏障)。
###############################################################################
set -euo pipefail

: "${OD_DATA_DIR:=/data}"
: "${OD_PORT:=7456}"
: "${OD_BIND_HOST:=0.0.0.0}"
: "${OD_HEALTH_TIMEOUT:=120}"
# 绑非回环地址时 daemon 强制要求 OD_API_TOKEN(server.ts:4609)。
# 生产中应由控制面为每个容器注入一个、并登记下来;这里只是「没注入时」的兜底。
# 容器内的 od CLI 走 127.0.0.1(loopback 自动豁免 token),不需要它。
if [[ -z "${OD_API_TOKEN:-}" ]]; then
  OD_API_TOKEN="$(openssl rand -hex 32)"
fi
export OD_DATA_DIR OD_PORT OD_BIND_HOST OD_API_TOKEN

DAEMON_ENTRY="/app/apps/daemon/dist/cli.js"
DAEMON_PID=""

mkdir -p "$OD_DATA_DIR"

start_daemon() {
  # --no-open:headless,不尝试打开浏览器(见 daemon package.json 的 daemon 脚本)
  node "$DAEMON_ENTRY" --no-open &
  DAEMON_PID=$!
}

wait_ready() {
  # /api/health 免 token(server.ts:5157 + 4637 的豁免清单)
  local i max_attempts=$(( OD_HEALTH_TIMEOUT * 2 ))
  for i in $(seq 1 "$max_attempts"); do
    if curl -fsS "http://127.0.0.1:${OD_PORT}/api/health" >/dev/null 2>&1; then
      echo "[entrypoint] daemon 就绪 → http://${OD_BIND_HOST}:${OD_PORT}"
      return 0
    fi
    # daemon 进程若已退出则不必再等
    if [[ -n "$DAEMON_PID" ]] && ! kill -0 "$DAEMON_PID" 2>/dev/null; then
      echo "[entrypoint] daemon 进程在就绪前退出" >&2
      return 1
    fi
    sleep 0.5
  done
  echo "[entrypoint] daemon 未在超时内就绪" >&2
  return 1
}

# 优雅关闭:SIGTERM 给 daemon → 触发 db.close() 刷 WAL(§2.5.1 风险一)→ 等其退出
shutdown_daemon() {
  if [[ -n "$DAEMON_PID" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    echo "[entrypoint] 优雅关闭 daemon(刷 WAL)…"
    kill -TERM "$DAEMON_PID" 2>/dev/null || true
    wait "$DAEMON_PID" 2>/dev/null || true
  fi
}

# ── 对象存储钩子(占位,待方案 §3.6 选型)─────────────────────────────────
# 顺序很关键(§2.5.1):
#   restore 必须在 daemon 启动「前」—— daemon 一启动就读 SQLite;
#   save    必须在 daemon 关闭「后」—— 刷过 WAL,主库才完整。
restore_state() {
  # TODO: 从对象存储把本会话 .od/ 拉到 $OD_DATA_DIR
  #   例: s3 sync "s3://<bucket>/conv/${OD_CONVERSATION_ID:-}/od/" "$OD_DATA_DIR"/
  echo "[entrypoint] (TODO) restore .od/  conversation=${OD_CONVERSATION_ID:-<new>}"
}
save_state() {
  # TODO: 把 $OD_DATA_DIR 的 SQLite + projects/ 传回对象存储(daemon 已关闭)
  #   例: s3 sync "$OD_DATA_DIR"/ "s3://<bucket>/conv/${OD_CONVERSATION_ID:-}/od/"
  echo "[entrypoint] (TODO) save .od/  conversation=${OD_CONVERSATION_ID:-<new>}"
}

MODE="${1:-serve}"

case "$MODE" in
  serve)
    # 容器停止(docker stop)时 tini 转发 SIGTERM 到本脚本,trap 负责优雅关闭
    trap 'shutdown_daemon; exit 0' TERM INT
    start_daemon
    wait_ready
    echo "[entrypoint] serve 模式:daemon 常驻。Ctrl-C / docker stop 优雅退出。"
    wait "$DAEMON_PID"
    ;;

  turn)
    shift
    restore_state                      # ① daemon 启动「前」恢复 .od/(§2.5 两轮接力)
    start_daemon
    if ! wait_ready; then
      shutdown_daemon
      exit 1
    fi
    set +e
    /usr/local/bin/run-turn.sh "$@"    # ② 跑一轮 + 轮询确认落库(§2.5.1 风险二)
    rc=$?
    set -e
    shutdown_daemon                    # ③ 优雅关闭 → db.close() 刷 WAL(§2.5.1 风险一)
    save_state                         # ④ daemon 已关闭、主库完整,才 save 回对象存储
    echo "[entrypoint] turn 结束,退出码 $rc"
    exit "$rc"
    ;;

  *)
    # 透传:允许 `docker run ... bash` 之类进容器调试
    exec "$@"
    ;;
esac
