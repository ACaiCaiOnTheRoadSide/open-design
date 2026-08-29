import { readFile } from 'node:fs/promises';
import {
  buildMediaGenerateBody,
  MEDIA_GENERATE_BOOLEAN_FLAGS,
  MEDIA_GENERATE_STRING_FLAGS,
  type MediaGenerateFlags,
} from './cli-request.js';

const WAIT_STRING_FLAGS = new Set(['since']);
const WAIT_BOOLEAN_FLAGS = new Set(['help', 'h']);

export async function runSandboxMedia(args: string[]): Promise<void> {
  const sub = args.find((arg) => !arg.startsWith('-')) ?? '';
  if (!sub || sub === 'help' || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }
  if (sub !== 'generate' && sub !== 'wait') {
    fail(2, `od-cli: unsupported sandbox media subcommand '${sub}'`);
  }
  const index = args.indexOf(sub);
  const subArgs = [...args.slice(0, index), ...args.slice(index + 1)];
  if (sub === 'wait') await runWait(subArgs);
  else await runGenerate(subArgs);
}

async function runGenerate(args: string[]): Promise<void> {
  const flags = parseFlagsOrExit(args, MEDIA_GENERATE_STRING_FLAGS, MEDIA_GENERATE_BOOLEAN_FLAGS);
  const env = requiredEnvironment();
  const surface = flags.surface;
  if (typeof surface !== 'string' || !['image', 'video', 'audio'].includes(surface)) {
    fail(2, '--surface must be one of: image | video | audio');
  }
  if (typeof flags.model !== 'string' || !flags.model) {
    fail(2, '--model required (see http://<daemon>/api/media/models)');
  }
  const images = repeatableFlagValues(args, 'image');
  if (flags.model.startsWith('vela/') && images.length > 5) {
    fail(2, `Vela media accepts at most 5 --image values; received ${images.length}`);
  }
  const prompt = await readPrompt(flags);
  const response = await request(
    `${env.daemonUrl}/api/tools/media/generate`,
    env.token,
    buildMediaGenerateBody(flags, prompt, images),
  );
  const accepted = await responseJson(response);
  const taskId = typeof accepted.taskId === 'string' ? accepted.taskId : '';
  if (!taskId) fail(4, 'daemon did not return a taskId');
  console.error(`task ${taskId} queued (${String(accepted.status ?? 'queued')})`);
  await poll(env.daemonUrl, env.token, taskId, 0, 25_000, 0);
}

async function runWait(args: string[]): Promise<void> {
  const flags = parseFlagsOrExit(args, WAIT_STRING_FLAGS, WAIT_BOOLEAN_FLAGS);
  const taskId = positionalArgs(args, WAIT_STRING_FLAGS)[0];
  if (!taskId) fail(2, 'usage: od media wait <taskId> [--since <n>]');
  const env = requiredEnvironment();
  const parsedSince = Number(flags.since);
  await poll(env.daemonUrl, env.token, taskId, Number.isFinite(parsedSince) ? parsedSince : 0, 120_000, 2);
}

async function poll(
  daemonUrl: string,
  token: string,
  taskId: string,
  sinceStart: number,
  budgetMs: number,
  stillRunningExitCode: number,
): Promise<void> {
  const startedAt = Date.now();
  let since = sinceStart;
  let lastStatus = 'running';
  while (Date.now() - startedAt < budgetMs) {
    const remaining = budgetMs - (Date.now() - startedAt);
    const timeoutMs = Math.max(500, Math.min(4_000, remaining));
    const response = await request(
      `${daemonUrl}/api/media/tasks/${encodeURIComponent(taskId)}/wait`,
      token,
      { since, timeoutMs },
    );
    const snapshot = await responseJson(response);
    if (Array.isArray(snapshot.progress)) {
      for (const line of snapshot.progress) {
        if (typeof line !== 'string') continue;
        process.stderr.write(`${line}\n`);
        process.stdout.write(`# ${line}\n`);
      }
    }
    if (typeof snapshot.nextSince === 'number') since = snapshot.nextSince;
    lastStatus = typeof snapshot.status === 'string' ? snapshot.status : lastStatus;
    if (snapshot.status === 'done') {
      process.stdout.write(`${JSON.stringify({ file: snapshot.file ?? {} })}\n`);
      return;
    }
    if (snapshot.status === 'failed' || snapshot.status === 'interrupted') {
      process.stdout.write(`${JSON.stringify({ taskId, status: snapshot.status, error: snapshot.error ?? {} })}\n`);
      fail(typeof (snapshot.error as { status?: unknown } | undefined)?.status === 'number'
        ? (snapshot.error as { status: number }).status
        : 5, `task ${snapshot.status}`);
    }
  }
  process.stdout.write(`${JSON.stringify({
    taskId,
    status: lastStatus,
    nextSince: since,
    elapsed: Math.round((Date.now() - startedAt) / 1000),
  })}\n`);
  if (stillRunningExitCode !== 0) process.exit(stillRunningExitCode);
}

async function request(url: string, token: string, body: Record<string, unknown>): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    fail(3, 'local media dispatcher could not be reached');
  }
  if (!response.ok) {
    const text = await response.text();
    fail(4, `daemon ${response.status}: ${text}`);
  }
  return response;
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await response.json();
    if (value && typeof value === 'object') return value as Record<string, unknown>;
  } catch {
    // handled below
  }
  fail(4, 'daemon returned non-JSON media response');
}

function requiredEnvironment(): { daemonUrl: string; token: string } {
  const daemonUrl = process.env.OD_DAEMON_URL?.replace(/\/$/, '');
  const token = process.env.OD_TOOL_TOKEN;
  const projectId = process.env.OD_PROJECT_ID;
  if (!daemonUrl) fail(2, 'OD_DAEMON_URL is required in the sandbox environment');
  if (!token) fail(2, 'OD_TOOL_TOKEN is required in the sandbox environment');
  if (!projectId) fail(2, 'OD_PROJECT_ID is required in the sandbox environment');
  return { daemonUrl, token };
}

function parseFlagsOrExit(
  args: string[],
  stringFlags: Set<string>,
  booleanFlags: Set<string>,
): MediaGenerateFlags {
  const known = new Set([...stringFlags, ...booleanFlags]);
  const flags: MediaGenerateFlags = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg?.startsWith('--')) continue;
    const equals = arg.indexOf('=');
    const key = equals >= 0 ? arg.slice(2, equals) : arg.slice(2);
    if (!known.has(key)) fail(2, `unknown flag: --${key}. Run with --help for accepted flags.`);
    if (equals >= 0) {
      flags[key] = arg.slice(equals + 1);
    } else if (booleanFlags.has(key)) {
      flags[key] = true;
    } else {
      const value = args[index + 1];
      if (value == null || value.startsWith('--')) fail(2, `flag --${key} requires a value`);
      flags[key] = value;
      index++;
    }
  }
  return flags;
}

function positionalArgs(args: string[], stringFlags: Set<string>): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg) continue;
    if (!arg.startsWith('--')) values.push(arg);
    else if (!arg.includes('=') && stringFlags.has(arg.slice(2))) index++;
  }
  return values;
}

function repeatableFlagValues(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg?.startsWith(`--${name}=`)) {
      const value = arg.slice(name.length + 3).trim();
      if (value) values.push(value);
    } else if (arg === `--${name}`) {
      const value = args[++index]?.trim();
      if (value && !value.startsWith('--')) values.push(value);
    }
  }
  return values;
}

async function readPrompt(flags: MediaGenerateFlags): Promise<string | null> {
  if (typeof flags.prompt === 'string' && flags.prompt) return flags.prompt;
  const promptFile = flags['prompt-file'];
  if (typeof promptFile !== 'string' || !promptFile) return null;
  if (promptFile !== '-') return readFile(promptFile, 'utf8');
  let buffer = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) buffer += chunk;
  return buffer;
}

function fail(code: number, message: string): never {
  console.error(message);
  process.exit(code);
}

function printHelp(): void {
  console.log(`Usage:
  od media generate --surface <image|video|audio> --model <id> [opts]
  od media wait <taskId> [--since <n>]

The sandbox bundle uses OD_DAEMON_URL, OD_TOOL_TOKEN, and OD_PROJECT_ID.
Generate accepts --prompt, --prompt-file, --output, --aspect, --quality,
--resolution, --length, --duration, --prompt-influence, --loop, --voice,
--language, --audio-kind, --composition-dir, and repeatable --image flags.`);
}
