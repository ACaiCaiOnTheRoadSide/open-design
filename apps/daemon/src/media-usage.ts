// 媒体生成计量:探测产物真实时长 + 写 media_usage 事实表(migrations/0004)。
//
// 计量与 provider 解耦的关键在 probeMp4DurationSec:它按容器格式(而非
// provider)测产物字节的实际时长,新接的视频 provider 只要产出 MP4/MOV 家族
// 容器就自动被覆盖,无需任何统计侧改动。渲染器上报的生效值(RenderResult.usage)
// 是可选增强,请求参数是最后兜底 —— 三级来源由 duration_source 标记。
import type Database from 'better-sqlite3';
import { currentTenantId } from './multitenant.js';

export type MediaUsageDurationSource = 'measured' | 'reported' | 'requested';

// generateMedia 返回 meta 里的计量块;stub 产物(占位文件)不产生它。
export interface MediaUsageMeasures {
  imagesCount?: number;
  videoDurationSec?: number;
  durationSource?: MediaUsageDurationSource;
  resolution?: string;
  providerUsage?: unknown;
}

export interface MediaUsageInsert {
  userId?: string | undefined;
  projectId: string;
  taskId?: string | undefined;
  surface: string;
  provider?: string | undefined;
  model?: string | undefined;
  status: 'done' | 'failed';
  measures?: MediaUsageMeasures | undefined;
  outputBytes?: number | undefined;
  elapsedMs?: number | undefined;
  errorCode?: string | undefined;
}

// 写一行计量。best-effort:计量失败只打日志,绝不打断生成任务本身的流程。
export async function recordMediaUsage(
  db: Database.Database,
  input: MediaUsageInsert,
): Promise<void> {
  try {
    const m = input.measures;
    await db.prepare(
      `INSERT INTO media_usage
         (tenant_id, user_id, project_id, task_id, surface, provider, model,
          status, images_count, video_duration_sec, duration_source, resolution,
          output_bytes, elapsed_ms, error_code, provider_usage_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      currentTenantId(),
      input.userId ?? null,
      input.projectId,
      input.taskId ?? null,
      input.surface,
      input.provider ?? null,
      input.model ?? null,
      input.status,
      m?.imagesCount ?? null,
      m?.videoDurationSec ?? null,
      m?.durationSource ?? null,
      m?.resolution ?? null,
      input.outputBytes ?? null,
      input.elapsedMs ?? null,
      input.errorCode ?? null,
      m?.providerUsage !== undefined ? safeJson(m.providerUsage) : null,
      Date.now(),
    );
  } catch (err) {
    console.error(
      `[media-usage] record failed (surface=${input.surface} model=${input.model ?? '?'}):`,
      err instanceof Error ? err.message : err,
    );
  }
}

function safeJson(value: unknown): string | null {
  try {
    const s = JSON.stringify(value);
    return typeof s === 'string' ? s : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 容器时长探测。

// MP4/MOV(ISO BMFF)家族:顶层扫 box 找 moov,在其子 box 里找 mvhd,
// duration/timescale 即整片时长秒数。moov 可能在文件头也可能在尾,所以全量
// 顶层扫描;所有读取都做界检查,任何异常返回 null 走下一级兜底。
// WebM/MKV(EBML,魔数 0x1A45DFA3)暂不解析——当前没有 provider 产出它,
// 真遇到时在这里加一种容器分支,而不是加 provider 特判。
export function probeMp4DurationSec(bytes: Buffer): number | null {
  try {
    if (bytes.length < 16) return null;
    const moov = findBox(bytes, 0, bytes.length, 'moov');
    if (!moov) return null;
    const mvhd = findBox(bytes, moov.start, moov.end, 'mvhd');
    if (!mvhd) return null;
    const p = mvhd.start;
    if (p + 4 > bytes.length) return null;
    const version = bytes[p];
    let timescale: number;
    let duration: number;
    if (version === 1) {
      // version(1)+flags(3)+creation(8)+modification(8) → timescale u32 + duration u64
      if (p + 32 > mvhd.end) return null;
      timescale = bytes.readUInt32BE(p + 20);
      duration = Number(bytes.readBigUInt64BE(p + 24));
    } else {
      // version(1)+flags(3)+creation(4)+modification(4) → timescale u32 + duration u32
      if (p + 20 > mvhd.end) return null;
      timescale = bytes.readUInt32BE(p + 12);
      duration = bytes.readUInt32BE(p + 16);
      if (duration === 0xffffffff) return null; // spec: unknown duration
    }
    if (!timescale || !Number.isFinite(duration) || duration <= 0) return null;
    const sec = duration / timescale;
    if (!Number.isFinite(sec) || sec <= 0 || sec > 24 * 3600) return null;
    return Math.round(sec * 1000) / 1000;
  } catch {
    return null;
  }
}

// 在 [from, to) 区间内顺序扫描 ISO BMFF box,返回第一个匹配类型的内容区间。
function findBox(
  bytes: Buffer,
  from: number,
  to: number,
  type: string,
): { start: number; end: number } | null {
  let offset = from;
  while (offset + 8 <= to) {
    let size = bytes.readUInt32BE(offset);
    const boxType = bytes.toString('latin1', offset + 4, offset + 8);
    let headerLen = 8;
    if (size === 1) {
      if (offset + 16 > to) return null;
      const large = bytes.readBigUInt64BE(offset + 8);
      if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
      size = Number(large);
      headerLen = 16;
    } else if (size === 0) {
      size = to - offset; // box 延伸到区间末尾
    }
    if (size < headerLen || offset + size > to) return null;
    if (boxType === type) {
      return { start: offset + headerLen, end: offset + size };
    }
    offset += size;
  }
  return null;
}
