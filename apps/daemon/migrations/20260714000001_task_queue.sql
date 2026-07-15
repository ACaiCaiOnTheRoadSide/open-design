-- 持久化任务队列:替代 run-concurrency-gate.ts 的内存 FIFO。
-- 所有走 Huskbox 的行为(对话 run、PPTX 导出、图片导出、品牌提取)统一入队,
-- daemon worker 用 FOR UPDATE SKIP LOCKED 消费。队列状态持久化在 PG,
-- 进程重启后排队/运行中的任务可恢复,不再丢失。
BEGIN;

CREATE TABLE IF NOT EXISTS task_queue (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL DEFAULT '__legacy__',
  user_id TEXT,
  -- 任务类型:run / export-pptx / export-image / brand-extract 等,
  -- 留给未来按类型差异化处理(超时、重试策略)
  task_type TEXT NOT NULL DEFAULT 'run',
  -- 关联的 run id(对话任务);其他类型可为 NULL
  run_id TEXT,
  -- JSON 载荷:调用方自定义的上下文(prompt 摘要、项目信息等)
  payload_json TEXT,
  -- pending → running → completed / failed / canceled
  status TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  -- 消费此任务的 worker 标识(hostname / pid)
  worker_id TEXT,
  -- running 态下 worker 定期刷新,用于卡死检测
  heartbeat_at BIGINT,
  -- 结果 / 错误(终态填充)
  result_json TEXT,
  error_text TEXT,
  created_at BIGINT NOT NULL,
  started_at BIGINT,
  finished_at BIGINT
);

-- 消费查询:WHERE status='pending' ORDER BY priority DESC, created_at
CREATE INDEX IF NOT EXISTS idx_task_queue_pending
  ON task_queue(status, priority DESC, created_at)
  WHERE status = 'pending';

-- 卡死回收:WHERE status='running' AND heartbeat_at < threshold
CREATE INDEX IF NOT EXISTS idx_task_queue_running_heartbeat
  ON task_queue(status, heartbeat_at)
  WHERE status = 'running';

-- 租户维度查询(排队位置、历史)
CREATE INDEX IF NOT EXISTS idx_task_queue_tenant
  ON task_queue(tenant_id, status, created_at);

COMMIT;
