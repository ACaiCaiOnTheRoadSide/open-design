# Open Design SaaS 化技术方案

> 版本：v3 · 2026-06-15
> 目标：把 Open Design 的**完整能力**（Web UI + AI 设计生成 + 多轮对话 + 制品预览 + skill/design system）搬到百智云平台，做成多用户 SaaS 服务。

---

## 核心设计原则：低入侵

**OD 仓库上游随时会更新，我们的 SaaS 层必须能轻松跟进，不能让升级变成合并冲突的噩梦。**

这意味着：

1. **OD 源码零改动**——daemon 和 web 的 `src/` 不动一行。所有 SaaS 行为通过环境变量、nginx 路径改写、外部代理实现。
2. **SaaS 是 OD 的"外壳"**——独立仓库，通过构建镜像时拉 OD 代码、运行时注入环境变量来集成。OD 仓库不知道 SaaS 的存在。
3. **升级 OD = 改一个版本号重新构建**——拉最新 OD tag → 重建 daemon/web 镜像 → 部署。中间不需要手动改代码、不需要 cherry-pick、不需要 resolve conflict。
4. **需要改 OD 的功能，走上游 PR**——如果某个能力确实需要 OD 配合（比如 BYOK merge），提 PR 合进 OD 上游，而不是在 SaaS 仓库维护 patch。

**如何做到**：

| 过去方案里要改 OD 的点 | 低入侵替代方案 |
|---|---|
| OD Web API 基地址改为 `/api/od/*` | **nginx 路径改写**：OD Web 仍然调 `/api/*`，nginx 把 `/api/*` 代理到 Go 控制面，控制面再转发到容器的 daemon。OD Web 代码不动 |
| OD Web 加用户信息/登出按钮 | **SaaS 前端外壳**：OD Web 作为 iframe 嵌在 SaaS 前端里，外壳负责顶栏（用户名、登出、控制台入口），iframe 里是完整的原生 OD 界面 |
| OD Web BYOK 设置页改为调控制面 | **SaaS 前端独立页面**：BYOK 管理做在 SaaS 前端的控制台页面里（`/console/byok`），不动 OD Web 的设置页。容器创建时由控制面注入 BYOK 环境变量，daemon 直接读到 |
| OD Web 去掉 desktop 相关 | **不去掉**：desktop 相关代码在 SaaS 模式下不会触发（没有 Electron 环境），留着不影响 |
| daemon 加 BYOK merge | **已提交，推进合入上游**：这是 OD 本身也受益的功能，应该成为 OD 的正式能力 |

---

## 30 秒读懂

**一句话**：用户打开浏览器，看到和本地装 Open Design 一样的界面——聊天、生成设计稿、预览、多轮迭代。底下跑的全是原生 OD 代码，只是部署在云端、按用户隔离。**OD 仓库一行不改。**

- **Go 控制面 + OD 原生容器**：用百智云模板的 Go 后端做控制面（控制面 = 管用户、管计费、管容器调度的中枢），容器内跑原生 OD daemon + web，不动核心代码。
- **OD Web 套 iframe**：SaaS 前端是一个薄壳——顶栏（用户名、控制台链接）+ iframe（完整的原生 OD Web）。OD Web 源码不改，通过 nginx 路径改写让它以为自己在和 daemon 直连。
- **双模式容器**：Web UI 用户拿到「会话容器」（per-session，用户在线期间常驻，空闲超时回收）；API/MCP 调用走「单轮容器」（per-turn，用完即毁）。
- **百智云平台全量对接**：用户系统、登录、团队、API Key、积分钱包、对象存储、部署流水线全走百智云现成基础设施。
- **状态在对象存储**：`.od/`（SQLite 数据库 + 项目文件）存在百智云平台的 MinIO（S3 兼容的对象存储服务），容器启动时 restore（恢复），关闭前 save（保存）。

---

## 摘要（一分钟读完）

- **产品体验**：用户通过百智云入口访问，看到完整的 OD Web UI（聊天面板、设计稿预览、项目管理、多轮迭代）。不是阉割版，而是**原样复刻**本地版的全部能力。
- **技术架构**：三层——共享前端（OD Web）→ Go 控制面（百智云模板扩展）→ 隔离的 daemon 容器（每用户一个）。
- **用户系统**：不自建。百智云网关（gateway，统一入口代理）通过 HTTP header 注入用户/团队身份，Go 控制面直接读取。
- **计费**：对接百智云钱包 SDK（OpenSDK），按轮/按用量扣积分。1 元 = 100 积分 = 10000 额度。
- **BYOK**（Bring Your Own Key，自带密钥）：用户填自己的模型 baseUrl/apiKey，模型费自付；平台只收基础设施费。
- **对象存储**：平台提供共享 MinIO，用于存 `.od/` 状态和生成的制品（artifact，AI 产出的 HTML/图片等文件）。
- **部署**：GitLab CI → Helm Chart → Argo CD GitOps（基于 Git 仓库做声明式部署），dev/prod 双环境。
- **主要新建工作**：Go 控制面（容器调度、API 代理、状态管理、计费钩子）+ SaaS 前端外壳 + 部署配置。**OD daemon 和 OD Web 代码零改动**。

---

# 第一部分：Open Design 现有架构

## 1.1 全景：一张图看懂

Open Design 是"本地优先"（local-first）的桌面/Web 应用，三个进程通过 `pnpm tools-dev` 统一拉起。先看整体，再逐层拆解：

```
                          用户机器（本地）

  ┌─────────── 浏览器  apps/web（Next.js + React）────────────┐
  │   聊天面板      ·      预览 iframe（沙箱）      ·     设置/BYOK │
  └────────┬───────────────────────────────────────▲───────────┘
           │                                       │
    ① POST /api/runs（本轮 prompt）            ⑤ GET /artifacts/*.html
    ② ◄════ SSE 流式事件 ════                  （iframe 加载 HTML，浏览器内渲染）
           │                                       │
  ┌────────▼───────────────────────────────────────┴───────────┐
  │              daemon  apps/daemon（:7456，后端大脑）           │
  │    HTTP 路由 /api/*      ·      会话 / run 管理（内存 Map）    │
  │    agent 调度    ·    技能/设计系统注入    ·    制品存储/导出   │
  └──────┬─────────────────────────────┬────────────────────────┘
         │ 读写                         │ ③ spawn 子进程
         ▼                              ▼
   ┌─ .od/ 存储 ───────┐        ┌─ opencode 子进程 ─────────┐
   │ app.sqlite        │  制品   │ opencode run --json       │
   │ projects/<id>/    │◄───────┤ 用 BYOK 的 baseUrl/key     │──④──► 大模型 API
   │ artifacts/        │  落盘   └───────────────────────────┘    （用户自带）
   └───────────────────┘
```

**数据流（对应图中编号）**：① 浏览器把本轮 prompt（用户输入的指令）发给 daemon → ② daemon 通过 SSE（Server-Sent Events，基于普通 HTTP 的服务器单向推送）把生成过程流式推回浏览器 → ③ daemon 派生 opencode 子进程干活 → ④ opencode 用模型 key 调大模型 → ⑤ 制品落盘后，前端 iframe 取回 HTML 在浏览器渲染。

**三大组件职责**：

| 组件 | 技术栈 | 职责 |
|---|---|---|
| **web**（`apps/web`） | Next.js 16 + React 18 | 前端界面：聊天面板、制品预览（沙箱 iframe）、设置页。纯前端 + 少量服务端代理。 |
| **daemon**（`apps/daemon`） | Node.js HTTP 长服务 | 真正的后端大脑：监听 `127.0.0.1:7456`，提供 `/api/*`，负责会话、调度 agent、技能/设计系统、制品存储、导出。 |
| **desktop**（`apps/desktop`） | Electron | 桌面外壳，通过 sidecar IPC（进程间通信）发现 web 地址。**SaaS 版不需要**。 |

关键事实：**daemon 是整个产品的后端**，opencode 只是它派生的"干活的手"，`.od/` 是它的数据盘。SaaS 化的核心就是"把这套 daemon + `.od/` 搬到云上、按用户隔离地运行"。

## 1.2 核心数据流（一轮对话怎么走）

```
浏览器                         daemon (127.0.0.1:7456)            opencode 子进程
  │  POST /api/runs  ───────────►│                                    │
  │  （含本轮 prompt）              │ 创建 run 对象（内存）              │
  │  ◄─── 202 + runId ───────────│ 立即返回，不阻塞                   │
  │                              │ 异步 spawn ───────────────────────►│
  │  GET /api/runs/:id/events    │                                    │ 调大模型，
  │  ◄═══ SSE 流式事件 ══════════│◄══ 边生成边吐（stdout 解析）═══════│ 边生成 HTML
  │  （一个字一个字蹦出来）        │                                    │
  │                              │ 制品落盘到 .od/projects/<id>/      │
  │  GET /artifacts/xxx.html ───►│ 静态返回制品                       │
  │  iframe 渲染预览             │                                    │
```

要点：
- 一次 run 是**异步**的：`POST /api/runs` 立即返回 202 + runId，然后通过 SSE 把过程流式推给浏览器。
- run 的实时状态存在 daemon **内存**里（`runs.ts` 的全局 `Map`），完成后落库。

## 1.3 数据存储模型（`.od/` 目录）

daemon 把所有数据写在 `.od/` 下，可用环境变量 `OD_DATA_DIR` 整体搬迁到任意目录：

| 路径 | 内容 |
|---|---|
| `.od/app.sqlite`（+ `-wal` / `-shm`） | SQLite 数据库：`conversations`（对话）、`messages`（逐轮历史）、`projects`、`agent_sessions` 等所有元数据 |
| `.od/projects/<projectId>/` | 用户工作区：生成的 HTML 制品、上传的素材 —— agent 读写文件的对象 |
| `.od/artifacts/` | 不挂在具体项目下的制品 |
| `.od/runs/<runId>/events.jsonl` | 单轮运行的事件日志 |
| `.od/media-config.json` | 凭证（API key 等） |

## 1.4 Agent 执行与 BYOK

- daemon 用 `execFile()` **spawn**（派生子进程）opencode，命令形如 `opencode run --format json -m <model>`。
- **配置注入通道现成**：daemon 设置 `OPENCODE_DISABLE_PROJECT_CONFIG=true` 让 opencode 只认 daemon 通过环境变量 `OPENCODE_CONFIG_CONTENT` 注入的内联 JSON 配置。
- **BYOK 已实现**：`mergeOpenCodeProviderConfig()` 把用户的 provider 块合并进 daemon 的配置，解决了 daemon 覆盖用户 provider 的根因。经 deepseek 实测 run succeeded。

## 1.5 多轮对话的连续性机制（关键）

经代码核实：

- opencode 属于"非 resume"类 agent：它每轮都是全新进程、毫无记忆；daemon 自己从 SQLite 把**完整对话历史**读出来（`listMessages`），拼成一大段文本重新喂给一个全新的 opencode。

> **这一条是 SaaS 方案的地基**：既然 opencode 的记忆完全由 `.od/` 承载、每轮重灌，那么只要持久化 `.od/`，就能在任意全新容器里无缝接续对话 —— opencode 自己的 home 目录**完全不需要跨容器保留**。

## 1.6 制品预览机制

daemon 把 AI 生成的 HTML 写到磁盘，前端用**沙箱化 iframe**（隔离的内嵌子页面）加载渲染。**渲染发生在用户浏览器**，云端从不画图、不推像素流。

---

# 第二部分：百智云平台集成

## 2.1 百智云提供了什么

百智云有一套标准应用模板（`template` 仓库），新应用基于这个模板创建。模板已经帮我们搞定了大量基础设施：

### 用户系统（零代码）

百智云的网关（gateway）在请求到达后端之前，通过 HTTP header 注入用户身份：

| Header | 含义 |
|---|---|
| `X-Baizhiyun-User-Id` | 用户 ID |
| `X-Baizhiyun-User-Name` | 用户名 |
| `X-Baizhiyun-Team-Id` | 团队 ID |
| `X-Baizhiyun-Team-Role` | 团队角色（可逗号分隔，含 `admin` 即管理员） |

我们的后端只需从 header 里读这些值，**不需要做登录、注册、OAuth、session 管理**。

### 计费系统（对接 SDK）

- 百智云提供钱包 SDK（`OpenSDK`），支持**预扣费 → 确认扣费 → 失败回滚**的三步事务。
- 单位换算固定：1 元 = 100 积分 = 10000 额度。SDK 传入/返回的是额度，前端展示时除以 100 换算为积分。
- 后端通过 `service.WalletService` 调用，按 `(user_id, team_id)` 隔离。

### API Key 管理（已有）

- 模板已有完整的 API Key CRUD（创建/读取/更新/删除）：创建、重置、启用、禁用、删除。
- 按 `(user_id, team_id)` 隔离。`Authorization: Bearer <key>` 鉴权。
- MCP 入口 `/mcp` 和 OpenAPI 入口 `/openapi/v1` 都用 API Key 鉴权。

### 对象存储（平台共享 MinIO）

- 平台提供共享的 MinIO（S3 兼容的对象存储）实例，通过 `platform-runtime-config` ConfigMap（K8s 里的配置字典）和 `platform-shared-secrets` Secret 注入 endpoint、bucket、access key 等。
- 模板的 `OSSService` 已封装好上传/下载/预签名 URL 等操作。
- 每个应用有独立的 `oss.directory` 前缀做隔离。

### 部署流水线（Helm + GitOps）

- GitLab CI 自动构建镜像 → 打包 Helm Chart → 推送到 OCI registry → 更新 Argo CD GitOps 仓库。
- dev 环境：推送到 main/dev 分支自动部署。
- prod 环境：打 tag（如 `v1.0.0`）触发部署。
- dev 和 prod 各有独立的 registry、GitOps 仓库、证书和 APP ID。

### 其他已有能力

- **审计日志**：通用 `audit_records` 表，按 `resource_type` / `action` 记录。
- **App Stats**：应用统计上报到 statshub。
- **MCP Server**：`internal/mcpserver`，Streamable HTTP，无状态模式。
- **前端骨架**：React/Vite 控制台，含统计分析、密钥管理、用量监控、运营后台等页面。

## 2.2 百智云模板的项目结构

```
template/
├── backend/                     # Go/Gin 后端
│   ├── cmd/server/main.go       # 主入口
│   ├── cmd/migrate/main.go      # 数据库迁移
│   ├── internal/
│   │   ├── app/                 # 应用初始化
│   │   ├── auth/                # 用户上下文
│   │   ├── component/           # 依赖装配（DI 容器）
│   │   ├── config/              # 配置加载（yaml + 环境变量）
│   │   ├── handler/             # HTTP handler
│   │   ├── middleware/          # 网关鉴权、API Key 鉴权、错误处理
│   │   ├── service/             # 业务逻辑
│   │   ├── repository/          # 数据访问
│   │   ├── model/               # 数据模型
│   │   ├── migration/           # 数据库迁移
│   │   ├── mcpserver/           # MCP 协议层
│   │   ├── opensdk/             # 百智云 OpenSDK
│   │   └── stats/               # 统计上报
│   └── config.yaml
├── frontend/                    # React/Vite 前端
│   ├── src/
│   │   ├── pages/               # 控制台页面
│   │   ├── components/          # UI 组件（shadcn）
│   │   └── lib/                 # API 客户端、鉴权、工具
│   └── nginx.conf               # 生产 nginx 配置
├── deploy/
│   ├── helm/template/           # Helm Chart
│   └── release/                 # GitOps release bundle
└── .gitlab-ci.yml               # CI 流水线
```

## 2.3 对 SaaS 化的关键影响

百智云模板改变了 v1 方案中的几个假设：

| v1 方案的假设 | 百智云实际情况 | 影响 |
|---|---|---|
| 需要自建用户系统 | 网关已搞定，读 header 即可 | 砍掉控制面中"账号/登录"的全部工作 |
| 需要自建计费 | 钱包 SDK 现成 | 只需在关键节点调 SDK 扣费 |
| 需要选型对象存储 | 平台提供共享 MinIO | `.od/` 的 restore/save 直接用 |
| 需要自建部署流水线 | GitLab CI + Helm + ArgoCD 全套 | 按模板填即可 |
| 控制面语言待定 | 模板是 Go/Gin | **Go 控制面**确定 |

---

# 第三部分：SaaS 架构设计

## 3.1 整体架构图

```
┌──────────────────────────── 用户浏览器 ─────────────────────────────┐
│                                                                     │
│   OD Web UI（聊天、预览、项目管理、设置）                              │
│   + 百智云控制台页面（密钥管理、用量统计、计费、运营后台）                │
│                                                                     │
└─────────────────────────────┬───────────────────────────────────────┘
                              │ HTTPS
                              ▼
╔═════════════════════ 百智云网关（gateway）════════════════════════════╗
║   域名路由 → 注入 X-Baizhiyun-User-Id / Team-Id 等 header          ║
║   未登录 → 重定向到百智云统一登录页                                    ║
╚════════════════════════════╪═════════════════════════════════════════╝
                             │
           ┌─────────────────┼──────────────────┐
           │                 │                  │
           ▼                 ▼                  ▼
  ┌── OD Web ──┐    ┌── Go 控制面 ──┐    ┌── 静态资源 ──┐
  │ (共享前端)   │    │ (百智云模板   │    │ (制品预览)    │
  │ Next.js     │    │  Go 后端扩展) │    │ OSS/CDN      │
  │ 所有用户    │    │              │    └──────────────┘
  │ 共享一个    │    │ 平台 API:    │
  │ 实例        │    │  /api/v1/*   │
  │             │    │  用户/密钥/  │
  │ API 请求    │    │  钱包/统计   │
  │ 指向控制面──┼───►│              │
  │             │    │ 代理 API:    │
  └─────────────┘    │  /api/od/*   │
                     │  → 路由到用  │
                     │  户的 daemon │
                     │  容器        │          ┌─── OSS（MinIO）───┐
                     │              │          │ open-design/      │
                     │ 容器调度:    │          │   users/<uid>/    │
                     │  创建/销毁   │◄────────►│     .od/ 状态     │
                     │  per-session │          │     artifacts/    │
                     │  daemon 容器 │          └───────────────────┘
                     └──────┬───────┘
                            │ Docker API（TCP + TLS）
                            ▼
              ╔═══ Agent 专用机（独立机器）════════════╗
              ║  Docker daemon 监听 :2376（TLS 双向认证）║
              ║                                       ║
              ║  ┌─ 用户 A 容器 (:32001) ──┐          ║
              ║  │ OD daemon (Node.js)     │          ║
              ║  │ .od/ ← restore from OSS │          ║
              ║  │ opencode → 大模型        │          ║
              ║  │ idle 超时 → save → 销毁  │          ║
              ║  └─────────────────────────┘          ║
              ║  ┌─ 用户 B 容器 (:32002) ──┐          ║
              ║  │ ...同上...               │          ║
              ║  └─────────────────────────┘          ║
              ╚═══════════════════════════════════════╝
```

## 3.2 双模式容器

### 会话容器（per-session）—— 给 Web UI 用户

用户打开浏览器开始使用时，控制面给他分配一个 daemon 容器。这个容器在用户活跃期间**常驻**，直到空闲超时才回收。

**生命周期**：

```
用户打开页面
  → 控制面检查：该用户有活跃容器吗？
    → 有 → 直接代理到那个容器
    → 没有 → 创建新容器：
        ① 从 OSS 下载该用户的 .od/ 到容器内（restore）
        ② 启动 daemon（绑 0.0.0.0，带 OD_API_TOKEN）
        ③ 等 /api/health 就绪
        ④ 注册到会话映射表（user → container address）
  → 容器就绪，后续所有 API 请求透明代理过去

用户使用中（多轮对话、预览、编辑...）
  → 每个请求重置 idle 计时器
  → 定期（如每 5 分钟）做一次增量 save 到 OSS（防崩溃丢数据）

用户空闲超时（如 30 分钟无请求）
  → 控制面触发优雅关闭：
        ① SIGTERM → daemon → db.close() 刷 WAL（预写日志，见 3.6）
        ② 等 daemon 进程退出
        ③ 最终 save .od/ 到 OSS
        ④ 销毁容器，从会话映射表移除

用户回来
  → 同"用户打开页面"，新容器 + restore → 无缝接续
```

**好处**：用户在使用期间无冷启动延迟，体验和本地版几乎一样。
**代价**：有空闲成本（容器闲着也占资源）；需要 idle 超时机制。

### 单轮容器（per-turn）—— 给 API/MCP 调用

通过 API Key 调用的 agent 请求（如 MCP 工具调用、OpenAPI 调用），每个请求起一个容器、跑完即毁。

**生命周期**：

```
API 请求到达（带 API Key）
  → 控制面鉴权 → 扣费（预扣）
  → 创建容器 → restore .od/ → 起 daemon → 跑一轮 → save .od/ → 销毁
  → 返回结果 → 确认扣费
```

和 v1 方案的 per-turn 模型一致，适合无状态、短命的场景。

### 两种模式共存

| 维度 | 会话容器（per-session） | 单轮容器（per-turn） |
|---|---|---|
| 触发方式 | 用户通过 Web UI 使用 | 通过 API Key 发 API/MCP 请求 |
| 生命周期 | 用户在线期间常驻 | 一个请求一个容器 |
| 冷启动 | 只在首次和超时后 | 每次请求都有 |
| 适用场景 | 交互式设计（需要即时响应） | 自动化/agent 调用（容忍延迟） |
| 状态 | 容器内 .od/ 是热的 | 每次从 OSS 恢复 |

## 3.3 Go 控制面设计

Go 控制面基于百智云模板扩展，是整个 SaaS 的中枢。它做三类事：

### a. 百智云平台 API（模板已有，按需扩展）

| 路由前缀 | 鉴权方式 | 功能 |
|---|---|---|
| `/api/v1/me` | 网关 header | 当前用户信息 |
| `/api/v1/api-keys` | 网关 header | API Key 管理 |
| `/api/v1/wallet/*` | 网关 header | 钱包余额/账单 |
| `/api/v1/byok` | 网关 header | **新增**：Agent LLM 凭证管理（增删改查用户的 baseUrl/apiKey） |
| `/api/v1/media-keys` | 网关 header | **新增**：Media Provider 凭证管理（图片/视频/音频生成 key） |
| `/api/v1/sessions` | 网关 header | **新增**：用户会话/容器状态查询 |
| `/api/admin/*` | 网关（运营管理鉴权） | 运营后台：用户管理、用量统计 |
| `/openapi/v1/*` | API Key | OpenAPI 接口 |
| `/mcp` | API Key | MCP 工具入口 |

### b. OD 代理 API（新建）

| 路由前缀 | 功能 |
|---|---|
| `/api/od/*` | 透明代理到用户的 daemon 容器。控制面从请求中提取用户身份 → 查会话映射 → 找到容器地址 → `httputil.ReverseProxy` 转发请求，包括 SSE 流式响应 |
| `/api/od/artifacts/*` | 制品文件。优先从 OSS 读（容器可能已销毁），fallback 到容器内 daemon |

**代理的核心逻辑**：

```go
func (p *ODProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
    user := auth.UserFromContext(r.Context())

    // 1. 查用户的活跃容器
    container, err := p.sessions.GetOrCreate(user.ID)
    if err != nil {
        // 容器创建失败 → 返回 503
    }

    // 2. 重置 idle 计时器
    p.sessions.Touch(user.ID)

    // 3. 透明代理（包括 SSE 流式）
    proxy := httputil.NewSingleHostReverseProxy(container.URL)
    proxy.FlushInterval = -1 // 立即 flush，保证 SSE 不被缓冲
    proxy.ServeHTTP(w, r)
}
```

### c. 容器生命周期管理（新建）

```go
type SessionManager struct {
    sessions map[string]*Session     // user ID → session
    mu       sync.RWMutex
    oss      *service.OSSService
}

type Session struct {
    UserID      string
    ContainerID string
    DaemonURL   string           // 如 http://<agent-host>:32001
    HostPort    int              // 宿主机映射端口
    CreatedAt   time.Time
    LastActive  time.Time
}
```

SessionManager 负责：
- **创建容器**：通过 Docker API（TCP + TLS）连接 agent 专用机 → `docker create` + `docker start` → 注入环境变量（`OD_API_TOKEN`、`OD_DATA_DIR`、用户的 BYOK 配置）→ restore `.od/` from OSS → 等健康检查通过
- **销毁容器**：`docker stop`（发 SIGTERM，daemon 优雅关闭刷 WAL）→ save `.od/` to OSS → `docker rm`
- **idle 监控**：后台 goroutine 定期扫描 `LastActive`，超时的执行销毁
- **定期保存**：后台 goroutine 定期对活跃容器做 `.od/` 快照到 OSS（崩溃兜底）

## 3.4 前端策略（低入侵）

### 核心思路：SaaS 外壳 + OD Web iframe

```
┌─────────────────────────────────────────────────────┐
│  SaaS 前端外壳（React/Vite，百智云模板）              │
│  ┌─────────────────────────────────────────────┐    │
│  │  顶栏：用户名 · 控制台 · 退出登录             │    │
│  ├─────────────────────────────────────────────┤    │
│  │                                             │    │
│  │  iframe: 完整的原生 OD Web                   │    │
│  │  （源码一行不改，通过 nginx 路径改写           │    │
│  │   让它以为自己在和 daemon 直连）               │    │
│  │                                             │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  /console/*: 控制台页面（BYOK、密钥、用量、运营后台） │
│  /admin/*:   运营后台                                │
└─────────────────────────────────────────────────────┘
```

**OD Web 源码零改动**。它仍然调 `/api/*`，以为自己在和 daemon 直连。实际上 nginx 做了路径改写：

```nginx
# OD Web 发出的请求                     # nginx 改写后送去
/api/health                     →   Go 控制面 → 代理到用户的 daemon 容器
/api/runs                       →   Go 控制面 → 代理到用户的 daemon 容器
/api/runs/:id/events (SSE)      →   Go 控制面 → 代理到用户的 daemon 容器
/artifacts/*                    →   Go 控制面 → 代理到容器 或 OSS
```

Go 控制面收到这些请求后，根据百智云网关注入的 `X-Baizhiyun-User-Id` header 找到该用户的 daemon 容器，透明代理过去。OD Web 完全不知道中间有一层代理。

### OD Web 需要的改动：无

| 过去方案要改的点 | 低入侵替代 |
|---|---|
| API 基地址 | nginx 路径改写，OD Web 不动 |
| 用户上下文 | SaaS 外壳顶栏显示，iframe 里的 OD Web 不需要知道 |
| BYOK 设置页 | 做在 SaaS 控制台页面（`/console/byok`），容器创建时控制面注入环境变量 |
| 去掉 desktop | 不去掉，SaaS 模式下不触发 |
| 导航入口 | SaaS 外壳顶栏有"控制台"链接 |

### 路由总览

| 路径 | 去向 | 说明 |
|---|---|---|
| `/` | SaaS 前端外壳 | 显示顶栏 + iframe 加载 OD Web |
| `/od/*` | OD Web 容器（Next.js） | iframe 内的 OD 页面 |
| `/api/*` | Go 控制面 → daemon 容器 | OD Web 的 API 请求，透明代理 |
| `/artifacts/*` | Go 控制面 → daemon / OSS | 制品文件 |
| `/console/*` | SaaS 前端外壳 | 控制台页面（BYOK、密钥、用量等） |
| `/admin/*` | SaaS 前端外壳 | 运营后台 |
| `/api/v1/*` | Go 控制面 | 百智云平台 API（用户、密钥、钱包等） |
| `/openapi/v1/*` | Go 控制面 | OpenAPI（API Key 鉴权） |
| `/mcp` | Go 控制面 | MCP 入口（API Key 鉴权） |

## 3.5 状态管理（OSS）

### 存储布局

```
MinIO bucket: <platform-bucket>
└── open-design/                          # oss.directory 前缀
    └── users/
        └── <user_id>/
            └── sessions/
                └── <conversation_id>/
                    ├── od/                # .od/ 的完整镜像
                    │   ├── app.sqlite     # SQLite 主库（WAL 已合并）
                    │   └── projects/
                    │       └── <project_id>/
                    │           ├── index.html
                    │           └── ...
                    └── artifacts/         # 独立制品（供预览 URL 访问）
                        ├── <hash>.html
                        └── ...
```

### restore（恢复）流程

```
容器启动时：
  ① 控制面调 OSSService.GetObject()，下载该用户/会话的 .od/ 快照
  ② 解压到容器的 $OD_DATA_DIR（默认 /data）
  ③ 如果是新用户/新会话 → 空目录，daemon 启动时自动初始化
```

### save（保存）流程

```
容器关闭前（最关键的步骤——参见 3.6 收尾屏障）：
  ① 优雅关闭 daemon → SIGTERM → db.close() → WAL 合并进主库
  ② 等 daemon 进程退出
  ③ 打包 $OD_DATA_DIR 上传到 OSS（PutObject）
  ④ 制品 HTML 单独上传到 artifacts/ 路径（供预览 URL 使用）
```

### 定期保存（崩溃兜底）

活跃容器每 5 分钟做一次增量快照。需要注意：**定期 save 时 daemon 还在跑，不能直接拷 SQLite 主库**（WAL 可能有未合并的数据）。解决办法：

- 用 SQLite 的 `VACUUM INTO` 或 `.backup` 命令做热备（hot backup），产出一个完整的、不依赖 WAL 的副本
- 上传这个副本到 OSS
- 这样即使容器崩溃，最多丢 5 分钟数据

## 3.6 收尾屏障（本方案最易翻车的点）

> 和 v1 完全一致，这是架构约束不会因百智云集成而改变。

两个已核实的风险：

- **风险一：WAL（Write-Ahead Log，预写日志）没刷盘**。SQLite 开了 WAL 模式（`db.ts:39`），写入先进旁路文件 `app.sqlite-wal`，要 checkpoint（检查点合并）才进主库。若 save 时只拷主库，**这一整轮很可能全丢失**。
- **风险二：收尾落库是异步的，有竞态（race condition，两个操作抢着跑导致时序混乱）**。`--follow` 看到 `end` 事件就返回，但 daemon 那边收尾更新是异步的。

**正确的收尾流程**：

```
1. 检测到该关闭（idle 超时 / 主动关闭 / per-turn 跑完）
2. 如果是 per-turn：轮询 GET /api/runs/:id 直到终态        ← 堵竞态
3. 优雅关闭 daemon → SIGTERM → db.close() 刷 WAL           ← 刷盘
4. 等 daemon 进程真正退出
5. 此时 .od/app.sqlite 主库已含全部数据 → save 到 OSS
6. 销毁容器
```

## 3.7 API 代理与流式

### 代理层

Go 控制面用 `httputil.ReverseProxy` 做透明代理。OD Web 仍然调 `/api/runs`，nginx 把请求转到 Go 控制面，控制面再转发到 daemon 容器的 `/api/runs`——**OD Web 完全不知道中间有代理层**。

关键点：

- **SSE 流式**：设置 `FlushInterval = -1`（立即刷新），保证 SSE 事件逐个到达浏览器，不被 proxy 缓冲。
- **超时**：代理层的 HTTP 超时要足够长（至少 10 分钟），因为一轮 AI 生成可能跑几分钟。
- **连接保持**：SSE 是长连接（long-lived HTTP），代理层不能提前关。

### 制品访问

制品（生成的 HTML 文件等）有两个访问路径：

1. **容器在线时**：代理到 daemon 的 `/artifacts/*` 静态路由。
2. **容器已销毁后**：从 OSS 生成预签名 URL（presigned URL，有效期短的临时下载链接），前端 iframe 直接加载。

控制面自动选路：有活跃容器用路径 1，否则用路径 2。

## 3.8 BYOK 凭证管理

用户需要配两类 key，都在 SaaS 控制台统一管理：

### a. Agent LLM 凭证——驱动代码生成的大模型

```
用户在 /console/byok 填：baseUrl + apiKey + 模型名（如 DeepSeek）
      │  POST /api/v1/byok（控制面保存到 PostgreSQL，AES 加密存储）
      ▼
控制面 DB（每用户一份，与会话解耦，可多会话复用）
      │  创建/唤醒容器时，作为环境变量注入
      ▼
容器内 daemon 拼装 OPENCODE_CONFIG_CONTENT：
   { provider:{ byok:{ options:{ baseURL, apiKey } } }, model:"byok/<model>" }
      ▼
opencode 用用户自己的额度调模型 → 生成 HTML/CSS/JS 代码
```

### b. Media Provider 凭证——驱动图片/视频/音频生成

OD 的 media 系统（`media-config.ts`）支持十几个图片/视频/音频生成 provider，每个有独立的 API key。当 agent 在设计稿里需要**真实图片**（不是占位符），会调 `od media generate`，此时需要对应 provider 的 key。

```
用户在 /console/media-keys 选 provider + 填 apiKey（可选 baseUrl）
      │  POST /api/v1/media-keys（控制面保存到 PostgreSQL，AES 加密存储）
      ▼
控制面 DB
      │  创建/唤醒容器时，按 provider 注入对应环境变量
      ▼
容器内 daemon 通过 media-config.ts 的 ENV_KEYS 读到 key：
   OD_OPENAI_API_KEY=xxx     → openai provider（DALL-E / gpt-image）
   OD_FAL_KEY=xxx            → fal provider（Flux 等开源图片模型托管）
   XAI_API_KEY=xxx           → grok provider（xAI 的图片生成）
   OD_VOLCENGINE_API_KEY=xxx → volcengine provider（豆包 Seedream 图片生成）
   OD_GOOGLE_API_KEY=xxx     → google provider（Gemini 图片）
   ...等十几个 provider
      ▼
od media generate 用用户自己的 key 调图片 API → 生成真实图片嵌入设计稿
```

**支持的 media provider 一览**（daemon `media-config.ts:71-108`）：

| Provider | 能力 | 环境变量 |
|---|---|---|
| openai | 图片（DALL-E / gpt-image）+ 语音（TTS） | `OD_OPENAI_API_KEY` |
| fal | 图片（Flux 等开源模型） | `OD_FAL_KEY` |
| grok | 图片 + 视频（xAI Imagine） | `OD_GROK_API_KEY` / `XAI_API_KEY` |
| volcengine | 图片（Seedream）+ 视频（Seedance） | `OD_VOLCENGINE_API_KEY` |
| google | 图片（Gemini） | `OD_GOOGLE_API_KEY` |
| bfl | 图片（Flux 官方 Black Forest Labs） | `OD_BFL_API_KEY` |
| replicate | 图片/视频（社区模型托管） | `OD_REPLICATE_API_TOKEN` |
| elevenlabs | 语音（高质量 TTS） | `OD_ELEVENLABS_API_KEY` |
| ... | 还有 midjourney、minimax、suno 等 | 见源码 |

**安全要求**（LLM 和 media key 统一）：
- 保存 baseUrl 时做 SSRF（Server-Side Request Forgery，服务端请求伪造——攻击者让服务器去请求内网地址）校验，拦内网网段、link-local、云元数据地址（169.254.169.254）。
- apiKey **加密存储**（AES-256），日志里脱敏。
- 注入容器时用环境变量，不写镜像、不写 OSS。

## 3.9 计费设计

### 扣费节点

| 事件 | 扣费动作 | 说明 |
|---|---|---|
| 用户发起一轮 run | 预扣费（freeze） | 按模型/预估 token 预扣 |
| run 完成（succeeded） | 确认扣费（confirm） | 按实际 token 用量结算 |
| run 失败（failed/error） | 回滚扣费（rollback） | 退回预扣的积分 |
| 会话容器活跃中 | 按时计费（可选） | 容器占用资源的基础费 |

### 数据流

```
控制面收到 /api/od/runs 请求
  → walletService.Freeze(userId, estimatedQuota)        # 预扣
  → 代理到 daemon 容器
  → 轮询/监听 run 结果
  → 成功 → walletService.Confirm(bizId, actualQuota)    # 实际扣
  → 失败 → walletService.Rollback(bizId)                # 退回
```

### 调用日志

每次 run 创建一条调用日志（`call_records` 表），记录：
- user_id、team_id、来源（web / api / mcp）
- 状态（processing → completed / failed）
- 耗时、消耗额度、模型名、失败原因
- wallet biz_id（用于和钱包流水对账）

## 3.10 MCP 接入

百智云要求应用暴露 MCP 入口，供外部 agent 调用。Open Design 的 MCP 面：

```
/mcp（API Key 鉴权）
  ├── list_templates         # 列出可用的设计模板
  ├── generate_design        # 从 brief 生成设计稿
  └── refine_design          # 基于已有 HTML 迭代修改
```

实现方式：Go 控制面的 MCP handler 收到请求后，起一个 per-turn 容器执行，结果返回给 agent。

## 3.11 安全

| 层面 | 措施 |
|---|---|
| 容器间隔离 | Docker 默认桥接网络，每容器独立网络命名空间；容器间不可互通（`--network=none` 或自定义隔离网络） |
| agent 机器访问控制 | Docker API 仅通过 TLS 双向认证暴露（`--tlsverify`），Go 控制面持客户端证书；机器防火墙只开 2376（Docker API）+ 32000-33000（容器端口段） |
| 出口流量（egress） | iptables 拦内网段、拦云元数据地址；只允许用户配置的 baseUrl 出去 |
| 资源配额 | 每容器限 CPU / 内存 / 磁盘（`--cpus`、`--memory`、`--storage-opt`）/ 最长运行时长 |
| BYOK 凭证 | AES 加密存储，注入用环境变量，绝不进日志 / 镜像 / OSS |
| SSRF 防护 | baseUrl 校验拦截内网、link-local、元数据地址 |
| 制品沙箱 | iframe sandbox 属性隔离，预签名 URL 短有效期 |

---

# 第四部分：工程落地

## 4.1 对 OD 代码的改动：零

低入侵原则下，**OD 仓库不做任何改动**。SaaS 所需的所有适配全部在 SaaS 仓库内完成：

| 过去方案的改动 | 低入侵替代方案 | OD 代码变化 |
|---|---|---|
| BYOK merge | 已实现，推进合入 OD 上游作为正式功能 | **上游 PR**，不是 SaaS patch |
| OD Web API 基地址 | nginx 路径改写 | **无** |
| OD Web 导航入口 | SaaS 外壳顶栏 | **无** |
| OD Web BYOK 设置页 | SaaS 控制台独立页面 | **无** |
| OD Web 去掉 desktop | 不去掉，SaaS 模式下不触发 | **无** |
| daemon 容器镜像 | SaaS 仓库的 Dockerfile 构建 OD 原码 | **无** |
| `OD_ENABLED_AGENTS` 白名单 | 容器环境变量注入（如 OD 支持），否则不做 | **无** |

**升级 OD 的流程**：
```
1. 在 SaaS 仓库的 Dockerfile 里改 OD 版本号（git tag 或 commit hash）
2. 重建 daemon 镜像 + od-web 镜像
3. 部署
4. 完毕——不需要改代码、不需要合并、不需要 resolve conflict
```

## 4.2 Go 控制面新建内容

| 模块 | 说明 | 工作量 |
|---|---|---|
| `internal/session/` | 容器生命周期管理（SessionManager） | 中 |
| `internal/proxy/` | OD API 透明代理（含 SSE 流式） | 中 |
| `internal/state/` | .od/ 状态的 OSS 存取（restore/save） | 中 |
| `internal/handler/byok_handler.go` | Agent LLM 凭证 CRUD | 小 |
| `internal/handler/media_key_handler.go` | Media Provider 凭证 CRUD | 小 |
| `internal/handler/od_proxy_handler.go` | 代理入口 + 计费钩子 | 中 |
| `internal/service/billing_service.go` | 扣费（预扣/确认/回滚） | 小 |
| `internal/service/call_record_service.go` | 调用日志 | 小 |
| `internal/migration/` | 新表：byok_configs、media_keys、call_records、sessions | 小 |
| `internal/mcpserver/` | MCP 工具实现（调 per-turn 容器） | 中 |

## 4.3 前端新建/改动

| 内容 | 位置 | 说明 |
|---|---|---|
| SaaS 外壳前端 | `frontend/`（从模板复制 + 新页面） | 顶栏 + iframe 嵌入 OD Web + 控制台页面 |
| 控制台页面 | `frontend/src/pages/console/` | 密钥管理、Agent LLM 配置、Media Provider 配置、用量统计 |
| 运营后台页面 | `frontend/src/pages/admin/` | 用户管理（复用模板） |
| OD Web 适配 | **无** | OD Web 原封不动运行在 iframe 中 |

## 4.4 部署架构（Helm）

```yaml
# 三个 Deployment + 一个 Job
Deployments:
  - od-web              # OD Web 前端（Next.js 容器）
  - backend             # Go 控制面
  - frontend            # 控制台前端（React/Vite + nginx）

Jobs:
  - migrate             # 数据库迁移

# daemon 容器不在 Helm 里
# 由 Go 控制面通过 Docker API 远程调度到 agent 专用机
```

## 4.5 新增数据表

```sql
-- 用户的 Agent LLM 配置（驱动代码生成的大模型）
CREATE TABLE byok_configs (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    team_id       TEXT NOT NULL DEFAULT '',
    name          TEXT NOT NULL,            -- 如 "我的 DeepSeek"
    base_url      TEXT NOT NULL,            -- 如 https://api.deepseek.com
    api_key_enc   TEXT NOT NULL,            -- AES 加密后的 apiKey
    model         TEXT NOT NULL,            -- 如 deepseek-v4-pro
    provider_id   TEXT NOT NULL,            -- 如 deepseek
    is_default    BOOLEAN DEFAULT false,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- 用户的 Media Provider 凭证（图片/视频/音频生成）
CREATE TABLE media_keys (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    team_id       TEXT NOT NULL DEFAULT '',
    provider_id   TEXT NOT NULL,            -- 如 openai / fal / grok / volcengine
    api_key_enc   TEXT NOT NULL,            -- AES 加密后的 apiKey
    base_url      TEXT DEFAULT '',          -- 可选自定义端点
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    updated_at    TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, provider_id)            -- 每用户每 provider 一份
);

-- 调用日志
CREATE TABLE call_records (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    team_id       TEXT NOT NULL DEFAULT '',
    source        TEXT NOT NULL,            -- web / api / mcp
    run_id        TEXT,                     -- OD daemon 的 run ID
    conversation_id TEXT,
    model         TEXT,
    status        TEXT NOT NULL DEFAULT 'processing',  -- processing / completed / failed
    quota_used    BIGINT DEFAULT 0,         -- 消耗额度
    wallet_biz_id TEXT,                     -- 钱包流水 ID，用于对账
    duration_ms   BIGINT,
    error_message TEXT,                     -- 面向前台的安全错误信息
    error_detail  TEXT,                     -- 原始错误，仅运营后台可见
    started_at    TIMESTAMPTZ DEFAULT NOW(),
    finished_at   TIMESTAMPTZ
);

-- 活跃会话（容器映射）
CREATE TABLE active_sessions (
    user_id       TEXT PRIMARY KEY,
    container_id  TEXT NOT NULL,
    daemon_url    TEXT NOT NULL,
    conversation_id TEXT,
    created_at    TIMESTAMPTZ DEFAULT NOW(),
    last_active   TIMESTAMPTZ DEFAULT NOW()
);
```

## 4.6 分阶段路线图

### Phase 0 — 核心链路验证（当前阶段）✅ 部分完成

- ✅ daemon 容器镜像构建 + BYOK 注入打通
- ✅ per-turn 模式单轮生成成功
- ⬜ **多轮接力验证**：第 1 轮生成 → 手动 save → 第 2 轮 restore → 验证历史连续
- ⬜ 把 BYOK 改动烧入镜像（当前 bind-mount 验证）

### Phase 1 — 最小可用 SaaS

- Go 控制面骨架（百智云模板 + 容器调度 + API 代理）
- OD Web 适配（API 路径 + 用户上下文）
- 状态管理（OSS restore/save）
- per-session 容器（Web UI 用户）
- 百智云鉴权 + 基础计费
- Helm 部署到 dev 环境
- **交付标准**：用户可以注册、登录、用自己的 key 生成设计稿、多轮迭代、预览制品

### Phase 2 — 体验补全

- SSE 流式代理优化（逐字蹦出）
- 制品 CDN + 预签名 URL
- MCP 接入（3 个工具）
- 控制台页面完善（用量统计、调用日志、运营后台大屏）
- idle 超时调优 + 定期保存
- 镜像瘦身

### Phase 3 — 规模与成本

- 容器暖池（warm pool，预热待命容器，省冷启动）
- 按用量精细计费（按 token / 按时长）
- .od/ 增量同步（只搬变化的文件，不搬全量）
- 多副本 Go 控制面 + 会话映射外置到 Redis
- prod 环境上线

## 4.7 待决策点

1. ~~**容器运行时**~~ → **已决策：Docker 远端机器**。agent 容器跑在独立 Docker 机器上，Go 控制面通过 Docker API（TCP + TLS）远程调度。
2. **idle 超时时长**：30 分钟？15 分钟？更短？影响成本和用户体验。
3. **BYOK 范围**：只支持 OpenAI 兼容端点，还是也要 Anthropic / Gemini 原生协议？
4. **OD Web 部署方式**：Next.js SSR 容器（功能完整但重）还是静态导出 + nginx（轻但可能丢 SSR 功能）？
5. **多租户隔离粒度**：每用户一个 .od/，还是每用户每项目一个？影响 OSS 存储布局和 restore 速度。
6. **定期保存间隔**：5 分钟？2 分钟？更频繁 = 丢数据更少，但 OSS 写入和 SQLite 热备的开销更大。
7. **agent 机器容量规划**：单台机器能跑多少并发容器？daemon 常驻内存约 200-400MB，需要按机器内存/CPU 规划上限。
8. **agent 机器扩容**：第一阶段单机；如果用户量超出单机容量，需要 Go 控制面做多机分配（按负载选机器）。

---

# 附录 A：关键技术事实（代码证据）

| 事实 | 证据位置 | 对方案的意义 |
|---|---|---|
| 一次 run 异步，202 + runId，SSE 推进度 | `server.ts:14203`、`runs.ts` 全局 Map | 代理层需要支持 SSE 透传 |
| od CLI 是瘦客户端，必须连在跑的 daemon | `cli.ts`、`daemon-url.ts:32` | 容器内需私有一次性 daemon |
| **opencode 非 resume**，每轮失忆 | `server.ts:11656` 判定 | **无状态容器的地基**：记忆全在 `.od/` |
| daemon 从 SQLite 重灌完整历史喂 opencode | `composeChatUserRequestForAgent` | 只需持久化 `.od/` 即可接续对话 |
| BYOK 注入管道现成 | `OPENCODE_CONFIG_CONTENT` + `mergeOpenCodeProviderConfig` | 加 provider 块即可 |
| 数据可整体搬迁 | `OD_DATA_DIR` 环境变量 | 状态持久化的抓手 |
| 鉴权骨架已有 | `OD_API_TOKEN`，绑非回环强制 | 每容器注入 token |
| 制品在浏览器 iframe 渲染 | `apps/web` file-viewer | 云端不画图，产物外置即可预览 |
| **SQLite 是 WAL 模式** | `db.ts:39` | save 前必须 flush |
| **run 收尾落库是异步的** | `server.ts:2574` | per-turn 需轮询确认 |
| daemon 优雅关闭会 flush WAL | `db.ts:49` `dbInstance.close()` | 收尾屏障的现成抓手 |

---

# 附录 B：百智云模板对照表

| 模板组件 | 我们的用法 |
|---|---|
| `backend/` Go/Gin | Go 控制面主体，扩展容器调度 + API 代理 + 状态管理 |
| `frontend/` React/Vite | SaaS 外壳（顶栏 + iframe 嵌入 OD Web）+ 控制台页面 |
| `GatewayAuth` middleware | 直接复用，读 `X-Baizhiyun-User-Id` 等 header |
| `APIKeyAuth` middleware | 直接复用，API Key 鉴权（OpenAPI + MCP） |
| `WalletService` | 直接复用，扣费/回滚 |
| `OSSService` | 直接复用，.od/ 状态存取 + 制品存储 |
| `AuditRepository` | 直接复用，操作审计 |
| `StatsReporter` | 直接复用，App Stats 上报 |
| `MCPServer` | 扩展，加 3 个 design 工具 |
| Helm Chart | 扩展，加 od-web Deployment + daemon 镜像引用 |
| `.gitlab-ci.yml` | 扩展，加 od-web 镜像构建 + daemon 镜像构建 |

---

*本文档基于对 open-design 仓库和百智云 template 仓库的代码调研撰写；标注的行号为撰写时的位置，实施时以最新代码为准。*
