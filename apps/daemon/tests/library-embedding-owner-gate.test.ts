import { describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

async function sourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(absolute));
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(absolute);
  }
  return out;
}

describe('library owner producer gate', () => {
  it('requires explicit ownership work before introducing an embedding producer', async () => {
    const root = path.resolve(import.meta.dirname, '../src');
    const files = await sourceFiles(root);
    const producers: string[] = [];
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      if (/INSERT\s+(?:OR\s+REPLACE\s+)?INTO\s+library_embeddings/iu.test(text)) {
        producers.push(path.relative(root, file));
      }
    }
    // There is currently no embedding producer. This grep gate deliberately
    // fails as soon as one is added, forcing that change to register/check a
    // library_embedding owner before it can land.
    expect(producers).toEqual([]);
  });

  it('keeps every current token/task production route owner-registered', async () => {
    const route = await readFile(path.resolve(import.meta.dirname, '../src/routes/library.ts'), 'utf8');
    expect(route).toContain("kind: 'library_token'");
    expect(route).toContain("kind: 'library_task'");
    expect(route).toContain("isVisible('library_token'");
  });
});
