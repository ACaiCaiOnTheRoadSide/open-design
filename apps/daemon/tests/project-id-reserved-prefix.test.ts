// 项目 id 校验必须拒绝设计体系/品牌的 sync 命名空间保留前缀。否则租户能建一个
// 名为 `dsys--<victim>` 的项目,用 project-sync API 经共享 manifest 通道读/覆盖
// 别的租户的设计体系 blob(后端 manifest 键 = projectId 逐字、无租户维度)。
import { describe, expect, it } from 'vitest';

import { isSafeId } from '../src/projects.js';
import { RESERVED_SYNC_ID_PREFIXES } from '../src/sync/core.js';

describe('project id validation rejects reserved sync prefixes', () => {
  it('rejects dsys-- / brnd-- prefixed project ids', () => {
    expect(isSafeId('dsys--victim')).toBe(false);
    expect(isSafeId('brnd--victim')).toBe(false);
    // 恰好等于前缀本身也拒。
    expect(isSafeId('dsys--')).toBe(false);
    expect(isSafeId('brnd--')).toBe(false);
  });

  it('every declared reserved prefix is refused', () => {
    for (const prefix of RESERVED_SYNC_ID_PREFIXES) {
      expect(isSafeId(`${prefix}anything`)).toBe(false);
    }
  });

  it('still accepts ordinary project ids (including lookalikes without the double dash)', () => {
    expect(isSafeId('my-project')).toBe(true);
    expect(isSafeId('dsys-not-reserved')).toBe(true); // single dash, not the prefix
    expect(isSafeId('brand-kit-2')).toBe(true);
    expect(isSafeId('abc123')).toBe(true);
  });
});
