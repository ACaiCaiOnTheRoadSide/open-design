import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// `MEDIA_USER_REPLY_CONTRACT` exists twice: the daemon owns the copy that
// composeSystemPrompt actually renders, and packages/contracts carries an
// identical one. Nothing imports the contracts copy today, which is precisely
// what makes the duplication dangerous — editing it looks like changing
// behaviour and changes nothing.
//
// That already happened: the three-outcome refusal wording was added to the
// contracts copy alone, so the primary agent flow kept describing a
// content-safety refusal as a temporary outage. This test is the cheap guard
// against a repeat. Delete it only by deleting one of the two copies.

function templateBody(path: string): string {
  const source = readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
  const marker = 'export const MEDIA_USER_REPLY_CONTRACT = `';
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`MEDIA_USER_REPLY_CONTRACT not found in ${path}`);
  let index = start + marker.length;
  // Scan for the terminating backtick, skipping escaped ones -- the body
  // itself contains \` around inline code, so a naive search truncates it.
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === '`') return source.slice(start + marker.length, index);
    index += 1;
  }
  throw new Error(`unterminated template literal in ${path}`);
}

describe('MEDIA_USER_REPLY_CONTRACT mirrors', () => {
  const daemonBody = templateBody('../../src/prompts/media-contract.ts');
  const contractsBody = templateBody(
    '../../../../packages/contracts/src/prompts/media-contract.ts',
  );

  it('keeps the daemon copy and the contracts copy identical', () => {
    expect(daemonBody).toBe(contractsBody);
  });

  it('carries sanitized Simplified Chinese completion categories', () => {
    expect(daemonBody).toContain('图片已生成');
    expect(daemonBody).toContain('图片未生成：内容安全策略拒绝了该请求');
    expect(daemonBody).toContain('图片未生成：没有可用的媒体生成工具');
    expect(daemonBody).toContain('图片未生成：媒体生成失败');
    expect(daemonBody).toContain('raw error text');
    expect(daemonBody).not.toContain('MEDIA_DISPATCH_FAILED');
    expect(daemonBody).not.toContain('图片生成服务暂时不可用');
  });
});
