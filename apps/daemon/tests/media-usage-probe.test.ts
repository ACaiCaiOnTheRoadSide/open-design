// 媒体计量的容器时长探测:probeMp4DurationSec 按 ISO BMFF 结构读 moov/mvhd
// 的 timescale+duration,是「生视频 X 秒」统计的权威来源(与 provider 无关,
// 请求参数被吸附/被 prompt 标志覆盖都不影响实测值)。这里手工构造最小 MP4
// 头验证 v0/v1、moov 在尾部、largesize、坏输入等关键形态。
import { describe, expect, it } from 'vitest';
import { probeMp4DurationSec } from '../src/media-usage.js';

function box(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + body.length, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}

function mvhdV0(timescale: number, duration: number): Buffer {
  // version(1)+flags(3)+creation(4)+modification(4)+timescale(4)+duration(4)
  const body = Buffer.alloc(20);
  body.writeUInt32BE(timescale, 12);
  body.writeUInt32BE(duration, 16);
  return box('mvhd', body);
}

function mvhdV1(timescale: number, duration: bigint): Buffer {
  // version(1)+flags(3)+creation(8)+modification(8)+timescale(4)+duration(8)
  const body = Buffer.alloc(32);
  body[0] = 1;
  body.writeUInt32BE(timescale, 20);
  body.writeBigUInt64BE(duration, 24);
  return box('mvhd', body);
}

const ftyp = box('ftyp', Buffer.from('isom0000isom', 'latin1'));

describe('probeMp4DurationSec', () => {
  it('reads v0 mvhd duration (moov first)', () => {
    const file = Buffer.concat([ftyp, box('moov', mvhdV0(1000, 5000))]);
    expect(probeMp4DurationSec(file)).toBe(5);
  });

  it('reads v1 mvhd 64-bit duration', () => {
    const file = Buffer.concat([ftyp, box('moov', mvhdV1(90000, 90000n * 7n))]);
    expect(probeMp4DurationSec(file)).toBe(7);
  });

  it('finds moov at the end of file (after mdat)', () => {
    const mdat = box('mdat', Buffer.alloc(64));
    const file = Buffer.concat([ftyp, mdat, box('moov', mvhdV0(600, 3000))]);
    expect(probeMp4DurationSec(file)).toBe(5);
  });

  it('skips non-mvhd children inside moov', () => {
    const trak = box('trak', Buffer.alloc(16));
    const file = Buffer.concat([
      ftyp,
      box('moov', Buffer.concat([trak, mvhdV0(1000, 12_345)])),
    ]);
    expect(probeMp4DurationSec(file)).toBe(12.345);
  });

  it('returns null for unknown duration sentinel (0xFFFFFFFF)', () => {
    const file = Buffer.concat([ftyp, box('moov', mvhdV0(1000, 0xffffffff))]);
    expect(probeMp4DurationSec(file)).toBeNull();
  });

  it('returns null on zero timescale / zero duration', () => {
    expect(
      probeMp4DurationSec(Buffer.concat([ftyp, box('moov', mvhdV0(0, 5000))])),
    ).toBeNull();
    expect(
      probeMp4DurationSec(Buffer.concat([ftyp, box('moov', mvhdV0(1000, 0))])),
    ).toBeNull();
  });

  it('returns null on garbage / truncated / non-MP4 input', () => {
    expect(probeMp4DurationSec(Buffer.alloc(0))).toBeNull();
    expect(probeMp4DurationSec(Buffer.from('not an mp4 at all'))).toBeNull();
    // stub 生成的 ~24 字节占位 mp4(无 moov)
    expect(probeMp4DurationSec(ftyp.subarray(0, 12))).toBeNull();
    // box 声称的 size 超出文件末尾
    const lying = Buffer.alloc(16);
    lying.writeUInt32BE(9999, 0);
    lying.write('moov', 4, 'latin1');
    expect(probeMp4DurationSec(lying)).toBeNull();
  });
});
