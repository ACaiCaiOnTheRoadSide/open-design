import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import {
  composeTemplateSkillInstructions,
  downloadTemplateArchive,
  isTemplateHandoffUrl,
  prepareTemplateArchive,
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

  it.each([
    {
      label: 'assets only',
      input: [{ name: 'index.html', content: Buffer.from('<main />') }],
      expected: { files: ['index.html'], prompt: null, skillPath: null },
    },
    {
      label: 'Skill only',
      input: [{ name: 'SKILL.md', content: Buffer.from('---\nname: example\n---\nFollow this.') }],
      expected: { files: ['SKILL.md'], prompt: null, skillPath: 'SKILL.md' },
    },
    {
      label: 'prompt only',
      input: [{
        name: 'template.json',
        content: Buffer.from(JSON.stringify({ id: 'prompt-only', prompt: 'Create this scene.' })),
      }],
      expected: { files: [], prompt: 'Create this scene.', skillPath: null },
    },
    {
      label: 'mixed template',
      input: [
        { name: 'template.json', content: Buffer.from(JSON.stringify({ prompt: 'Use the brief.' })) },
        { name: 'SKILL.md', content: Buffer.from('# Instructions') },
        { name: 'assets/template.html', content: Buffer.from('<main />') },
        { name: 'preview.webp', content: Buffer.from('preview') },
      ],
      expected: {
        files: ['SKILL.md', 'assets/template.html'],
        prompt: 'Use the brief.',
        skillPath: 'SKILL.md',
      },
    },
  ])('recognizes $label capabilities', ({ input, expected }) => {
    const prepared = prepareTemplateArchive(input);
    expect(prepared.files.map((file) => file.name)).toEqual(expected.files);
    expect(prepared.prompt).toBe(expected.prompt);
    expect(prepared.skillPath).toBe(expected.skillPath);
  });

  it('activates a project-local SKILL body without leaking its frontmatter', () => {
    expect(composeTemplateSkillInstructions(
      'Base routing instructions.',
      '---\nname: local-template\n---\nUse assets/template.html as the starting point.',
      'Live dashboard',
    )).toBe(
      'Base routing instructions.\n\n---\n\n## Selected template instructions — Live dashboard\n\nUse assets/template.html as the starting point.',
    );
  });

  it('rejects malformed catalog metadata', () => {
    expect(() => prepareTemplateArchive([
      { name: 'template.json', content: Buffer.from('{') },
    ])).toThrow('template archive contains invalid template.json');
  });

  it('rejects an empty archive', async () => {
    const archive = await new JSZip().generateAsync({ type: 'nodebuffer' });
    await expect(downloadTemplateArchive(
      'https://inspire.example/api/v1/catalog/handoff-download/signed-token',
      async () => new Response(archive, { status: 200 }),
    )).rejects.toThrow('template archive contains no files');
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
