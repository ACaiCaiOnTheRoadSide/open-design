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
- `enterTenant(tenantId)` / `currentProviderConfig()`:tool-token 回调就地还原租户(见 §3.5)、读取 per-request BYOK provider 配置(见 §3.6)

> ⚠️ **「加列」≠「加过滤」**:`migrateTenantId` 把 `tenant_id` 列加到 **21 张表**,但实际带 `WHERE tenant_id = ?` 隔离的只有约 **12 组**(Phase 1 的 6 组见 §2.3 + Phase 2 补的 templates / routines / deployments / tabs / 2 个 dashboard 聚合见 §7)。其余表(plugins / registry / critique / genui / routine_runs 等)**只有列、查询未改**,仍是全租户范围。完整的"已隔离 vs 仅加列"清单见 §7。

### 2.2 改的现有文件

| 文件 | 改动 |
|---|---|
| `apps/daemon/src/db.ts` | import `migrateTenantId/currentTenantId`;`migrate()` 末尾调 `migrateTenantId(db)`;改造多组 db 函数(见 §2.3);另加 PG 分支(`openDatabase` 的 `OD_DAEMON_DB=postgres`、`runPgMigrations`、`isPgMode()` + 方言修复,见 §4 P2) |
| `apps/daemon/src/media-tasks.ts` | import `currentTenantId`;改造 7 个 CRUD 函数 |
| `apps/daemon/src/server.ts` | import `tenantMiddleware/enterTenant/currentProviderConfig`;路由前 `app.use(tenantMiddleware)`;tool-token 校验后 `enterTenant(grant.tenantId)`(§3.5);spawn 前 `mergeOpenCodeProviderConfig(...)`(§3.6) |
| `apps/daemon/src/tool-tokens.ts` | `ToolTokenGrant`/`MintToolTokenOptions` 加 `tenantId`,`mint()` 默认捕获 `currentTenantId()`(§3.5) |
| `apps/daemon/src/mcp-config.ts` | 新增 `mergeOpenCodeProviderConfig()`(BYOK provider 块与 daemon 配置浅合并,§3.6) |
| `apps/daemon/src/storage/daemon-db.ts` | `DaemonDbConfig` 加可选 `schema`,解析 `OD_PG_SCHEMA`(§4 P2) |
| `apps/daemon/src/media.ts` | 新增 `volcengineImageSizeFor()` 修 Seedream 比例 bug(§2.4) |
| `apps/daemon/src/media-models.ts` + `apps/web/src/media/models.ts` | 加 `seedream-4.0` 模型(§2.4) |
| `backend/internal/proxy/proxy.go`(在 saas repo) | Director 里注入 `X-Tenant-Id`,优先 `user.TeamID`,空则 `user.ID`;另注入 `X-OD-Provider-Config`(§3.6) |
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

### 2.4 顺带的产品改动(非多租户,但在本分支 diff 里)

这两处不属于多租户/PG/BYOK 主线,但确实随分支一起进来了,验收生图时会用到:

- **新增图像模型 `seedream-4.0`**(`doubao-seedream-4-0-250828`,volcengine,`t2i + i2i`)——同时加到 daemon `media-models.ts` 和 web `apps/web/src/media/models.ts` 两侧的模型列表。
- **修复 Seedream 生图比例 bug**(`media.ts`):原来 volcengine 图像走 `openaiSizeFor()`,该函数没有 seedream 分支,所有请求都回落 `1024x1024` → `--aspect 16:9` **静默生成方图**。新增 `volcengineImageSizeFor()` 把 OD 的 aspect 词表映射成 ~2048 长边的显式 `WxH`(16:9→2048x1152 等),比例才被尊重。

### 2.5 测试

- **`apps/daemon/tests/mcp-config.test.ts`**(新,~85 行)——覆盖 `mergeOpenCodeProviderConfig`(BYOK provider 块与 daemon 自建 mcp/permission 配置的合并,见 §3.6)。

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

### 3.6 per-request BYOK(provider 配置按请求注入)★ 已实现(commit 891760573)

> ⚠️ 这条把 §3.4 / §7 里"共享 daemon 模式下需改 per-request BYOK"那句**待办**给做掉了——共享单 daemon 已经能按调用方取各自的模型 + key。

**问题**:共享多租户 daemon 下,provider/模型 key 不能再用容器级单一 env(`OD_OPENCODE_PROVIDER_CONFIG`),否则全租户共用一把 key。

**解法**(配置随 ALS 传播,和 tenant id 同一条链路):
- `multitenant.ts`:`TenantStore` 增加可选 `providerConfig`;`PROVIDER_CONFIG_HEADER = 'x-od-provider-config'`;`tenantMiddleware` 读该头存进 ALS;`currentProviderConfig()` 读取;`enterTenant()` 重置租户时**保留**已绑的 providerConfig 不丢。
- `mcp-config.ts`:`mergeOpenCodeProviderConfig(base, injectedJson)`——把注入的 `provider`/`model` 块与 daemon 自建的 `mcp` + `permission.external_directory` **浅合并**,而非互相覆盖(否则 OpenCode 只读一个 `OPENCODE_CONFIG_CONTENT`,provider 会被 daemon 的 permission 块冲掉 → `AGENT_EXECUTION_FAILED`)。
- `server.ts`:spawn 前 `mergeOpenCodeProviderConfig(opencodeConfigContent, currentProviderConfig() ?? process.env.OD_OPENCODE_PROVIDER_CONFIG)`——**优先 per-request 头**,回落容器级 env(单 key / 本地 dev)。

**边界**:目前只接了 **OpenCode** 这条 provider 注入路径;其它 runtime(Claude / ACP 家族)的 per-request key 注入未做。Go 网关侧注入 `X-OD-Provider-Config` 头的实现不在本仓(在 saas repo `proxy.go`)。

---

## 4. 后续 TODO(按优先级)

### P2 — PG 迁移 ✅ 已切到**全量异步 pg**(2026-06,async-pg 已并入 multitenant @ `b5564ec4e`)

> ⚠️ **路线已变更**:最初 multitenant 用的是"同步适配器"(`pg-sync.ts` + worker + `Atomics.wait` 阻塞主线程)。后来在 `async-pg` 分支做了**真异步重写**,并已 merge 回 multitenant(合并提交 `b5564ec4e`,父 `891760573` + `afe851182`)。**同步适配器 `pg-sync.ts` / `pg-sync-worker.ts` 已删除**,现在跑的是 `pg-async.ts`。

当前 PG 实现:
- `src/storage/pg-async.ts` — 真 `pg.Pool`(`OD_PG_POOL_MAX`,默认 10),**不阻塞事件循环**,单进程并发查询回来了。暴露 better-sqlite3 的方法形状(`prepare(sql).get/all/run`、`exec`、`transaction`、`close`)但**每个方法返回 Promise**。事务用 `AsyncLocalStorage` 携带 checked-out 的 `PoolClient`,事务内查询走同一连接、并发事务各拿各的连接。
- 方言处理照搬自旧 worker:`?`→`$N`(`toPgPlaceholders`)、**驼峰标识符自动加引号**(`quoteCamelIdentifiers`,防 PG 折小写)、BIGINT→Number。
- `db.ts` — **52 个 db 函数全 `async`**,`openDatabase()` 也是 async;`OD_DAEMON_DB=postgres` 走 `openPgAsync`;`runPgMigrations` 读 `migrations/*.sql` 用 `schema_migrations` 记账;3 处方言分支(`terminalRunDurationSql` 算术、`rowid`→`id`、`INSERT OR IGNORE`→`ON CONFLICT DO NOTHING`)。
- 全量 await 连锁:47 个文件、`server.ts` 加了 ~560 处 `await`(routes / plugins / critique / registry / routines / media 等)。
- `OD_PG_SCHEMA`(commit ca18c3048,本次合并时移植进 `pg-async.ts`):Pool 的 `connect` 事件里 `CREATE SCHEMA IF NOT EXISTS` + `SET search_path`,daemon 的表落独立 schema,**与 Go backend 共用同一平台库时不撞 public schema**。`daemon-db.ts` 解析该 env。
- SaaS `manager.go` — spawn daemon 时按 `DaemonDBMode=postgres` 注入 `OD_DAEMON_DB`/`OD_PG_*`;compose 加 `pg-init` + `DAEMON_DB` 开关(默认 sqlite)。

**代价 / 风险(异步路线的)**:`db.ts` 全量 async 化,**任何一处漏 `await` 就是 fire-and-forget**——写不落或 unhandled rejection 崩 daemon。async-pg 已修了 4 个(`createMediaTask` / media `/wait` / 若干 seed)。`server.ts` 是 `// @ts-nocheck`,typecheck 盖不到,漏 await 只能靠运行时/人工抓。

**未尽**:
- ⚠️ **`tests/transcript-export.test.ts` 仍是未转换的红**:`transcript-export.ts` 源码已 async,但该 test(~750 行、20+ `it`、`setup()` 把 db 标成 `better-sqlite3 Database`)没跟着加 `await`/换异步 db 类型 → `tsc -p tsconfig.tests.json` 报错。**这是 async-pg 继承的,不是合并新引入的**;`src/` 那遍 tsc 已全绿。需独立 PR 把该 test 异步化。
- 真实 LLM 生成链路(chat/run)在 PG 下未端到端跑;`db-inspect.ts` 的 rowid introspection 在 PG 会报错(非核心);Pool 并发上限需压测。

#### (历史)PG 基础:
- ✅ `migrations/0001_init.sql` — 21 表 PG schema(tenant_id + 索引),从运行态 SQLite dump 翻译(INTEGER→BIGINT、REAL→DOUBLE PRECISION、FK 依赖排序)。已在 Postgres 16 实测应用(21 表 + 67 索引干净 COMMIT)。
- ⚠️ `src/storage/pg.ts` — 早期 pg Pool 工厂雏形,**仍是死代码:无人 import**。现在真正跑的是 `pg-async.ts`。`pg.ts` 可删。
- `migrations/README.md` 描述的"~5.5 天 sync→async 重写"**就是 async-pg 实际做完的事**(不再是未来计划);该 README 仍以"未来路线"口吻写,已过时,可校正或删。

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
- BYOK:✅ **per-request 注入已实现**(见 §3.6)——共享 daemon 下网关用 `X-OD-Provider-Config` 头随请求带各租户的 provider+key,优先于容器级 env。**仅覆盖 OpenCode 一条 runtime 路径**;Claude / ACP 家族的 per-request key 注入仍未做(这些 runtime 当前还吃容器级 env)。

**Trust 边界**:
- daemon **只信任** Go 网关传来的 `X-Tenant-Id`
- daemon **不 bind** 公网端口,只监听 `od-saas_default` 网络
- 客户端浏览器直接连 daemon 是攻击面 — `proxy.go` 已经在 Director 里 `Del("X-Tenant-Id")` 再 `Set`,客户端伪造 header 会被覆盖
