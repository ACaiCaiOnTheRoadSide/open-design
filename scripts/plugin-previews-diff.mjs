#!/usr/bin/env node
// Decide whether two plugin-preview manifests differ in a way that matters:
// whether their `previews` subtree changed.
//
// The manifest also carries a `generatedAt` timestamp that moves on every bake
// run. Comparing the whole file therefore always reports a change and opens a
// noise review PR even when no clip actually changed. The bake workflows use
// this helper to open/update a review PR only when a real preview entry changed.
//
// CLI:
//   node scripts/plugin-previews-diff.mjs <oldManifest.json> <newManifest.json>
//   prints "changed" or "unchanged" to stdout; exit 0 on success, 2 on error.
//   A missing/unreadable OLD manifest is treated as "no previews yet", so any
//   entry in NEW counts as a change.

import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

export function previewsChanged(oldManifest, newManifest) {
  const oldPreviews = (oldManifest && oldManifest.previews) || {};
  const newPreviews = (newManifest && newManifest.previews) || {};
  return canonical(oldPreviews) !== canonical(newPreviews);
}

function readJsonOrEmpty(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

const invokedDirectly = process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const [oldPath, newPath] = process.argv.slice(2);
  if (!oldPath || !newPath) {
    console.error('usage: plugin-previews-diff.mjs <oldManifest.json> <newManifest.json>');
    process.exit(2);
  }
  let newManifest;
  try {
    newManifest = JSON.parse(readFileSync(newPath, 'utf8'));
  } catch (error) {
    console.error(`failed to read new manifest ${newPath}: ${error.message}`);
    process.exit(2);
  }
  const oldManifest = readJsonOrEmpty(oldPath);
  process.stdout.write(previewsChanged(oldManifest, newManifest) ? 'changed\n' : 'unchanged\n');
}
