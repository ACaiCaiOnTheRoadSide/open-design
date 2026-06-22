# Daemon Postgres 迁移 — 现状与转换路线

> 目标:把 daemon 从单实例 SQLite 改成共享 Postgres,支撑多副本横向扩(百智云 k8s)。
> 本目录是这条路的**已验证基础**;真正的代码改造(sync→async)是后续分阶段工程。

## 已完成并验证(2026-06)

- **`0001_init.sql`** — 全部 21 张表的 PG schema(含 `tenant_id` 列 + 复合索引)。
  - 从已应用所有迁移的运行态 SQLite **dump 翻译**而来(不是手写重建,避免漏列)。
  - 方言转换:`INTEGER → BIGINT`(JS `Date.now()` 毫秒戳超 int32)、`REAL → DOUBLE PRECISION`。
  - 表按 **FK 依赖排序**(PG 建表即检查外键,SQLite 是延迟的)。
  - ✅ **已在 Postgres 16 上实测应用**:`psql -v ON_ERROR_STOP=1` 干净 COMMIT,建出 21 表 + 67 索引。
- **`src/storage/pg.ts`** — pg `Pool` 工厂 + 迁移 runner(读本目录 `*.sql`,用 `schema_migrations` 表去重)。
  - 读 `src/storage/daemon-db.ts` 已定义的 `OD_DAEMON_DB=postgres` + `OD_PG_*` env 契约。
  - ⚠️ 还**未被运行中 daemon 引用**;需要先 `pnpm add pg @types/pg`(daemon 当前无此依赖)。

## 待做:sync→async 代码改造(大头,分阶段)

`better-sqlite3` 是**同步** API(`db.prepare(...).get()`),`pg` 是**异步**。这是唯一的硬骨头:
所有 db 函数要变 `async`,所有调用点要加 `await`,连锁到 172 个 HTTP handler。

### 阶段 0 — 接入依赖与连接(0.5 天)
- `pnpm add pg @types/pg`;`openDatabase()` 旁路出一个 `OD_DAEMON_DB=postgres` 分支调 `runMigrations()` + `getPool()`。
- compose 加 `od_daemon` 库 + `OD_PG_*` env(本目录同级已在 docker-compose 备注)。

### 阶段 1 — 抽象数据访问接口(1 天)
- 定义 `DataStore` 接口(`getProject(tenantId,id): Promise<...>` 等),让 sqlite 与 pg 两实现并存。
- sqlite 实现包一层 `async`(`Promise.resolve(syncCall())`),**先让全链路 await 起来但行为不变** —— 这步是把"同步假设"从代码里拆掉的关键,可独立上线、零行为变化。

### 阶段 2 — 全 call site 加 await(2 天,机械但量大)
- `db.ts` 40+ 函数、`media-tasks.ts`、`plugins/persistence.ts`、`critique/persistence.ts`、`registry/database-backend.ts` 全部 `export async function`。
- `server.ts`(172 handler)、`project-routes.ts`、`media-routes.ts` 等:每个 `getX(...)` 前加 `await`,handler 本就支持 async。
- codemod 辅助:`db\.(get|insert|update|delete|list|upsert)\w+\(` → 前面补 `await`,人工 review。

### 阶段 3 — pg 实现 + 方言(1 天)
- 写 `DataStore` 的 pg 实现:占位符 `?` → `$1,$2`;`json_extract(x,'$.k')` → `x::jsonb->>'k'`;
  `ON CONFLICT ... DO UPDATE` PG 原生支持;**`rowid` 不存在** → `preview_comments` 的 `ORDER BY ..., rowid` 改 `ctid` 或加 serial 列。
- BIGINT 边界:node-pg 把 BIGINT 当 string 返回,在 normalize 层 `Number()` 回。

### 阶段 4 — ALS tenant 注入复用
- `currentTenantId()` 机制不变;pg 实现里照样读它拼 `WHERE tenant_id = $N`。
- (可选)若以后要 DB 层兜底,可在取连接后 `SET LOCAL app.tenant_id` 走 RLS;当前 repository-scoped 已足够。

### 阶段 5 — 删 SQLite 同步投影
- backend 的 `daemon→PG` 同步(`internal/session/sync*.go`)在 daemon 直连 PG 后**整条删掉**(不再有中间 SQLite)。
- 这也顺带消灭了之前 CGO_ENABLED=0 读 SQLite 的坑(已用 modernc 临时修)。

## 估时

| 阶段 | 工作量 |
|---|---|
| 0 接入 | 0.5d |
| 1 抽象 | 1d |
| 2 await 连锁 | 2d |
| 3 pg 实现+方言 | 1d |
| 4 tenant | 0.5d(复用) |
| 5 删同步 | 0.5d |
| **合计** | **~5.5 天** |

> schema 与连接层(本目录)已就绪并验证;余下是有明确路径的体力活,可逐阶段独立上线。
