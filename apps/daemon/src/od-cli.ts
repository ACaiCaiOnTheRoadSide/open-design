#!/usr/bin/env node

/**
 * Dependency-free sandbox entry point. Keep this separate from cli.ts: the
 * daemon CLI intentionally imports many server-side commands, including native
 * dependencies that are unavailable in the sandbox that downloads this bundle.
 */
import { runFile, runSync } from './sync/cli-run.js';
import { runSandboxResearch } from './research/cli-run.js';

const [command, ...args] = process.argv.slice(2);

if (command === 'sync') {
  await runSync(args);
} else if (command === 'file') {
  await runFile(args);
} else if (command === 'research') {
  await runSandboxResearch(args);
} else {
  if (command) {
    console.error(`od-cli: unsupported sandbox command '${command}'`);
  }
  console.error('This sandbox bundle only supports: od sync pull|push, od file get <path>, od research search');
  process.exit(2);
}
