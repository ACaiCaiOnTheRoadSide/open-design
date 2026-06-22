# Open Design 多租户 Fork — 交付说明

> 路径:`/Users/caiqj/project/company/baizhiyun/open-design-mt`
> 分支:`multitenant`(从 `baizhi-saas` 派生)
> 目标:把上游单租户 daemon 改成多租户,daemon 容器无状态化;**接口全量复刻,不裁剪**。

---

## 1. 验收口径

明天端到端跑通:
- ✅ 浏览器登录 → 进 SaaS 前端 → 进 OD 编辑器
- ✅ 新建项目
- ✅ 发对话(chat / design 两种 session_mode 都要工作)
- ✅ 正确生图(火山 Seedream 4.0,挂在 `/api/projects/:id/media/tasks`)
- ✅ 看到设计产物(`/artifacts`、`/api/projects/:id/files`)
- ✅ 加预览批注(`preview_comments`)

底层不变量:
- 不同租户互相看不到对方的项目/对话/消息/批注/media task。
- 同一租户跨会话保留完整历史。

---

## 2. 这次改了什么

### 2.1 新增文件

**`apps/daemon/src/multitenant.ts`** — 多租户核心模块
- `LEGACY_TENANT = '__legacy__'`:迁移前/非 HTTP 路径的默认租户
- `TENANT_HEADER = 'x-tenant-id'`:接受的 header 名(网关注入)
- `runWithTenant<T>(tenantId, fn): T`:把一个回调跑在指定租户 ALS 域内
- `currentTenantId(): string`:当前调用栈的租户 id
- `tenantMiddleware(req, res, next)`:express 中间件,读 `X-Tenant-Id`,套 ALS,跑后续路由
- `migrateTenantId(db)`:additive ALTER TABLE,给 21 张业务表加 `tenant_id TEXT NOT NULL DEFAULT '__legacy__'` + 复合索引

### 2.2 改的现有文件

| 文件 | 改动 |
|---|---|
| `apps/daemon/src/db.ts` | import `migrateTenantId/currentTenantId`;`migrate()` 末尾调 `migrateTenantId(db)`;改造 6 块函数(见 §2.3) |
| `apps/daemon/src/media-tasks.ts` | import `currentTenantId`;改造 7 个 CRUD 函数 |
| `apps/daemon/src/server.ts` | import `tenantMiddleware`;在 `installRouteRegistrationGuard` 之后、所有路由之前 `app.use(tenantMiddleware)` |
| `backend/internal/proxy/proxy.go`(在 saas repo) | Director 里注入 `X-Tenant-Id`,优先 `user.TeamID`,空则 `user.ID` |
| `.env`(在 saas repo) | 加 `OD_SOURCE_DIR=../open-design-mt` 把镜像构建切到 fork |

### 2.3 改造覆盖的 db 函数(共约 30 个)

**Projects 表**(5):
`listProjects` / `getProject` / `insertProject` / `updateProject` / `deleteProject`

**Conversations 表**(5):
`listConversations` / `getConversation` / `insertConversation` / `updateConversation` / `deleteConversation`

**Agent sessions 表**(5):
`getAgentSession` / `upsertAgentSession` / `getAgentSessionRecord` / `updateAgentSessionStableHash` / `clearAgentSession`

**Messages 表**(6):
`listMessages` / `upsertMessage` / `getMessageTelemetryFinalizationState` / `appendMessageStatusEvent` / `appendMessageAgentEvent` / `deleteMessage`

**Preview comments 表**(5 含 internal helper):
`listPreviewComments` / `upsertPreviewComment` / `updatePreviewCommentStatus` / `deletePreviewComment` / `getPreviewComment`

**Media tasks 表**(7):
`insertMediaTask` / `getMediaTask` / `updateMediaTask` / `listMediaTasksByProject` / `listRecentMediaTasks` / `deleteMediaTask` /(`reconcileMediaTasksOnBoot` 保留全租户范围,启动时一次性整理)

**改造模式(标准化)**:
```ts
export function getX(db, id) {
  const tenantId = currentTenantId();
  return db.prepare(`SELECT ... WHERE id = ? AND tenant_id = ?`).get(id, tenantId);
}

export function insertX(db, x) {
  const tenantId = currentTenantId();
  db.prepare(`INSERT INTO x (..., tenant_id) VALUES (..., ?)`).run(..., tenantId);
}
```

---

## 3. 设计取舍

### 3.1 用 AsyncLocalStorage 而不是改函数签名

- 95+ 个 db.* 调用点散落在 `server.ts` / `project-routes.ts` / `media-routes.ts` 等
- 改签名 = 95 处机械修改,易漏、易冲突、未来跟上游 merge 也痛
- ALS 把 tenant id 当"环境变量"传播,调用站点零改动
- **副作用**:在 ALS scope 外调用 db 函数会得到 `LEGACY_TENANT`,因此 cron / watchers / 启动任务 看到的是旧数据。**这是有意的**——为了平滑迁移和"复刻所有接口"。

### 3.2 用 SQLite + tenant_id,**不**马上换 PG

- 用户原始诉求:多租户 + 无状态 daemon
- 多租户:✅ 已就位(tenant_id 列 + 中间件 + filter)
- 无状态:🟡 部分——SQLite 文件在 docker volume 上,容器是 fungible 的(可随时杀掉重建),但**单实例**;真正多副本横向扩还要 P5(PG 化)。
- 收益:少一遍方言翻译 + 多个 ORM 迁移文件,demo 风险显著降低
- 代价:不能多副本同时写。**今晚 demo 单副本够用。**

### 3.3 文件存储继续用本地盘

- `PROJECTS_DIR = RUNTIME_DATA_DIR/projects/<projectId>/...`(保留不动)
- `FileStore` 接口的抽象 + S3 切换是后续工作
- 单租户的项目目录隔离已经够安全(projectId 是 random uuid + 路由层 tenant filter 兜底)

### 3.4 共享单 daemon 模式(SaaS 侧,默认关)

SaaS 仓 `backend/internal/session/manager.go` 加了 `SharedDaemon` 开关(`SESSION_SHARED_DAEMON=true` 启用):
- **关(默认)**:每用户一个常驻容器(现状不变)。多租户 daemon 在这种模式下仍正确——每个容器收到自己用户的 `X-Tenant-Id`,DB 层按 tenant 隔离;只是没省容器。
- **开**:`containerKey()` 把所有 userID 收敛为常量 `__shared__`,全租户共用一个 daemon 容器,租户隔离全靠 daemon 内的 `X-Tenant-Id`。这才是你最初要的"不要每用户一个容器"。

**开启共享模式前必须解决的一个坑(split agent 模式)**:
- 现在 `AGENT_MODE=split`:opencode 在独立 agent 容器里跑,通过 MCP/HTTP **回调 daemon**(live-artifacts 等工具)。
- 这些回调目前**不带 `X-Tenant-Id`** → daemon 端会落到 `LEGACY_TENANT`,写错租户的数据。
- 单用户容器模式下这个坑不致命(一个容器≈一个租户);**共享模式下必须修**:让 agent 启动时拿到 tenant 上下文(`OD_TENANT_ID` env),回调时带上 header。
- 涉及:`backend/internal/agent/shim.go`(URL/header 改写)+ daemon 的 MCP 回调入口。
- **bundled 模式无此坑**(opencode 在 daemon 进程内,回调走进程内,继承 ALS)。共享模式想快速验证可先切 `AGENT_MODE=bundled`。

### 3.5 Agent 回调的 tenant 还原(tool-token 绑 tenant)★ 已实现

**问题**:open-design 的生图/产物常由 agent 在设计过程中**自主触发**,走 agent→daemon 的 tool 回调(`/api/tools/*`、`/api/projects/:id/media/...` with grant)。这些回调带的是 tool token、**没有 `X-Tenant-Id` header** → 全局 `tenantMiddleware` 把它们落到 `LEGACY_TENANT` → 生成的 media task / 消息租户错配 → 浏览器按真 tenant 查**看不到生图结果**。

**解法**(tenant 绑在 tool token 上,daemon 内自洽,不依赖 agent 改造):
- `tool-tokens.ts`:`ToolTokenGrant` / `MintToolTokenOptions` 加 `tenantId`;`mint()` 默认捕获 `currentTenantId()`(铸造发生在 `/api/chat` 启动 run 的请求作用域内,此时 ALS=真 tenant)。
- `multitenant.ts`:加 `enterTenant(tenantId)`,用 `AsyncLocalStorage.enterWith()` **就地**把当前请求的 ALS 重置到指定 tenant(无需包裹回调)。
- `server.ts`:`authorizeToolRequest` / `optionalToolGrantFromRequest` 校验 token 通过后,`enterTenant(grant.tenantId)` 还原 run 的 tenant,后续 tenant-scoped 写入(media_tasks/messages)落对租户。

**覆盖范围**:所有走统一 token 校验入口的 agent 回调。媒体生成 `handleGenerate` 在请求作用域内 `createMediaTask` → ALS 已被还原 → media task 落对租户。✓

**仍依赖的假设**:`mint()` 在请求作用域内调用(currentTenantId() 此刻=真 tenant)。若未来把 run 启动挪到启动期常驻 worker,需改为在 run 创建时显式捕获 tenant 存到 run、mint 时传 `tenantId: run.tenantId`。

---

## 4. 后续 TODO(按优先级)

### P2 — PG 迁移 ✅ 核心路径功能性完成(2026-06,同步适配器路线)

**最终选了同步适配器,不是 5 天异步重写**——daemon 本就是同步 DB(better-sqlite3 同步阻塞),做个接口兼容的同步 PG 适配器,`db.ts` + 172 handler **零逻辑改动**:
- `src/storage/pg-sync-worker.ts` — worker 线程跑异步 `pg`,BIGINT→Number(对齐 SQLite)
- `src/storage/pg-sync.ts` — 主线程 `Atomics.wait` 阻塞等结果;暴露 `prepare/get/all/run/exec/pragma/transaction/close`;`?`→`$N`;数组参解包;**驼峰标识符自动加引号**(PG 折叠小写坑);30s 超时
- `db.ts` — `openDatabase()` 加 `OD_DAEMON_DB=postgres` 分支 + 同步迁移 runner;3 处方言修复(`terminalRunDurationSql` 的 json_extract→PG 算术、`rowid`→`id`、`INSERT OR IGNORE`→`ON CONFLICT DO NOTHING`)
- SaaS `manager.go` — spawn daemon 时按 `DaemonDBMode=postgres` 注入 `OD_DAEMON_DB`/`OD_PG_*`;compose 加 `pg-init`(建 od_daemon 库)+ `DAEMON_DB` 开关(默认 sqlite)

**已实测**:起 `OD_DAEMON_DB=postgres` 的 daemon 接 od_daemon 库,项目/对话/消息/评论全部持久化到 **Postgres**,驼峰字段(createdAt 等)正确返回,最复杂的 listConversations CTE 查询工作,跨租户隔离生效,零报错。`psql` 直查确认数据落 PG。

**代价(诚实)**:适配器**串行化查询**(一次一个、阻塞事件循环等 PG 返回)——单 daemon 进程不吃 PG 进程内并发,靠多副本横向扩。真 async 重写能让单进程并发查询(吞吐更高),但要 5 天;当前规模够用。

**未尽**:真实 LLM 生成链路(chat/run)未端到端跑(走同一 upsertMessage 适配器,应工作);`db-inspect.ts` 的 rowid introspection 在 PG 会报错(非核心);blocking 性能特性需压测确认上限。

---

#### (历史)PG 基础阶段,详见 `apps/daemon/migrations/README.md`:
- ✅ `migrations/0001_init.sql` — 21 表 PG schema(tenant_id + 索引),从运行态 SQLite dump 翻译(INTEGER→BIGINT、REAL→DOUBLE PRECISION、FK 依赖排序)。**已在 Postgres 16 实测应用:21 表 + 67 索引干净 COMMIT;`od_daemon` 库就绪**。
- ✅ `src/storage/pg.ts` — pg Pool 工厂 + 迁移 runner(读 `daemon-db.ts` 的 `OD_DAEMON_DB`/`OD_PG_*` 契约);新文件,未被运行代码引用,不破坏现有 SQLite daemon。

**剩余 = sync→async 代码改造(~5.5 天,分 6 阶段,见 migrations/README.md)**:
- `pnpm add pg @types/pg`(daemon 当前无此依赖)
- 抽 `DataStore` 接口让 sqlite/pg 并存 → 全 call site 加 await(40+ db 函数 + 172 handler)→ 写 pg 实现 + 方言(`?`→`$N`、`json_extract`→`::jsonb->>`、`rowid`→`ctid`)
- 完成后删 backend 的 `sync*.go`(daemon 直连 PG,不再要 SQLite 中间投影,也消灭 CGO 坑)

### P3 — 对象存储抽象

- 抽 `FileStore` 接口:`read(key)` / `write(key, bytes)` / `list(prefix)` / `delete(key)` / `presignedUrl(key)`
- 实现两份:`LocalFileStore`(留 dev 用)+ `S3FileStore`(走 minio/S3)
- key 形式:`tenants/<tenantId>/projects/<projectId>/files/...`
- 改造点:`server.ts` 的 `readProjectFile()` / `listFiles()` / `resolveProjectDir()` 一组函数 + media tools 的写盘路径
- 估工:1–2 天

### P4 — 状态外置(多副本前置)

- live-artifacts SSE 订阅:外置到 Redis pub/sub,允许任意副本接 SSE 流
- 文件 watcher(`chokidar`):重新设计,改成 object-store 事件通知(S3 event/Minio webhook),或干掉本地 watcher 改成轮询
- MCP server 会话:看是不是可重连;不行就 sticky session via k8s service.spec.sessionAffinity
- 估工:不定,先做最小可观测,再切

### P5 — Session manager 单例化

- 当前 `backend/internal/session/manager.go` 仍按 `userID` 起 daemon 容器(每用户一个)
- 改成"全租户共享 1 个 daemon"模式:`GetShared(ctx)` 不带 userID,返回 singleton 容器
- BYOK 注入方式需要重设计:从"启动时 env" 改成"每请求 header"(daemon 端 reader 走 ALS,session 上下文带 tenant 的 BYOK config id)
- 估工:1–2 天

### P6 — RLS 或 lint 兜底

- 加 CI 脚本扫 `db.prepare(...)` 调用,断言但凡命中业务表的 SQL 都至少包含 `tenant_id` 字符串;否则 fail
- 跨表 JOIN 的查询(如 `listLatestProjectRunStatuses`、`listProjectsAwaitingInput`)目前是**全租户范围**——它们不在关键路径,但生产前必须修
- 估工:0.5 天

---

## 5. 验证步骤(明早)

```bash
# 1. 切到 SaaS 仓库
cd /Users/caiqj/project/company/baizhiyun/open-design

# 2. 确认 .env 里 OD_SOURCE_DIR 指向 fork
grep OD_SOURCE_DIR .env
# 期望:OD_SOURCE_DIR=../open-design-mt

# 3. 构建 daemon 镜像(已在后台跑过一次;如失败再来一次)
docker compose --profile build build daemon-image

# 4. 起全栈
docker compose up -d

# 5. 等 backend 健康
curl -fsS http://localhost:8090/healthz

# 6. 进前端
open http://localhost:3000

# 7. 走一遍验收路径
# 7a. 登录 → 新建项目
# 7b. 在编辑器里发一句"画一个 hero section"
# 7c. 等流式响应 → 看 iframe 是否出现产物
# 7d. 在产物上点出批注 → 写一句话 → 保存
# 7e. 触发生图 → 看 media task 进 done

# 8. 多租户隔离自检(可选)
# 用两个不同账号(team A / team B)分别登录,
# 各自建项目,确认彼此看不到对方的列表/对话/产物。

# 9. 看 daemon 日志确认 tenant id 注入正常
docker logs od-saas-backend 2>&1 | grep -i tenant | head -5
```

---

## 6. 失败时排查清单

| 现象 | 大概率原因 | 处理 |
|---|---|---|
| 登录后列表为空,但 daemon 里有数据 | tenant id 不匹配:`X-Tenant-Id` header 没注入 / daemon 中间件没装上 | `docker exec ... env \| grep TENANT`;`docker logs ... \| grep X-Tenant-Id` |
| daemon 启动失败,"no such column: tenant_id" | `migrateTenantId(db)` 没跑;查 `openDatabase` 里是否最后调 `migrate(db)` | 重建 image |
| 生图调用 500 | `media_tasks` 表 INSERT 缺 `tenant_id` 字段 / 老 schema 未触发 migration | 删 sqlite 文件让重建,或手动 `ALTER TABLE` |
| 批注列表空 | `preview_comments` 的 UNIQUE 冲突里没加 `tenant_id`,跨租户撞 key | 看本文 §2.3 的 upsertPreviewComment 实现是否带了 tenant 列 |
| 看不到产物 | 文件路径未携带 tenant 隔离 / iframe 走 `/artifacts` 但 daemon 容器内没数据 | `docker exec ... ls /data/projects` 看落盘情况 |

---

## 7. 重要边界

**Phase 2 已补完租户过滤的表**(2026-06,生产前要求):
- ✅ `templates`(原 `listTemplates(db)` 全局裸查 = 真串号,已修)
- ✅ `routines`(原 `listRoutines(db)` 全局裸查 = 真串号,已修 CRUD)
- ✅ `deployments`(纵深防御,原已按 project 键 + 路由 project gate)
- ✅ `tabs` / `tabs_state`(纵深防御,UI 状态)
- ✅ `listLatestProjectRunStatuses` / `listProjectsAwaitingInput`(dashboard 跨表聚合 = 真串号,已加 `c.tenant_id` 过滤)

**仍未改 / 有意保持的**:
- `routine_runs` / `routine_schedule_claims`:按 routine_id 键(受 routine 归属保护)。⚠️ **cron 调度在后台跑,ALS=LEGACY** → 定时执行写入会落 LEGACY_TENANT。补法:cron 调度器读 `routine.tenantId` 后 `runWithTenant()` 包裹执行。routines 不在 demo 路径。
- `installed_plugins` / `plugin_marketplaces` / `applied_plugin_snapshots` / `registry_entries`:**有意保持 daemon 全局**——插件/市场在 open-design 里是 daemon 级安装、跨租户共享。若产品要 per-tenant 插件,再单独设计(不是纯机械改)。
- `critique_runs` / `genui_surfaces` / `run_devloop_iterations` / `skill_plugin_candidates`:run/project 级,受 project gate 保护;agent 回调路径已由 tool-token tenant 还原(§3.5)覆盖。生产前建议补显式过滤。
- BYOK 配置目前还是按用户隔离(SaaS Go backend 这边),daemon 收到的 OD_BYOK_* env 是网关 per-user 注入,不通过 X-Tenant-Id 走。**共享 daemon 模式下需改 per-request BYOK**(见 §3.4)。

**Trust 边界**:
- daemon **只信任** Go 网关传来的 `X-Tenant-Id`
- daemon **不 bind** 公网端口,只监听 `od-saas_default` 网络
- 客户端浏览器直接连 daemon 是攻击面 — `proxy.go` 已经在 Director 里 `Del("X-Tenant-Id")` 再 `Set`,客户端伪造 header 会被覆盖
