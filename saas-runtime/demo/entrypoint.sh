#!/usr/bin/env bash
###############################################################################
# Open Design demo 容器入口
#
# 一个进程组 = 完整 OD:
#   · daemon 绑 127.0.0.1:7456(loopback → 免 token),同时 serve web 界面 + /api/*
#   · socat 把外部 0.0.0.0:8080 转成对 127.0.0.1:7456 的访问
#     → 浏览器经端口映射访问时,daemon 看到的 peer 是 127.0.0.1 → 豁免 token
#     → OD 代码零改动
#
# BYOK:从 OD_BYOK_* 拼出 OD_OPENCODE_PROVIDER_CONFIG(daemon spawn opencode 时注入)。
###############################################################################
set -euo pipefail

: "${OD_DATA_DIR:=/data}"
: "${OD_PORT:=7456}"
: "${OD_WEB_PORT:=8080}"                 # 浏览器访问端口(socat 监听);放行 web 的跨端口 origin
export OD_DATA_DIR OD_PORT OD_WEB_PORT
export OD_BIND_HOST=127.0.0.1            # 必须 loopback,免 token(外部访问由 socat 转发)
mkdir -p "$OD_DATA_DIR"

# ── BYOK:未直接给 OD_OPENCODE_PROVIDER_CONFIG 时,从 OD_BYOK_* 拼一个 ──
if [ -z "${OD_OPENCODE_PROVIDER_CONFIG:-}" ] && [ -n "${OD_BYOK_API_KEY:-}" ]; then
  : "${OD_BYOK_BASE_URL:=https://api.deepseek.com}"
  : "${OD_BYOK_MODEL:=deepseek-v4-pro}"
  : "${OD_BYOK_PROVIDER:=deepseek}"
  OD_OPENCODE_PROVIDER_CONFIG="$(jq -nc \
    --arg p "$OD_BYOK_PROVIDER" --arg b "$OD_BYOK_BASE_URL" \
    --arg k "$OD_BYOK_API_KEY"  --arg m "$OD_BYOK_MODEL" \
    '{provider:{($p):{options:{baseURL:$b,apiKey:$k},models:{($m):{}}}},model:($p+"/"+$m)}')"
  export OD_OPENCODE_PROVIDER_CONFIG
  echo "[demo] BYOK 已配置: provider=$OD_BYOK_PROVIDER model=$OD_BYOK_MODEL base=$OD_BYOK_BASE_URL"
elif [ -n "${OD_OPENCODE_PROVIDER_CONFIG:-}" ]; then
  echo "[demo] BYOK 用直接提供的 OD_OPENCODE_PROVIDER_CONFIG"
else
  echo "[demo] ⚠ 未配置 BYOK(设 OD_BYOK_API_KEY 或 OD_OPENCODE_PROVIDER_CONFIG),否则生成会因缺模型 key 失败"
fi

# ── 起 daemon(serve web + api,绑 loopback)──
node /app/apps/daemon/dist/cli.js --no-open &
DAEMON_PID=$!

for _ in $(seq 1 180); do
  if curl -fsS "http://127.0.0.1:${OD_PORT}/api/health" >/dev/null 2>&1; then
    echo "[demo] daemon 就绪(web + api @127.0.0.1:${OD_PORT})"
    break
  fi
  kill -0 "$DAEMON_PID" 2>/dev/null || { echo "[demo] daemon 启动失败" >&2; exit 1; }
  sleep 0.5
done

shutdown() { kill -TERM "$DAEMON_PID" 2>/dev/null || true; wait "$DAEMON_PID" 2>/dev/null || true; }
trap 'shutdown; exit 0' TERM INT

echo "[demo] ✅ 就绪!浏览器访问 → http://localhost:8080"
# socat 后台转发;daemon 是主进程,它退出则容器退出
socat TCP-LISTEN:8080,fork,reuseaddr TCP:127.0.0.1:"${OD_PORT}" &
wait "$DAEMON_PID"
shutdown
