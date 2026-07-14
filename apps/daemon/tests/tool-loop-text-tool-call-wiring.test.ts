import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

type StartedServer = {
  url: string;
  server: http.Server;
  shutdown?: () => Promise<void> | void;
};

/**
 * Wiring test for the tool-loop guard's trigger 4 (tool calls written as prose).
 *
 * The guard's own unit tests drive `observeAssistantText()` directly, which
 * proves the DETECTION but not the WIRING — and the wiring is where this
 * shipped broken the first time: `text_delta` for json-event-stream (opencode),
 * qoder, pi-rpc, copilot and ACP goes out through `emitGuardedTextDelta`, which
 * sends bare and never reaches `emitAgentEvent`, so the guard saw nothing from
 * the very agent it was written for. Only Claude's text went through the choke
 * point. This test drives a REAL run of a fake opencode through the daemon's
 * json-event-stream path and asserts the halt actually fires — a unit test on
 * the guard cannot catch a regression here.
 *
 * Requires a daemon Postgres (`OD_DAEMON_DB`): this fork's `startServer()` has
 * no SQLite path, so every server-booting test — this one and the pre-existing
 * `headless-runs.test.ts` — needs a live database. Skipped rather than failed
 * when one is not configured, so a developer without PG does not inherit a red
 * suite; run it against the compose Postgres.
 */
const describeWithDb = process.env.OD_DAEMON_DB ? describe : describe.skip;

describeWithDb('tool-loop guard trigger 4 is wired to the json-event-stream text path', () => {
  let started: StartedServer | null = null;
  const oldPath = process.env.PATH;
  const oldGuard = process.env.OD_TOOL_LOOP_GUARD;
  const oldAgentHome = process.env.OD_AGENT_HOME;

  afterEach(async () => {
    await Promise.resolve(started?.shutdown?.());
    if (started?.server) {
      await new Promise<void>((resolve) => started?.server.close(() => resolve()));
    }
    started = null;
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldGuard === undefined) delete process.env.OD_TOOL_LOOP_GUARD;
    else process.env.OD_TOOL_LOOP_GUARD = oldGuard;
    if (oldAgentHome === undefined) delete process.env.OD_AGENT_HOME;
    else process.env.OD_AGENT_HOME = oldAgentHome;
  });

  it('halts a run whose model writes its tool calls as text_delta prose', async () => {
    process.env.OD_TOOL_LOOP_GUARD = 'halt';
    started = await startServer({ port: 0, returnServer: true }) as StartedServer;

    const binDir = await mkdtemp(path.join(os.tmpdir(), 'od-textcall-bin-'));
    const agentHome = await mkdtemp(path.join(os.tmpdir(), 'od-textcall-home-'));
    try {
      process.env.OD_AGENT_HOME = agentHome;
      const opencodeBin = await writeTextToolCallOpencode(binDir);

      const configResponse = await fetch(`${started.url}/api/app-config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId: 'opencode',
          agentCliEnv: { opencode: { OPENCODE_BIN: opencodeBin } },
        }),
      });
      expect(configResponse.status).toBe(200);

      const projectId = `project_${randomUUID()}`;
      const projectResponse = await fetch(`${started.url}/api/projects`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: projectId, name: 'text tool call', metadata: { kind: 'prototype' } }),
      });
      expect(projectResponse.status).toBe(200);

      const runResponse = await fetch(`${started.url}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId: 'opencode', projectId, message: 'list the files' }),
      });
      expect(runResponse.status).toBe(202);
      const { runId } = await runResponse.json() as { runId: string };

      const terminal = await waitForTerminalRun(started.url, runId);
      // The guard must have seen the prose tool calls through the real stream
      // path and torn the run down. Before the wiring fix this run simply ran
      // to completion with no tools executed and no verdict at all.
      expect({ errorCode: terminal.errorCode, error: terminal.error ?? '' }).toMatchObject({
        errorCode: 'TOOL_LOOP_DETECTED',
        error: expect.stringContaining('plain text'),
      });
    } finally {
      await rm(binDir, { recursive: true, force: true });
      await rm(agentHome, { recursive: true, force: true });
    }
  }, 30_000);
});

/**
 * A fake `opencode` that behaves exactly like the Kimi incident: it streams
 * OpenCode's json-event-stream `text` parts whose body is a tool call written
 * as prose, and never emits a single structured tool_use. It then idles, so a
 * run that is NOT halted would hang here rather than exit cleanly — making the
 * halt the only way this test can finish.
 */
async function writeTextToolCallOpencode(dir: string): Promise<string> {
  const bin = path.join(dir, 'opencode');
  // The literal shape the incident produced. Injected via JSON.stringify so the
  // quotes and backslashes survive the trip into the generated script verbatim
  // — hand-escaping this into a template literal is how the first attempt at
  // this fixture silently became a syntax error instead of a stream.
  const toolCallText = '[tool_call] bash\n{"command": "find /workspace -name \\"*.so*\\" | head -30"}';
  await writeFile(bin, `#!/usr/bin/env node
if (process.argv.includes('--version')) { console.log('opencode 0.0.0'); process.exit(0); }
if (process.argv[2] === 'models') { console.log('test/model'); process.exit(0); }
if (process.argv[2] !== 'run') { process.exit(0); }

const TEXT = ${JSON.stringify(toolCallText)};
process.stdin.resume();
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
emit({ type: 'step_start', sessionID: 'sess_fake' });
let sent = 0;
setInterval(() => {
  sent += 1;
  emit({ type: 'text', part: { text: TEXT } });
  // Never exits on its own: a working guard is the only thing that ends this
  // run. If the guard were unwired the run would hang instead of passing.
}, 20);
`, 'utf8');
  await chmod(bin, 0o755);
  return bin;
}

async function waitForTerminalRun(
  url: string,
  runId: string,
): Promise<{ status: string; error: string | null; errorCode: string | null }> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const response = await fetch(`${url}/api/runs/${encodeURIComponent(runId)}`);
    expect(response.status).toBe(200);
    const body = await response.json() as {
      status: string;
      error: string | null;
      errorCode: string | null;
    };
    if (['succeeded', 'failed', 'canceled'].includes(body.status)) return body;
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} never reached a terminal status (last: ${body.status})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
