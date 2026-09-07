import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  downloadTemplateArchive,
  isTemplateHandoffUrl,
} from '../src/services/template-import.js';

describe('template archive import', () => {
  it('accepts only the fixed public handoff endpoint', () => {
    expect(isTemplateHandoffUrl(
      'https://inspire.example/api/v1/catalog/handoff-download/signed-token',
    )).toBe(true);
    expect(isTemplateHandoffUrl(
      'https://inspire.example/api/v1/catalog/templates/example/handoff-download?token=signed',
    )).toBe(false);
    expect(isTemplateHandoffUrl(
      'http://inspire.example/api/v1/catalog/handoff-download/signed-token',
    )).toBe(false);
  });

  it('imports a template ZIP without SKILL.md', async () => {
    const zip = new JSZip();
    zip.file('DESIGN.md', '# Design');
    zip.file('assets/example.txt', 'asset');
    const archive = await zip.generateAsync({ type: 'nodebuffer' });

    const files = await downloadTemplateArchive(
      'https://inspire.example/api/v1/catalog/handoff-download/signed-token',
      async () => new Response(archive, { status: 200 }),
    );

    expect(files.map((file) => file.name).sort()).toEqual([
      'DESIGN.md',
      'assets/example.txt',
    ]);
    expect(files.find((file) => file.name === 'DESIGN.md')?.content.toString('utf8'))
      .toBe('# Design');
  });

  it('rejects an oversized expanded entry before reading its contents', async () => {
    const zip = new JSZip();
    zip.file('large.bin', Buffer.alloc(50 * 1024 * 1024 + 1));
    const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

    await expect(downloadTemplateArchive(
      'https://inspire.example/api/v1/catalog/handoff-download/signed-token',
      async () => new Response(archive, { status: 200 }),
    )).rejects.toThrow('extracted template archive exceeds 50 MiB');
  });

  it('counts directory records toward the ZIP entry limit', async () => {
    const zip = new JSZip();
    for (let index = 0; index <= 10_000; index += 1) {
      zip.folder(`directory-${index}`);
    }
    const archive = await zip.generateAsync({ type: 'nodebuffer' });

    await expect(downloadTemplateArchive(
      'https://inspire.example/api/v1/catalog/handoff-download/signed-token',
      async () => new Response(archive, { status: 200 }),
    )).rejects.toThrow('template archive contains more than 10000 entries');
  });
});
