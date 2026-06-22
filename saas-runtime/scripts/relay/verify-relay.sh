#!/usr/bin/env bash
###############################################################################
# ① 状态接力验证 —— 容器的 .od/ 在 MinIO 之间接力(restore/save + 收尾屏障)
#
# 手动模拟「控制面」的角色:
#   restore: 起容器前,从 MinIO 把该会话的 .od/ 拉到本地目录(挂给容器)
#   save:    容器优雅关闭(刷 WAL)后,把 .od/ 推回 MinIO
#
# 验证流程:
#   第1容器:restore(空)→ 建 project → 优雅关闭刷 WAL → save 到 MinIO → 销毁
#   第2容器(全新):restore(从 MinIO)→ 看到第1容器建的 project = 接力成功
#
# 前置:本地 MinIO(od-minio)在 od-relay-net 网络上,bucket=open-design;镜像 open-design-demo。
###############################################################################
set -euo pipefail

NET=od-relay-net
MC_HOST="http://odadmin:od-minio-dev-secret@od-minio:9000"
BUCKET=open-design
SESSION="${1:-conv-001}"
WORK="/tmp/od-relay-$SESSION"
IMAGE=open-design-demo

mkdir -p "$WORK"

# 所有对 .od/ 的文件操作都经 mc 容器(root)做,避免 host 与容器 root 的权限打架
mcrun() { docker run --rm --network "$NET" -e MC_HOST_od="$MC_HOST" -v "$WORK:/work" --entrypoint /bin/sh minio/mc -c "$1"; }

restore() {  # MinIO sessions/<session>/od/ → /work/data
  mcrun "rm -rf /work/data; mkdir -p /work/data; mc cp --recursive od/$BUCKET/sessions/$SESSION/od/ /work/data/ >/dev/null 2>&1 || echo '  (空会话:首次,无历史)'"
}
save() {     # /work/data → MinIO(在 daemon 优雅关闭、WAL 已刷主库之后调用)
  mcrun "mc mirror --overwrite --quiet /work/data/ od/$BUCKET/sessions/$SESSION/od/"
}

start_c() {  # $1=容器名;挂 restore 出来的 .od/ 到 /data
  docker rm -f "$1" >/dev/null 2>&1 || true
  docker run -d --name "$1" --network "$NET" -v "$WORK/data:/data" "$IMAGE" >/dev/null
  docker exec "$1" sh -c 'until curl -fsS http://127.0.0.1:7456/api/health >/dev/null 2>&1; do sleep 0.5; done'
}
stop_c() {   # 优雅关闭:docker stop → SIGTERM → entrypoint trap → daemon db.close() 刷 WAL
  docker stop -t 30 "$1" >/dev/null; docker rm "$1" >/dev/null
}
odc() { docker exec "$1" node /app/apps/daemon/dist/cli.js "${@:2}"; }

echo "######### 第 1 容器:restore(空)→ 建 project → 优雅关闭刷 WAL → save #########"
restore
start_c relay-c1
PID=$(odc relay-c1 project create --name relay-test --json | jq -r '.project.id')
echo "  第1容器建了 project: $PID"
stop_c relay-c1
save
echo "  已优雅关闭、save .od/ 到 MinIO"
echo ""

echo "######### 第 2 容器(全新):restore(从 MinIO)→ 验证 project 在 #########"
restore
start_c relay-c2
echo "  第2容器看到的 project:"
odc relay-c2 project list --json | jq -r '.projects[]? | "    \(.id)  →  \(.name)"' 2>/dev/null || odc relay-c2 project list
FOUND=$(odc relay-c2 project list --json | jq -r --arg p "$PID" '[.projects[]?|select(.id==$p)]|length' 2>/dev/null || echo 0)
stop_c relay-c2
echo ""
if [ "$FOUND" = "1" ]; then
  echo "✅ 接力成功:全新容器从 MinIO 恢复后,看到了上一个容器建的 project($PID)"
else
  echo "❌ 接力失败:project 没能从 MinIO 恢复(FOUND=$FOUND)"
fi
echo ""
echo "######### MinIO 里存的 .od/ #########"
mcrun "mc ls --recursive od/$BUCKET/sessions/$SESSION/ 2>/dev/null | head -12"
