# saas-runtime — Open Design SaaS per-turn 运行时镜像

把 Open Design 的后端(`od daemon` + `opencode`)打进一个容器,用于
《[open-design-saas-技术方案](../../open-design-saas-技术方案.md)》描述的
**per-turn(每轮一容器)** 形态:每发一轮对话起一个容器,
`restore 状态 → 跑一轮 → save 状态 → 优雅关闭 → 销毁`。

> **状态:Phase 0 骨架。** 核心链路(构建 daemon、装 opencode、起服务、跑通一轮、
> §2.5.1 收尾屏障)已实现;restore/save 对接对象存储、BYOK provider 注入为带
> `TODO` 的占位,见下「已实现 vs 待办」。

## 镜像里有什么

- `od daemon` —— 从仓库源码构建:`apps/daemon/dist` + 它依赖的 8 个 workspace 包
- `opencode`(+ `opencode-cli` 软链 —— daemon 按这两个名字查找,见 `runtimes/defs/opencode.ts`)
- Node 24 运行时、`tini`(PID 1,信号转发)、`curl` / `jq`(脚本用)

**不含**:web 前端、desktop、其余 20 个 agent CLI —— SaaS 容器用不到。

## 文件

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 两阶段构建:builder(全量 install + 只 build daemon 子图)→ runtime(瘦运行层 + opencode) |
| `entrypoint.sh` | 进程生命周期:起 daemon、健康等待、**优雅关闭刷 WAL**;`restore_state`/`save_state` 钩子在此(围绕 daemon 生命周期,顺序正确) |
| `run-turn.sh` | 业务:建/复用 project、发起一轮、**轮询确认落库**(§2.5.1 风险二) |

## 构建

构建上下文必须是**仓库根**(要装整个 pnpm monorepo):

```bash
# 在仓库根执行
docker build -f saas-runtime/Dockerfile -t od-saas-runtime .

# 钉 opencode 版本(生产推荐)
docker build -f saas-runtime/Dockerfile \
  --build-arg OPENCODE_VERSION=<x.y.z> -t od-saas-runtime .
```

## 运行

### serve 模式(调试 / 常驻容器形态)

常驻起 daemon,可直接对它发 HTTP:

```bash
docker run --rm -p 7456:7456 -e OD_API_TOKEN=dev-token od-saas-runtime
# 另一个终端:
curl -H 'Authorization: Bearer dev-token' http://127.0.0.1:7456/api/version
```

> 绑 `0.0.0.0` 强制要 `OD_API_TOKEN`;不给会自动生成一个随机值(那样你就连不上),调试时手动给一个。

### turn 模式(跑一轮,对应 per-turn 形态)

```bash
echo "做一个登录页原型" > /tmp/prompt.txt
PROVIDER='{"provider":{"deepseek":{"options":{"baseURL":"https://api.deepseek.com","apiKey":"sk-..."},"models":{"deepseek-v4-pro":{}}}},"model":"deepseek/deepseek-v4-pro"}'
docker run --rm \
  -v /tmp/prompt.txt:/input/prompt.txt:ro \
  -v od-conv-123:/data \
  -e OD_CONVERSATION_ID=conv-123 \
  -e OD_OPENCODE_PROVIDER_CONFIG="$PROVIDER" \
  -e OD_MODEL=deepseek/deepseek-v4-pro \
  od-saas-runtime turn --prompt-file /input/prompt.txt
```

容器会:`restore →` 起 daemon `→` 建 project `→` 跑一轮 opencode `→` 轮询确认落库 `→` 优雅关闭 daemon(刷 WAL)`→ save →` 退出。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `OD_BIND_HOST` | `0.0.0.0` | daemon 监听地址 |
| `OD_PORT` | `7456` | daemon 端口 |
| `OD_API_TOKEN` | (随机生成) | 绑非回环必需;生产由控制面按容器注入并登记 |
| `OD_DATA_DIR` | `/data` | 数据盘(`.od/` 等价物);per-turn 时由 restore 填充 |
| `OD_CONVERSATION_ID` | — | turn 模式:本会话标识,供 restore/save 寻址 |
| `OD_MODEL` | `default` | 传给 opencode 的模型(BYOK 时用 `deepseek/<model>`) |
| `OD_OPENCODE_PROVIDER_CONFIG` | — | BYOK provider 配置(JSON `{"provider":{…},"model":"…"}`),daemon merge 进 OpenCode 配置 |
| `OD_SKILL` | — | 挂 open-design 设计 skill(如 `web-artifacts-builder`)。**强烈建议设**:不挂 skill 会退化成裸 opencode,生成质量低且落盘看 prompt 措辞。挂了走完整流程(第 1 轮 discovery 问澄清问题,需多轮) |
| `OD_DESIGN_SYSTEM` | — | 可选:挂品牌设计系统(如 `apple`、`airbnb`) |

## 已实现 vs 待办

**已实现**
- 从源码构建 daemon 子图、安装 opencode、起服务并健康检查
- 跑通一轮:建 project → `run start` → 轮询确认终态
- §2.5.1 **收尾屏障**:turn 先轮询确认落库,再 `SIGTERM` 优雅关闭 daemon 触发 `db.close()` 刷 WAL,最后才 `save_state`
- **BYOK provider 注入**:容器设 `OD_OPENCODE_PROVIDER_CONFIG`(JSON,含 `provider` + `model`),daemon 的 `mergeOpenCodeProviderConfig()`(`mcp-config.ts`)把它 **merge** 进 `OPENCODE_CONFIG_CONTENT`(而非被 daemon 的目录授权配置覆盖)。已用 deepseek 实测生成 HTML 制品

**待办(TODO,均在脚本里标注)**
- **restore/save 对接对象存储**:`entrypoint.sh` 的 `restore_state` / `save_state` 是占位。选型见方案 §3.6(MinIO / S3)。顺序已摆对:restore 在 daemon 启动前、save 在 daemon 关闭后。
- **字段/枚举校准**:`run start --json` 的 `runId` 字段、`/api/runs/:id` 的 `status` 终态枚举,用真实输出校准 `run-turn.sh`。
- **导出依赖**:PDF/PPTX/视频导出需 Chromium + FFmpeg,未装(日常预览不需要);需要时在 runtime 层补装。

## Phase 0 头号验证项

对应方案 §3.5:**连续多轮、每轮换新容器的重灌一致性**。接对象存储前,先用 `docker volume` 模拟「同一会话的状态盘」:

```bash
docker run --rm -v od-conv-1:/data -e OD_CONVERSATION_ID=conv-1 ... turn --prompt-file p1.txt  # 第1轮:生成
docker run --rm -v od-conv-1:/data -e OD_CONVERSATION_ID=conv-1 ... turn --prompt-file p2.txt  # 第2轮:改一处
docker run --rm -v od-conv-1:/data -e OD_CONVERSATION_ID=conv-1 ... turn --prompt-file p3.txt  # 第3轮:再改
# 验证第2、3轮能看到前序历史与文件;丢任一轮 = 收尾屏障有问题
```

## 优化方向

- **瘦身 ✅ 已做**:用 `pnpm deploy --prod --legacy` 把全量 node_modules(1.4GB)换成 daemon 生产依赖子集(~150MB),并清掉 web/desktop/e2e/docs/mocks 等无关源码;保留 daemon 本体(`apps/daemon`,使 `project-root.ts` 的 `../..` 仍解析到 `/app`)与设计资源(plugins/skills/design-*/craft/assets)。**镜像 3.51GB → 1.85GB**。进一步可裁 opencode 多平台二进制(397MB)、按需裁设计资源,但收益递减。
- **冷启动**:暖池预热容器(方案 §3.4)。
- **构建缓存**:先单独 `COPY` 各 `package.json` 再 `install`,依赖未变时复用层。
