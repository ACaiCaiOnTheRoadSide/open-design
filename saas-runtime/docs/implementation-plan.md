# Open Design SaaS 对接工作清单

> 基于 `open-design-saas.md` v3 方案（低入侵原则：OD 仓库零改动），列出从当前状态到 dev 环境可用的全部具体工作。
> 每一项标注了：要做什么、在哪做、依赖什么、产出是什么。

---

## 当前状态

- ✅ daemon 容器镜像能构建、能跑
- ✅ BYOK 注入端到端打通（`mergeOpenCodeProviderConfig`）
- ✅ per-turn 单轮生成成功
- ⬜ 多轮接力尚未验证
- ⬜ 百智云模板尚未初始化
- ⬜ Go 控制面、SaaS 外壳前端、部署配置全部未开始

---

## 一、项目初始化

### 1.1 从百智云模板创建项目骨架

```bash
git clone git@git.in.chaitin.net:ai/baizhiyun/template.git /tmp/baizhiyun-template
/tmp/baizhiyun-template/scripts/init-template.sh \
  --app open-design \
  --dir ~/baizhiyun/open-design
```

**产出**：一个包含 `backend/`、`frontend/`、`deploy/`、`.gitlab-ci.yml` 的新仓库骨架，应用名为 `open-design`。

**后续选择**：可以把生成的骨架合并进现有 `open-design` 仓库（作为新目录），也可以独立仓库再 git submodule 引用。建议**独立仓库**，因为百智云的 CI/部署流程假设仓库根就是 `backend/` + `frontend/` + `deploy/`。

### 1.2 确认百智云 APP ID 和证书

联系 @樊江巍 @王小兵 获取：

- `DEV_BAIZHI_APP_ID` / `PROD_BAIZHI_APP_ID`
- dev 环境证书：`DEV_APP_CRT_B64`、`DEV_APP_KEY_B64`、`DEV_CA_CRT_B64`、`DEV_PUBLIC_KEY_B64`
- prod 环境证书：同上的 `PROD_*` 版本

在 GitLab 项目的 **Settings → CI/CD → Variables** 里配置。

### 1.3 确认平台依赖

在百智云平台侧确认/申请：

| 依赖 | 说明 | 需要谁 |
|---|---|---|
| PostgreSQL 数据库 | 控制面的数据存储 | 平台运维创建 `open-design-db` Secret |
| MinIO（对象存储） | .od/ 状态 + 制品存储 | 平台已有共享实例，确认 bucket 和权限 |
| 容器镜像仓库 | 推 backend/frontend/daemon/od-web 镜像 | 确认 `registry.baizhiyun.vip/open-design/*` 命名空间 |
| K8s namespace | 控制面（Go + 前端）部署目标 | 确认 namespace 和资源配额 |
| Agent 专用机 | 跑用户 daemon 容器的独立机器 | 确认 IP、配置 Docker TLS、开放 2376 + 32000-33000 端口 |

---

## 二、Go 控制面（`backend/`）

基于模板生成的 Go 后端，扩展以下模块。所有新代码遵循模板的分层约定：`handler → service → repository → db`。

### 2.1 数据库迁移（新表）

**位置**：`backend/internal/migration/migrations/`

新建三个迁移文件：

```
20260616000001_create_byok_configs.go
20260616000002_create_media_keys.go
20260616000003_create_call_records.go
20260616000004_create_active_sessions.go
```

**byok_configs 表**——存用户的 Agent LLM 配置（驱动代码生成的大模型）：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | 配置 ID |
| user_id | TEXT NOT NULL | 所属用户 |
| team_id | TEXT DEFAULT '' | 所属团队 |
| name | TEXT | 显示名（如"我的 DeepSeek"） |
| base_url | TEXT NOT NULL | 模型端点（如 `https://api.deepseek.com`） |
| api_key_enc | TEXT NOT NULL | AES-256 加密后的 apiKey |
| model | TEXT NOT NULL | 模型名（如 `deepseek-v4-pro`） |
| provider_id | TEXT NOT NULL | provider 标识（如 `deepseek`） |
| is_default | BOOLEAN DEFAULT false | 是否默认使用 |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

**media_keys 表**——存用户的 Media Provider 凭证（图片/视频/音频生成）：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| user_id | TEXT NOT NULL | 所属用户 |
| team_id | TEXT DEFAULT '' | 所属团队 |
| provider_id | TEXT NOT NULL | provider 标识（如 `openai`、`fal`、`grok`、`volcengine`） |
| api_key_enc | TEXT NOT NULL | AES-256 加密后的 apiKey |
| base_url | TEXT DEFAULT '' | 可选自定义端点 |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |
| UNIQUE(user_id, provider_id) | | 每用户每 provider 只有一份 |

用户可以配多个 media provider，启动容器时全部注入对应环境变量（如 `OD_OPENAI_API_KEY`、`OD_FAL_KEY`）。daemon 的 `media-config.ts` 会自动读取。

**call_records 表**——调用日志：

| 字段 | 类型 | 说明 |
|---|---|---|
| id | TEXT PK | |
| user_id | TEXT NOT NULL | |
| team_id | TEXT DEFAULT '' | |
| source | TEXT NOT NULL | web / api / mcp |
| run_id | TEXT | OD daemon 的 run ID |
| conversation_id | TEXT | |
| model | TEXT | 使用的模型 |
| status | TEXT DEFAULT 'processing' | processing / completed / failed |
| quota_used | BIGINT DEFAULT 0 | 消耗额度 |
| wallet_biz_id | TEXT | 钱包流水 ID |
| duration_ms | BIGINT | 耗时 |
| error_message | TEXT | 面向用户的安全错误信息 |
| error_detail | TEXT | 原始错误（仅运营后台） |
| started_at | TIMESTAMPTZ | |
| finished_at | TIMESTAMPTZ | |

**active_sessions 表**——容器会话映射：

| 字段 | 类型 | 说明 |
|---|---|---|
| user_id | TEXT PK | 一个用户同一时刻只有一个活跃容器 |
| container_id | TEXT NOT NULL | Docker container ID |
| host | TEXT NOT NULL | agent 机器地址，如 `10.0.1.50` |
| host_port | INT NOT NULL | 宿主机映射端口，如 `32001` |
| daemon_url | TEXT NOT NULL | 如 `http://10.0.1.50:32001` |
| conversation_id | TEXT | 当前会话 |
| byok_config_id | TEXT | 注入的 BYOK 配置 |
| created_at | TIMESTAMPTZ | |
| last_active | TIMESTAMPTZ | 每次代理请求更新 |

**依赖**：无，最先做。

### 2.2 BYOK 凭证管理（Agent LLM + Media Provider）

用户需要配两类 key：Agent LLM（驱动代码生成的大模型，如 DeepSeek）和 Media Provider（驱动图片/视频/音频生成，如 OpenAI DALL-E、fal Flux）。两类 key 共用同一套加密存储和安全校验，分表存放。

**涉及文件**：

| 文件 | 内容 |
|---|---|
| `internal/model/byok_config.go` | Agent LLM 数据模型 |
| `internal/model/media_key.go` | Media Provider 数据模型 |
| `internal/dto/byok.go` | Agent LLM 请求/响应 DTO |
| `internal/dto/media_key.go` | Media Provider 请求/响应 DTO |
| `internal/repository/byok_repository.go` | Agent LLM 数据库操作 |
| `internal/repository/media_key_repository.go` | Media Provider 数据库操作 |
| `internal/service/byok_service.go` | 业务逻辑：加密/解密 apiKey、SSRF 校验 baseUrl |
| `internal/handler/byok_handler.go` | Agent LLM HTTP handler |
| `internal/handler/media_key_handler.go` | Media Provider HTTP handler |
| `internal/router/router.go` | 注册路由 |

**Agent LLM API**：

```
GET    /api/v1/byok              # 列出当前用户的 LLM 配置（apiKey 脱敏显示）
POST   /api/v1/byok              # 新增配置
PATCH  /api/v1/byok/:id          # 更新配置
DELETE /api/v1/byok/:id          # 删除配置
POST   /api/v1/byok/:id/default  # 设为默认
POST   /api/v1/byok/test         # 测试连通性（调一次 list-models）
```

**Media Provider API**：

```
GET    /api/v1/media-keys              # 列出当前用户配置的 media provider key（脱敏）
POST   /api/v1/media-keys              # 新增（provider_id + apiKey，可选 baseUrl）
PATCH  /api/v1/media-keys/:id          # 更新
DELETE /api/v1/media-keys/:id          # 删除
GET    /api/v1/media-keys/providers    # 返回支持的 provider 列表（从 daemon 的 media-models 导出）
```

**容器注入方式**：创建容器时，控制面从 DB 读出用户的所有 media key，按 provider_id 映射到对应环境变量注入容器：

```go
// provider_id → 环境变量名的映射（与 daemon media-config.ts:ENV_KEYS 对齐）
var mediaEnvMap = map[string]string{
    "openai":     "OD_OPENAI_API_KEY",
    "fal":        "OD_FAL_KEY",
    "grok":       "OD_GROK_API_KEY",
    "volcengine": "OD_VOLCENGINE_API_KEY",
    "google":     "OD_GOOGLE_API_KEY",
    "bfl":        "OD_BFL_API_KEY",
    "replicate":  "OD_REPLICATE_API_TOKEN",
    "elevenlabs": "OD_ELEVENLABS_API_KEY",
    // ...
}
```

**安全要点**（LLM 和 media key 统一）：
- `base_url` 入库前必须做 SSRF 校验：解析 URL → 拦截 `10.0.0.0/8`、`172.16.0.0/12`、`192.168.0.0/16`、`127.0.0.0/8`、`169.254.0.0/16`（含 AWS 元数据地址）、`fd00::/8`
- `api_key` 用 AES-256-GCM 加密后存入 `api_key_enc`，密钥从环境变量 `BYOK_ENCRYPTION_KEY` 读取
- GET 列表返回时 apiKey 只显示前 8 位 + `****`

**依赖**：2.1 迁移完成。

### 2.3 容器会话管理（SessionManager）

**涉及文件**：

| 文件 | 内容 |
|---|---|
| `internal/session/manager.go` | 核心：SessionManager 结构体 + GetOrCreate / Destroy / Touch |
| `internal/session/container.go` | 容器操作：通过 Docker API（TCP + TLS）连接 agent 专用机创建/删除容器 |
| `internal/session/state.go` | 状态操作：restore/save .od/ ↔ OSS |
| `internal/session/idle.go` | 后台 goroutine：扫描超时会话，触发销毁 |
| `internal/session/backup.go` | 后台 goroutine：定期 .od/ 增量快照 |
| `internal/model/active_session.go` | 数据模型 |
| `internal/repository/session_repository.go` | 数据库操作 |
| `internal/config/config.go` | 新增 `Session` 配置节点 |

**SessionManager 核心接口**：

```go
type Manager interface {
    // 获取用户的活跃容器；没有则创建（含 restore + 起 daemon + 等就绪）
    GetOrCreate(ctx context.Context, userID string) (*Session, error)

    // 更新最后活跃时间（每个代理请求调一次）
    Touch(ctx context.Context, userID string) error

    // 优雅销毁（flush WAL → save → 删容器）
    Destroy(ctx context.Context, userID string) error

    // 启动后台 idle 扫描 + 定期备份
    Start(ctx context.Context)

    // 服务关闭时：优雅销毁所有活跃容器
    Shutdown(ctx context.Context) error
}
```

**创建容器的步骤**（`GetOrCreate` 内部）：

```
1. 加锁（per-user 锁，防并发创建）
2. 查 active_sessions 表，如果有活跃记录 → 检查容器是否还活着
   → 活着 → 返回
   → 死了 → 清理记录，继续创建
3. 查用户的默认 BYOK 配置
4. 分配宿主机端口（从配置的端口范围如 32000-33000 中选空闲端口）
5. 通过 Docker API（TCP + TLS）在 agent 专用机上创建容器：
   - docker create + docker start
   - 镜像：od-daemon-runtime（只有 daemon，不含 web）
   - 端口映射：-p <host_port>:17456（宿主机端口映射到容器内 daemon 端口）
   - 环境变量：OD_DATA_DIR=/data, OD_BIND_HOST=0.0.0.0, OD_PORT=17456,
     OD_API_TOKEN=<随机生成>, OD_OPENCODE_PROVIDER_CONFIG=<BYOK JSON>,
     以及用户配置的 media key 环境变量（OD_OPENAI_API_KEY, OD_FAL_KEY 等）
   - entrypoint.sh 中 restore_state() 从 OSS 下载 .od/ 到 /data
   - 资源限制：--cpus / --memory
6. 等容器 Running + daemon /api/health 返回 200
7. 写 active_sessions 表（记录 container_id、host、host_port）
8. 返回 Session{DaemonURL: "http://<agent-host>:<host_port>", ...}
```

**销毁容器的步骤**（`Destroy` 内部）：

```
1. 加锁（per-user）
2. 查 active_sessions 获取容器信息
3. 调 daemon /api/health 确认还活着
4. docker stop --time 60（发 SIGTERM，给 daemon 60 秒优雅关闭，db.close() 刷 WAL）
5. entrypoint.sh 的 save_state() 把 .od/ 上传到 OSS
6. docker rm 删除容器
7. 释放宿主机端口
8. 删除 active_sessions 记录
```

**配置项**（加到 `config.yaml`）：

```yaml
session:
  idle_timeout: 30m           # 空闲超时
  backup_interval: 5m         # 定期快照间隔
  max_per_user: 1             # 每用户最多活跃容器数
  daemon_image: "open-design/daemon:latest"
  daemon_cpu_limit: "2"       # --cpus
  daemon_memory_limit: "4g"   # --memory
  max_run_duration: 10m       # 单轮最长运行时间
  health_check_timeout: 120s  # 等 daemon 就绪的超时

agent_host:
  address: "10.0.1.50"        # agent 专用机 IP
  docker_port: 2376           # Docker daemon TLS 端口
  tls_ca: "/app/ssl/agent-ca.pem"
  tls_cert: "/app/ssl/agent-cert.pem"
  tls_key: "/app/ssl/agent-key.pem"
  port_range_start: 32000     # 容器端口映射范围起始
  port_range_end: 33000       # 容器端口映射范围结束（最多 ~1000 并发容器）
```

**依赖**：2.1 迁移、2.2 BYOK 服务、OSS 服务（模板已有）。

### 2.4 OD API 代理层

**涉及文件**：

| 文件 | 内容 |
|---|---|
| `internal/proxy/handler.go` | HTTP handler：提取用户 → 获取容器 → 代理请求 |
| `internal/proxy/reverse_proxy.go` | 封装 `httputil.ReverseProxy`，处理 SSE 流式 |
| `internal/proxy/artifact.go` | 制品访问：优先代理到容器，fallback 到 OSS 预签名 URL |
| `internal/router/router.go` | 注册 `/api/od/*` 路由组 |

**代理路由映射**：

| 前端请求 | 代理到容器的 | 说明 |
|---|---|---|
| `POST /api/od/runs` | `POST /api/runs` | 发起一轮 run |
| `GET /api/od/runs/:id/events` | `GET /api/runs/:id/events` | SSE 流式事件 |
| `GET /api/od/runs/:id` | `GET /api/runs/:id` | 查询 run 状态 |
| `GET /api/od/conversations` | `GET /api/conversations` | 对话列表 |
| `GET /api/od/projects` | `GET /api/projects` | 项目列表 |
| `GET /api/od/artifacts/*` | `GET /artifacts/*` | 制品文件 |
| `*  /api/od/**` | `* /api/**` | 其他 daemon API 全量代理 |

**SSE 代理关键代码思路**：

```go
proxy := &httputil.ReverseProxy{
    Director: func(req *http.Request) {
        // 去掉 /api/od 前缀 → 变成 daemon 的 /api/*
        req.URL.Scheme = "http"
        req.URL.Host = session.DaemonURL
        req.URL.Path = strings.TrimPrefix(req.URL.Path, "/api/od")
        // 注入 daemon 的 OD_API_TOKEN
        req.Header.Set("Authorization", "Bearer "+session.Token)
    },
    FlushInterval: -1,  // 关键：立即 flush，保证 SSE 不被缓冲
    Transport: &http.Transport{
        ResponseHeaderTimeout: 0,      // SSE 长连接，不超时
        IdleConnTimeout:       0,
    },
}
```

**代理层的额外职责**：
- 每个请求调 `session.Touch()` 重置 idle 计时器
- 对 `POST /api/od/runs` 请求：在代理前扣费（预扣），代理后监听结果（确认/回滚）
- 如果用户没有活跃容器：自动 `GetOrCreate`（会有冷启动延迟，前端需要 loading 状态）

**依赖**：2.3 SessionManager。

### 2.5 计费钩子

**涉及文件**：

| 文件 | 内容 |
|---|---|
| `internal/service/billing_service.go` | 封装计费逻辑：预扣 / 确认 / 回滚 |
| `internal/service/call_record_service.go` | 调用日志的 CRUD |
| `internal/model/call_record.go` | 数据模型 |
| `internal/repository/call_record_repository.go` | 数据库操作 |
| `internal/handler/call_record_handler.go` | 调用日志查询 API（前台 + 运营后台） |

**扣费流程（嵌入代理层）**：

```
POST /api/od/runs 到达代理层
  ├→ billingService.Freeze(user, estimatedQuota)   # 预扣
  │   └→ 写 call_records (status=processing, wallet_biz_id=xxx)
  ├→ 代理到 daemon
  ├→ 后台 goroutine 监听 run 结果：
  │   ├→ succeeded → billingService.Confirm(bizId, actualQuota)
  │   │              更新 call_records (status=completed, quota_used=xxx)
  │   └→ failed    → billingService.Rollback(bizId)
  │                  更新 call_records (status=failed, error_message=xxx)
  └→ 余额不足 → 直接返回 402，不代理
```

**调用日志 API**：

```
GET /api/v1/call-records              # 当前用户的调用日志（分页、筛选）
GET /api/v1/call-records/:id          # 单条详情
GET /api/admin/call-records           # 运营后台：全量调用日志
GET /api/admin/call-records/:id       # 运营后台：单条详情（含 error_detail）
```

**依赖**：2.1 迁移、模板的 WalletService。

### 2.6 MCP 工具实现

**涉及文件**：

| 文件 | 内容 |
|---|---|
| `internal/mcpserver/server.go` | 扩展模板的 MCP server，注册 3 个工具 |
| `internal/mcpserver/tools.go` | 工具实现：list_templates / generate_design / refine_design |

**三个工具**：

| 工具 | 输入 | 实现方式 |
|---|---|---|
| `list_templates` | 无 | 返回内置模板列表（静态数据，从 daemon 的 skill/design-system 目录读） |
| `generate_design` | template_id, brief, reference_files? | 起 per-turn 容器跑一轮，返回生成的 HTML |
| `refine_design` | template_id, existing_html, change_request | 起 per-turn 容器跑一轮（把 existing_html 作为已有文件注入） |

MCP 请求用 API Key 鉴权，走 per-turn 模式（每次请求起一个容器），不走 per-session。

**依赖**：2.3 SessionManager（复用容器创建逻辑，但用 per-turn 模式）、2.5 计费。

### 2.7 运营后台 API

**涉及文件**：

| 文件 | 内容 |
|---|---|
| `internal/handler/admin_session_handler.go` | 活跃会话管理（查看、强制销毁） |
| `internal/handler/admin_call_record_handler.go` | 调用日志查询（含原始错误） |
| `internal/handler/admin_stats_handler.go` | 统计大屏数据 |

**API**：

```
GET    /api/admin/sessions                # 当前所有活跃容器
DELETE /api/admin/sessions/:user_id       # 强制销毁某用户的容器
GET    /api/admin/call-records            # 全量调用日志
GET    /api/admin/call-records/:id        # 单条详情（含 error_detail）
GET    /api/admin/stats/overview          # 总览：活跃用户数、总调用量、成功率、平均耗时
```

**依赖**：2.3、2.5。

### 2.8 配置文件更新

**位置**：`backend/config.yaml`

在模板默认配置基础上追加：

```yaml
session:
  idle_timeout: 30m
  backup_interval: 5m
  max_per_user: 1
  daemon_image: "open-design/daemon:latest"
  daemon_cpu_limit: "2"
  daemon_memory_limit: "4Gi"
  health_check_timeout: 120s

byok:
  encryption_key: ""          # 生产从环境变量 BYOK_ENCRYPTION_KEY 注入

proxy:
  strip_prefix: "/api/od"
  timeout: 600s               # 单轮 run 最长 10 分钟
```

### 2.9 依赖引入

**位置**：`backend/go.mod`

需要新增的依赖：

| 包 | 用途 |
|---|---|
| `github.com/docker/docker/client` | Docker Engine API，远程创建/删除容器 |
| `github.com/docker/docker/api/types` | Docker 容器/网络等类型定义 |
| `github.com/minio/minio-go/v7` | 如果模板的 OSSService 不够用，直接操作 MinIO |

模板已有的依赖（不需要额外引入）：
- `github.com/gin-gonic/gin`（HTTP 框架）
- `gorm.io/gorm`（ORM，对象关系映射）
- `git.in.chaitin.net/ai/baizhiyun/opensdk`（百智云 SDK）

---

## 三、Daemon 容器镜像

### 3.1 最终镜像（在 `saas-runtime/Dockerfile` 基础上调整）

当前镜像的问题：
- BYOK 改动尚未烧入（靠 bind-mount 验证）
- 没有 restore/save 脚本（entrypoint 里是 TODO）
- 镜像偏大（1.85GB）

需要做的改动：

| 改动 | 说明 |
|---|---|
| 重新构建，把 BYOK 代码烧入 | 不再 bind-mount dist |
| 去掉 entrypoint.sh 中 restore/save 的 TODO 占位 | 在 SaaS 模式下，restore/save 由 Go 控制面负责，不由容器自己做 |
| 简化 entrypoint | 容器只负责启动 daemon + 等就绪 + 优雅关闭。状态管理是控制面的事 |
| 添加健康检查 | `HEALTHCHECK CMD curl -f http://127.0.0.1:7456/api/health` |

**简化后的 entrypoint**：

```bash
#!/bin/sh
set -eu
# 控制面已经把 .od/ 放到 $OD_DATA_DIR 了（通过 initContainer 或 emptyDir 挂载）
# 容器只管起 daemon 和优雅关闭
node /app/apps/daemon/dist/cli.js --no-open &
DAEMON_PID=$!
trap 'kill -TERM $DAEMON_PID; wait $DAEMON_PID' TERM INT
wait $DAEMON_PID
```

### 3.2 镜像推送到百智云 registry

在 `.gitlab-ci.yml` 中加一个 daemon 镜像的构建 job（见第六节）。

---

## 四、OD Web 前端适配 → 不需要

### 低入侵结论：OD Web 代码零改动

OD Web 原封不动地运行在 SaaS 外壳的 iframe 中。所有原本计划改 OD Web 的需求，全部由 **SaaS 仓库** 的外壳前端和 nginx 路径改写来替代：

| 原方案 | 低入侵替代 | OD 代码变化 |
|---|---|---|
| 4.1 API 基地址配置 | nginx 把 `/api/*` 改写到 Go 控制面 → 转发到 daemon 容器 | **无** |
| 4.2 用户上下文 | SaaS 外壳顶栏显示用户名/退出，OD Web 不知道用户 | **无** |
| 4.3 BYOK 设置页 | SaaS 控制台独立页面管理 BYOK，启动 daemon 时注入 env | **无** |
| 4.4 导航入口 | SaaS 外壳顶栏提供"控制台"链接 | **无** |
| 4.5 SaaS 模式开关 | 不需要模式开关，OD Web 始终以标准模式运行 | **无** |

### 具体实现

**OD Web 镜像（od-web）**：

```dockerfile
# 直接构建 OD 原码的 apps/web，不改任何源文件
FROM node:24-bookworm AS builder
COPY open-design/ /build/
WORKDIR /build
RUN corepack enable && pnpm install
RUN pnpm --filter @open-design/web build

FROM nginx:alpine
COPY --from=builder /build/apps/web/.next/standalone /app
COPY nginx-od-web.conf /etc/nginx/conf.d/default.conf
EXPOSE 3000
```

**nginx 路径改写（核心低入侵机制）**：

```nginx
server {
    listen 8080;

    # OD Web 的 /api/* 请求 → 转给 Go 控制面
    # Go 控制面鉴权后 → 转发到用户的 daemon 容器
    location /api/ {
        proxy_pass http://backend:8080/api/od/;
    }

    # OD Web 自身的页面和静态资源
    location / {
        proxy_pass http://od-web:3000;
    }
}
```

OD Web 发出 `fetch('/api/chat')` → nginx 改写为 `backend:8080/api/od/chat` → Go 控制面鉴权、找到用户的 daemon 容器 → 转发到 `daemon-pod:17456/api/chat`。**OD Web 全程不知道自己在 SaaS 里**。

---

## 五、控制台前端（`frontend/`）

### 5.1 从模板调整页面

模板已有的页面，按 Open Design 业务调整：

| 页面 | 路由 | 调整内容 |
|---|---|---|
| 统计分析 | `/console/analytics` | 展示设计生成次数、成功率、模型分布 |
| 密钥管理 | `/console/keys` | 直接复用模板 |
| 快速集成 | `/console/developer-access` | MCP 安装说明改为 Open Design 的 |
| 用量统计 | `/console/usage-monitoring` | 展示积分消耗趋势 |
| 运营后台 - 用户 | `/admin/users` | 直接复用模板 |
| 运营后台 - 会话 | `/admin/sessions` | **新增**：当前活跃容器列表，支持强制销毁 |
| 运营后台 - 调用日志 | `/admin/call-records` | **新增**：全量调用日志，含排障信息 |

### 5.2 新增页面

**活跃会话管理**（`/admin/sessions`）：

- 表格：用户名、容器 ID、创建时间、最后活跃时间、使用模型
- 操作：强制销毁
- 调用 `GET /api/admin/sessions`、`DELETE /api/admin/sessions/:user_id`

**调用日志**（`/admin/call-records`）：

- 表格：时间、用户、来源、模型、状态、耗时、消耗积分
- 筛选：时间范围、状态、用户、来源
- 详情：展开显示 error_detail（仅运营后台可见）
- 调用 `GET /api/admin/call-records`

### 5.3 文档文件

**位置**：`frontend/public/docs/`

| 文件 | 内容 |
|---|---|
| `installation.md` | MCP 安装配置说明：如何在 Claude Code / opencode 等客户端配置 Open Design MCP |
| `skills.md` | Skill 使用说明：三个 MCP 工具的触发词和用法 |

---

## 六、部署配置（`deploy/`）

### 6.1 Helm Chart 改动

**位置**：`deploy/helm/open-design/`

在模板的 Chart 基础上，新增/修改：

**新增 Deployment：od-web**

```yaml
# templates/od-web-deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "open-design.fullname" . }}-od-web
spec:
  replicas: 1
  template:
    spec:
      containers:
        - name: od-web
          image: "{{ .Values.odWeb.image.repository }}:{{ .Values.odWeb.image.tag }}"
          ports:
            - containerPort: 3000    # Next.js 默认端口
          env:
            - name: OD_SAAS_MODE
              value: "true"
            - name: OD_API_BASE
              value: "http://{{ include "open-design.fullname" . }}-backend:8080"
```

**新增 Service：od-web**

```yaml
# templates/od-web-service.yaml
apiVersion: v1
kind: Service
metadata:
  name: {{ include "open-design.fullname" . }}-od-web
spec:
  ports:
    - port: 3000
      targetPort: 3000
```

**修改 frontend nginx 配置**

前端 nginx 做路径分流：

```
/console/*  → 控制台前端（自己）
/admin/*    → 控制台前端（自己）
/api/*      → Go 控制面 backend
/mcp        → Go 控制面 backend
/*          → OD Web（od-web service）
```

**修改 auth-proxy-app**

`upstream` 指向前端 nginx Service（它负责分流）。

**修改 values.yaml**

追加：

```yaml
odWeb:
  replicaCount: 1
  image:
    repository: open-design/od-web
    tag: ""
    pullPolicy: IfNotPresent
  service:
    name: open-design-od-web
    port: 3000
    targetPort: 3000

daemon:
  image:
    repository: open-design/daemon
    tag: ""

agentHost:
  address: ""                # agent 专用机 IP，如 10.0.1.50
  dockerPort: 2376
  portRangeStart: 32000
  portRangeEnd: 33000
  tlsCA: ""                  # base64 编码的 CA 证书
  tlsCert: ""                # base64 编码的客户端证书
  tlsKey: ""                 # base64 编码的客户端私钥
```

**新增 backend ConfigMap 字段**

daemon 镜像地址、session 配置、BYOK 加密密钥等通过 ConfigMap/Secret 注入。

**新增 Secret：agent 机器 TLS 证书**

Go 控制面通过 Docker API（TCP + TLS 双向认证）连接 agent 专用机，不需要 K8s RBAC：

```yaml
# templates/agent-host-secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "open-design.fullname" . }}-agent-tls
type: Opaque
data:
  ca.pem: {{ .Values.agentHost.tlsCA | b64enc }}
  cert.pem: {{ .Values.agentHost.tlsCert | b64enc }}
  key.pem: {{ .Values.agentHost.tlsKey | b64enc }}
```

backend Deployment 挂载这个 Secret 到 `/app/ssl/agent-*.pem`。

### 6.2 CI 改动

**位置**：`.gitlab-ci.yml`

在模板的 CI 基础上，新增两个镜像构建 job：

```yaml
k3s-build-image-od-web:
  extends: .k3s-build-image-template
  variables:
    COMPONENT: od-web
    DOCKERFILE: images/od-web/Dockerfile   # 拉 OD 源码、构建 apps/web、nginx 服务
    BUILD_CONTEXT: images/od-web

k3s-build-image-daemon:
  extends: .k3s-build-image-template
  variables:
    COMPONENT: daemon
    DOCKERFILE: images/daemon/Dockerfile   # 拉 OD 源码、构建 daemon subgraph
    BUILD_CONTEXT: images/daemon
```

更新 chart job 的 `needs`，加上这两个镜像 job。

### 6.3 Release Bundle

**位置**：`deploy/release/`

- `values-dev.yaml` 添加 od-web 和 daemon 镜像的 dev registry 地址
- `values-prod.yaml` 同上，prod registry 地址
- `secret.yaml` 添加 `BYOK_ENCRYPTION_KEY` 占位

---

## 七、仓库组织方式

### 核心原则：OD 仓库零改动

SaaS 仓库是一个 **完全独立** 的项目，OD 仓库只作为构建时的源码输入。两个仓库之间没有代码耦合、没有 import 依赖、没有共享模块。

### 仓库结构

```
git.in.chaitin.net/ai/baizhiyun/open-design/    ← SaaS 仓库（百智云 GitLab）
├── backend/           # Go 控制面（从模板生成 + 扩展）
├── frontend/          # SaaS 外壳 + 控制台前端（iframe 嵌入 OD Web）
├── images/            # 镜像构建上下文
│   ├── daemon/        # daemon Dockerfile + entrypoint.sh
│   │   └── Dockerfile # 拉 OD 源码 → 构建 daemon subgraph → 精简运行时镜像
│   └── od-web/        # OD Web Dockerfile
│       └── Dockerfile # 拉 OD 源码 → 构建 apps/web → nginx 静态服务
├── deploy/            # Helm Chart + Release values
├── .gitlab-ci.yml     # CI（4 个镜像：backend / frontend / daemon / od-web）
└── README.md

github.com/PerishCode/open-design/               ← OD 上游仓库（不改动）
└── （原封不动，正常迭代）
```

### OD 版本管理

SaaS 仓库通过 **镜像构建时指定 OD 版本** 来跟踪上游：

```dockerfile
# images/daemon/Dockerfile
ARG OD_VERSION=v0.8.2          # 或 commit hash
FROM node:24-bookworm AS builder
RUN git clone --branch ${OD_VERSION} --depth 1 https://github.com/PerishCode/open-design.git /build
WORKDIR /build
RUN corepack enable && pnpm install
RUN pnpm --filter @open-design/daemon... build
# ...
```

升级 OD 只需改 `OD_VERSION` 的值，重新构建镜像，部署。不需要 merge、不需要 resolve conflict。

### 为什么不用 git submodule

- submodule 增加 CI 复杂度（需要递归 checkout）
- 构建只需要 OD 源码，不需要运行时引用
- Dockerfile 的 `git clone --branch <tag>` 更简单、更可控

---

## 八、工作优先级和依赖关系

```
阶段 0（当前）
  └→ 多轮接力验证 ← 不依赖百智云，用 Docker volume 模拟

阶段 1 - 基础设施（可并行）
  ├→ 1.1 初始化项目骨架 + 确认 APP ID/证书
  ├→ 1.2 数据库迁移（三张表）
  └→ 1.3 daemon 镜像最终化（简化 entrypoint，烧入 BYOK 代码）

阶段 2 - 核心控制面（串行依赖）
  ├→ 2.1 BYOK 凭证管理 ← 依赖 1.2
  ├→ 2.2 容器会话管理（SessionManager）← 依赖 1.2 + 1.3 + 2.1
  ├→ 2.3 OD API 代理层 ← 依赖 2.2
  └→ 2.4 计费钩子 ← 依赖 2.3

阶段 3 - 前端（可与阶段 2 部分并行）
  ├→ 3.1 SaaS 外壳前端（iframe + 顶栏）← 依赖 2.3 的 nginx 路径改写
  ├→ 3.2 控制台页面（Agent LLM 配置 / Media Provider 配置 / 用量 / 密钥）← 依赖 2.1、2.4 的 API
  ├→ 3.3 od-web 镜像 ← 不依赖其他，直接从 OD 源码构建
  └→ 3.4 文档（installation.md / skills.md）

阶段 4 - 部署 + 联调
  ├→ 4.1 Helm Chart ← 依赖阶段 2、3
  ├→ 4.2 CI 流水线 ← 依赖 4.1
  ├→ 4.3 dev 环境部署 ← 依赖 4.2 + 平台依赖确认
  └→ 4.4 端到端验收 ← 依赖 4.3

阶段 5 - 补全
  ├→ MCP 工具
  ├→ 运营后台页面
  └→ 调用日志 + 统计大屏
```

---

## 九、验收标准

### Phase 1 交付标准（最小可用）

- [ ] 用户通过百智云登录后，看到 SaaS 外壳（顶栏 + iframe 中的 OD Web 完整界面）
- [ ] 用户在控制台页面配置 BYOK（填 baseUrl + apiKey + 模型）
- [ ] 用户发送 prompt，生成设计稿 HTML，前端实时显示生成过程（SSE 流式）
- [ ] 用户可以多轮迭代（"按钮改蓝"、"加个 hero 区"），每轮都能看到前序内容
- [ ] 用户关闭浏览器、过段时间回来，之前的对话和项目还在
- [ ] 每次 run 扣积分，余额不足时拒绝执行
- [ ] 控制台可查看 API Key、钱包余额
- [ ] 运营后台可查看用户列表

### Phase 2 交付标准（完整体验）

- [ ] MCP 工具可用：外部 agent 通过 API Key 调 `generate_design` 生成设计稿
- [ ] 调用日志完整：时间、用户、模型、状态、耗时、消耗
- [ ] 运营后台大屏：活跃用户数、调用量、成功率

---

*本文档基于 `open-design-saas.md` v3 方案（低入侵原则）和百智云 `template` 仓库的代码调研撰写。OD 仓库零改动。*
