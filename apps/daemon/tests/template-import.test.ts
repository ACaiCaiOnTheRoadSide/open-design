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
});
