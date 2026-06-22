#!/usr/bin/env bash
###############################################################################
# per-turn 业务 —— 跑一轮 opencode 并确认其落库。
#
# 只负责「跑一轮 + 确认完成」。状态的 restore / save 与 daemon 的优雅关闭
# 由 entrypoint.sh 围绕本脚本处理(顺序见 §2.5.1)。
#
# 用法(由 entrypoint 的 turn 分支调用):
#   run-turn.sh --prompt-file <path> [--conversation <id>] [--project <id>] [--model <m>]
#
# 对应《open-design-saas-技术方案.md》§2.3(一轮生命周期)、§2.5.1(收尾屏障)。
###############################################################################
set -euo pipefail

OD=(node /app/apps/daemon/dist/cli.js)
BASE="http://127.0.0.1:${OD_PORT:-7456}"

PROMPT_FILE=""
CONVERSATION_ID="${OD_CONVERSATION_ID:-}"
PROJECT_ID="${OD_PROJECT_ID:-}"
MODEL="${OD_MODEL:-default}"
SKILL="${OD_SKILL:-}"                 # 挂 open-design 设计 skill(强引导落盘制品)
DESIGN_SYSTEM="${OD_DESIGN_SYSTEM:-}" # 可选:挂品牌设计系统

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prompt-file)  PROMPT_FILE="$2";     shift 2 ;;
    --conversation) CONVERSATION_ID="$2"; shift 2 ;;
    --project)      PROJECT_ID="$2";      shift 2 ;;
    --model)        MODEL="$2";           shift 2 ;;
    *) echo "[run-turn] 未知参数:$1" >&2; exit 2 ;;
  esac
done
[[ -n "$PROMPT_FILE" ]] || { echo "[run-turn] 缺 --prompt-file" >&2; exit 2; }

# ── ① BYOK 注入(已实现)──────────────────────────────────────────────────
# 用户的 baseUrl/apiKey 通过容器环境变量 OD_OPENCODE_PROVIDER_CONFIG 提供
# (JSON: {"provider":{...},"model":"deepseek/..."}),daemon 的
# mergeOpenCodeProviderConfig() 会把它 merge 进 OPENCODE_CONFIG_CONTENT。
# 本脚本无需额外处理;run 时用 --model deepseek/<model> 选中(见 OD_MODEL)。

# ── ② 建 project(首轮)或复用 restore 出来的 project ───────────────────────
# 多轮接力:状态盘里的 session 文件记着上一轮的 project/conversation。
# per-turn 下,第 2 轮起的全新容器靠 restore 把这个文件(连同 .od/)恢复回来,
# 于是复用同一 project/conversation,接上同一对话(而非每轮新建、断掉上下文)。
SESSION_FILE="${OD_DATA_DIR:-/data}/.od-saas-session.json"
if [[ -z "$PROJECT_ID" && -f "$SESSION_FILE" ]]; then
  PROJECT_ID="$(jq -r '.projectId // empty' "$SESSION_FILE" 2>/dev/null)"
  [[ -n "$CONVERSATION_ID" ]] || CONVERSATION_ID="$(jq -r '.conversationId // empty' "$SESSION_FILE" 2>/dev/null)"
  [[ -n "$PROJECT_ID" ]] && echo "[run-turn] 复用已有 project=$PROJECT_ID conversation=$CONVERSATION_ID"
fi

if [[ -z "$PROJECT_ID" ]]; then
  echo "[run-turn] 新建 project(skill=${SKILL:-<none>} design-system=${DESIGN_SYSTEM:-<none>})…"
  CREATE_ARGS=(project create --name "saas-turn" --json)
  [[ -n "$SKILL" ]]         && CREATE_ARGS+=(--skill "$SKILL")
  [[ -n "$DESIGN_SYSTEM" ]] && CREATE_ARGS+=(--design-system "$DESIGN_SYSTEM")
  CREATE_JSON="$("${OD[@]}" "${CREATE_ARGS[@]}")"
  PROJECT_ID="$(echo "$CREATE_JSON" | jq -r '.project.id')"
  [[ -n "$CONVERSATION_ID" ]] || \
    CONVERSATION_ID="$(echo "$CREATE_JSON" | jq -r '.conversationId // empty')"
  # 记下 project/conversation,供后续轮的新容器复用(随状态盘一起 restore)
  jq -n --arg pid "$PROJECT_ID" --arg cid "$CONVERSATION_ID" \
    '{projectId: $pid, conversationId: $cid}' > "$SESSION_FILE"
fi
echo "[run-turn] project=$PROJECT_ID conversation=${CONVERSATION_ID:-<auto>}"

# ── ③ 发起一轮 ────────────────────────────────────────────────────────────
# 用 --json(立即返回 runId)而非 --follow:脚本不需要看流式,只需自己轮询终态,
# 这样能在 save 前确信本轮已落库(§2.5.1 风险二)。
RUN_ARGS=(run start --project "$PROJECT_ID" --agent opencode \
          --prompt-file "$PROMPT_FILE" --json)
[[ "$MODEL" != "default" ]] && RUN_ARGS+=(--model "$MODEL")
[[ -n "$CONVERSATION_ID" ]] && RUN_ARGS+=(--conversation "$CONVERSATION_ID")

START_JSON="$("${OD[@]}" "${RUN_ARGS[@]}")"
RUN_ID="$(echo "$START_JSON" | jq -r '.runId // .id // empty')"
[[ -n "$RUN_ID" ]] || { echo "[run-turn] 拿不到 runId:$START_JSON" >&2; exit 1; }
echo "[run-turn] runId=$RUN_ID,等待完成…"

# ── ④ 轮询确认终态 ────────────────────────────────────────────────────────
# 终态枚举与 status 字段名以真实输出为准 —— Phase 0 校准。
TERMINAL_RE='^(succeeded|failed|error|errored|canceled|cancelled|completed|done|timeout)$'
for _ in $(seq 1 1800); do            # 上限 ~30min(0.5s × 1800),按模型耗时调
  STATUS="$(curl -fsS "${BASE}/api/runs/${RUN_ID}" | jq -r '.status // empty' || true)"
  if [[ "$STATUS" =~ $TERMINAL_RE ]]; then
    echo "[run-turn] 终态:$STATUS"
    [[ "$STATUS" == "succeeded" || "$STATUS" == "completed" || "$STATUS" == "done" ]] && exit 0
    exit 1
  fi
  sleep 0.5
done
echo "[run-turn] 等待超时,未达终态" >&2
exit 1
