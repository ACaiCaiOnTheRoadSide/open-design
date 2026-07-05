// 媒体计量落库(media_usage,migrations/0004):成功行带计量值与
// provider_usage_json,失败行只有错误码;insert-only,一次调用一行。
// 需要 PG(OD_PG_* env;本地用 od-saas-pg 的 od_daemon_vitest 库)。
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeDatabase, openDatabase } from '../src/db.js';
import { recordMediaUsage } from '../src/media-usage.js';

let tempDir: string;
let db: Awaited<ReturnType<typeof openDatabase>>;

beforeAll(async () => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'od-media-usage-'));
  db = await openDatabase(tempDir, { dataDir: tempDir });
});

afterAll(async () => {
  await closeDatabase();
  rmSync(tempDir, { recursive: true, force: true });
});

describe('recordMediaUsage', () => {
  it('writes a done row with measures and provider usage json', async () => {
    const taskId = randomUUID();
    await recordMediaUsage(db, {
      userId: 'user-1',
      projectId: 'proj-1',
      taskId,
      surface: 'video',
      provider: 'volcengine',
      model: 'seedance-pro',
      status: 'done',
      measures: {
        videoDurationSec: 5.005,
        durationSource: 'measured',
        resolution: '720p',
        providerUsage: { completion_tokens: 123456 },
      },
      outputBytes: 1_048_576,
      elapsedMs: 42_000,
    });

    const row: any = await db
      .prepare(`SELECT * FROM media_usage WHERE task_id = ?`)
      .get(taskId);
    expect(row).toBeTruthy();
    expect(row.tenant_id).toBe('__legacy__'); // 测试无 ALS 作用域 → 默认租户
    expect(row.user_id).toBe('user-1');
    expect(row.project_id).toBe('proj-1');
    expect(row.surface).toBe('video');
    expect(row.provider).toBe('volcengine');
    expect(row.model).toBe('seedance-pro');
    expect(row.status).toBe('done');
    expect(Number(row.video_duration_sec)).toBeCloseTo(5.005);
    expect(row.duration_source).toBe('measured');
    expect(row.resolution).toBe('720p');
    expect(Number(row.output_bytes)).toBe(1_048_576);
    expect(Number(row.elapsed_ms)).toBe(42_000);
    expect(JSON.parse(row.provider_usage_json)).toEqual({ completion_tokens: 123456 });
    expect(Number(row.created_at)).toBeGreaterThan(0);
  });

  it('writes an image done row with imagesCount', async () => {
    const taskId = randomUUID();
    await recordMediaUsage(db, {
      projectId: 'proj-1',
      taskId,
      surface: 'image',
      provider: 'volcengine',
      model: 'seedream-4.0',
      status: 'done',
      measures: { imagesCount: 1, resolution: '16:9' },
      outputBytes: 2048,
      elapsedMs: 900,
    });
    const row: any = await db
      .prepare(`SELECT * FROM media_usage WHERE task_id = ?`)
      .get(taskId);
    expect(Number(row.images_count)).toBe(1);
    expect(row.video_duration_sec).toBeNull();
    expect(row.user_id).toBeNull();
  });

  it('writes a failed row without measures', async () => {
    const taskId = randomUUID();
    await recordMediaUsage(db, {
      projectId: 'proj-1',
      taskId,
      surface: 'video',
      model: 'seedance-pro',
      status: 'failed',
      elapsedMs: 3000,
      errorCode: 'http_402',
    });
    const row: any = await db
      .prepare(`SELECT * FROM media_usage WHERE task_id = ?`)
      .get(taskId);
    expect(row.status).toBe('failed');
    expect(row.error_code).toBe('http_402');
    expect(row.images_count).toBeNull();
    expect(row.video_duration_sec).toBeNull();
    expect(row.provider_usage_json).toBeNull();
  });
});
