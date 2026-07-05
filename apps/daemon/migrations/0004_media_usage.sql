-- 媒体生成计量表:每次生图/生视频/生音频调用写一行(media-routes.ts
-- handleGenerate 的完成/失败回调)。与 media_tasks 的任务状态行不同,这张表
-- 是计量事实,供后台按 用户/项目/模型 聚合出「生图 N 次、生视频 M 秒」。
--
-- 设计取舍(与 message_token_usage 相同的判断):
--   - insert-only、无外键 —— media_tasks 是 ON DELETE CASCADE + 保留期定期
--     清理的暂态表,不能当计量源;消耗是既成事实,行要在删项目/清任务之后
--     仍然存在,否则统计口径倒退。
--   - 视频秒数记「生效值」而非请求参数:provider 会把秒数吸附到允许档位,
--     火山的 --duration 还可能被 prompt 内嵌标志覆盖。duration_source 标记
--     来源(measured=实测产物容器 / reported=渲染器上报 / requested=请求参数),
--     审计时可区分实测与估算。
--   - status 只有 done/failed:成功才有计量值,失败行只用于失败率;stub 兜底
--     产物(provider 挂了写占位文件)记 failed + error_code,绝不计成用量。
--   - provider_usage_json 存 provider 返回的原始计费字段(如火山 usage),
--     用于和账单对账;各家结构不同,不拍平。
--   - audio_* 列预留:audio surface 已存在(music/speech/sfx),本期不计量。
BEGIN;

CREATE TABLE IF NOT EXISTS media_usage (
      id BIGSERIAL PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT '__legacy__',
      user_id TEXT,
      project_id TEXT,
      task_id TEXT,
      surface TEXT NOT NULL,
      provider TEXT,
      model TEXT,
      status TEXT NOT NULL,
      images_count BIGINT,
      video_duration_sec DOUBLE PRECISION,
      duration_source TEXT,
      resolution TEXT,
      audio_duration_sec DOUBLE PRECISION,
      audio_characters BIGINT,
      output_bytes BIGINT,
      elapsed_ms BIGINT,
      error_code TEXT,
      provider_usage_json TEXT,
      created_at BIGINT NOT NULL
    );

CREATE INDEX IF NOT EXISTS idx_media_usage_created
      ON media_usage(created_at);
CREATE INDEX IF NOT EXISTS idx_media_usage_tenant
      ON media_usage(tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_usage_tenant_user
      ON media_usage(tenant_id, user_id, created_at DESC);

COMMIT;
