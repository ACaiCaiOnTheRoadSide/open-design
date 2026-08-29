import Database from 'better-sqlite3';
import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

type StartedServer = {
  url: string;
  server: Server;
  shutdown?: () => Promise<void> | void;
};

type CapturedHuskboxRequest = {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown>;
};

type RunEvent = { id: number; event: string; data: Record<string, unknown> };

const ENV_KEYS = [
  'OD_DATA_DIR',
  'OD_EXECUTION_TRANSPORT',
  'OD_HUSKBOX_BASE_URL',
  'OD_HUSKBOX_API_KEY',
  'OD_HUSKBOX_IMAGE',
  'OD_HUSKBOX_RETRY_MAX_ATTEMPTS',
] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

let daemon: StartedServer | null = null;
let huskbox: Server | null = null;
let dataDir: string | null = null;

afterEach(async () => {
  await stopServer(daemon);
  daemon = null;
  await stopServer(huskbox ? { url: '', server: huskbox } : null);
  huskbox = null;
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
  dataDir = null;
  for (const key of ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
}, 30_000);

it('[P0] runs OhMyAgent through the daemon, real Huskbox HTTP/SSE, JSONL parser, and persisted run events', async () => {
  const requests: CapturedHuskboxRequest[] = [];
  const fake = await startFakeHuskbox(requests);
  huskbox = fake.server;
  dataDir = await mkdtemp(join(tmpdir(), 'od-huskbox-ohmyagent-integration-'));
  await writeFile(join(dataDir, 'app-config.json'), JSON.stringify({
    agentId: 'ohmyagent',
    onboardingCompleted: true,
  }), 'utf8');

  process.env.OD_DATA_DIR = dataDir;
  process.env.OD_EXECUTION_TRANSPORT = 'huskbox';
  process.env.OD_HUSKBOX_BASE_URL = fake.url;
  process.env.OD_HUSKBOX_API_KEY = 'huskbox-secret';
  process.env.OD_HUSKBOX_IMAGE = 'registry.test/ohmyagent:v1';
  process.env.OD_HUSKBOX_RETRY_MAX_ATTEMPTS = '1';

  vi.resetModules();
  const { startServer } = await import('../src/server.js');
  daemon = await startServer({ port: 0, returnServer: true }) as StartedServer;

  const projectId = 'huskbox-ohmyagent-project';
  const createProject = await fetch(`${daemon.url}/api/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: projectId, name: 'Huskbox OhMyAgent integration' }),
  });
  expect(createProject.status).toBe(200);
  const conversationsResponse = await fetch(`${daemon.url}/api/projects/${projectId}/conversations`);
  expect(conversationsResponse.status).toBe(200);
  const conversations = await conversationsResponse.json() as { conversations: Array<{ id: string }> };
  const conversationId = conversations.conversations[0]?.id;
  expect(conversationId).toBeTruthy();

  const createRun = await fetch(`${daemon.url}/api/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agentId: 'ohmyagent',
      projectId,
      conversationId,
      message: 'Return the integration answer.',
    }),
  });
  expect(createRun.status).toBe(202);
  const { runId, assistantMessageId } = await createRun.json() as {
    runId: string;
    assistantMessageId: string;
  };

  const eventsResponse = await fetch(`${daemon.url}/api/runs/${runId}/events`, {
    headers: { accept: 'text/event-stream' },
  });
  expect(eventsResponse.status).toBe(200);
  const events = parseSse(await eventsResponse.text());

  expect(requests).toHaveLength(1);
  const request = requests[0]!;
  expect(request.method).toBe('POST');
  expect(request.url).toBe('/openapi/v1/executions/stream');
  expect(request.headers['x-huskbox-tenant-id']).toBeUndefined();
  expect(request.headers.authorization).toBe('Bearer huskbox-secret');
  expect(request.headers.accept).toBe('text/event-stream');
  expect(request.body).toEqual(expect.objectContaining({
    idempotency_key: expect.any(String),
    image: 'registry.test/ohmyagent:v1',
    cmd: expect.arrayContaining(['bash', 'ohmyagent', '--output-format', 'json']),
    env: expect.objectContaining({
      OD_DATA_DIR: '/workspace',
      OD_AGENT_CWD: `/workspace/projects/${projectId}`,
      OD_STDIN_LEN: expect.any(String),
    }),
    stdin: expect.stringContaining('Return the integration answer.'),
  }));
  expect(request.body).not.toHaveProperty('idempotencyKey');
  expect(request.body).not.toHaveProperty('inputWorkspaceURL');
  expect(request.body.cmd).not.toEqual(expect.stringContaining('Return the integration answer.'));

  expect(events).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: 'start', data: expect.objectContaining({ agentId: 'ohmyagent' }) }),
    expect.objectContaining({ event: 'agent', data: expect.objectContaining({
      type: 'status', label: 'running', sessionId: 'oma-session-real-http',
    }) }),
    expect.objectContaining({ event: 'agent', data: { type: 'text_delta', delta: 'integration answer' } }),
    expect.objectContaining({ event: 'agent', data: expect.objectContaining({
      type: 'usage', usage: { input_tokens: 11, output_tokens: 3 },
    }) }),
    expect.objectContaining({ event: 'agent', data: expect.objectContaining({ type: 'status', label: 'turn_done' }) }),
    expect.objectContaining({ event: 'end', data: expect.objectContaining({ status: 'succeeded', code: 0 }) }),
  ]));

  const statusResponse = await fetch(`${daemon.url}/api/runs/${runId}`);
  expect(statusResponse.status).toBe(200);
  const status = await statusResponse.json() as Record<string, any>;
  expect(status).toMatchObject({
    id: runId,
    agentId: 'ohmyagent',
    status: 'succeeded',
    exitCode: 0,
    nativeSessionRecovery: {
      agentId: 'ohmyagent',
      state: 'captured_not_resumed',
      acquisition: 'none',
      continuation: 'none',
      handle: { present: true, redacted: true },
    },
  });

  const messagesResponse = await fetch(
    `${daemon.url}/api/projects/${projectId}/conversations/${conversationId}/messages`,
  );
  expect(messagesResponse.status).toBe(200);
  const messagesBody = await messagesResponse.json() as {
    messages: Array<{ id: string; content: string; events?: unknown[]; runStatus?: string }>;
  };
  expect(messagesBody.messages).toContainEqual(expect.objectContaining({
    id: assistantMessageId,
    content: 'integration answer',
    runStatus: 'succeeded',
    events: expect.arrayContaining([expect.objectContaining({ kind: 'text', text: 'integration answer' })]),
  }));

  const db = new Database(join(dataDir, 'app.sqlite'), { readonly: true });
  try {
    expect(db.prepare(
      'SELECT agent_id AS agentId, session_id AS sessionId FROM agent_sessions WHERE conversation_id = ?',
    ).get(conversationId)).toBeUndefined();
  } finally {
    db.close();
  }

  expect(request.body.cmd).not.toContain('--resume');

  const persisted = (await readFile(join(dataDir, 'runs', runId, 'events.jsonl'), 'utf8'))
    .trim().split('\n').map((line) => JSON.parse(line) as RunEvent);
  expect(persisted).toEqual(expect.arrayContaining([
    expect.objectContaining({ event: 'agent', data: { type: 'text_delta', delta: 'integration answer' } }),
    expect.objectContaining({ event: 'agent', data: expect.objectContaining({
      type: 'usage', usage: { input_tokens: 11, output_tokens: 3 },
    }) }),
    expect.objectContaining({ event: 'end', data: expect.objectContaining({ status: 'succeeded' }) }),
  ]));
}, 60_000);

async function startFakeHuskbox(requests: CapturedHuskboxRequest[]): Promise<{ url: string; server: Server }> {
  const server = http.createServer(async (req, res) => {
    const raw = await readRequest(req);
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
      body: JSON.parse(raw) as Record<string, unknown>,
    });
    if (req.method !== 'POST' || req.url !== '/openapi/v1/executions/stream') {
      res.writeHead(404).end();
      return;
    }
    writeSseHeaders(res);
    sendSse(res, 'started', { id: 'husk-exec-1', status: 'running' });
    const jsonl = [
      { type: 'model_start', session_id: 'oma-session-real-http', turn_id: 'turn-1', data: {} },
      { type: 'model_delta', session_id: 'oma-session-real-http', turn_id: 'turn-1', data: { text: 'integration answer' } },
      { type: 'model_done', session_id: 'oma-session-real-http', turn_id: 'turn-1', data: { text: 'integration answer' } },
      { type: 'usage', session_id: 'oma-session-real-http', turn_id: 'turn-1', data: { input_tokens: 11, output_tokens: 3 } },
      { type: 'turn_done', session_id: 'oma-session-real-http', turn_id: 'turn-1', data: {} },
    ].map((event) => JSON.stringify(event)).join('\n') + '\n';
    sendSse(res, 'stdout', { id: 'husk-exec-1', data: jsonl });
    sendSse(res, 'completed', { id: 'husk-exec-1', status: 'succeeded', exit_code: 0, timed_out: false });
    res.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fake Huskbox did not bind TCP');
  return { url: `http://127.0.0.1:${address.port}`, server };
}

function readRequest(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => resolve(raw));
    req.on('error', reject);
  });
}

function writeSseHeaders(res: ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
}

function sendSse(res: ServerResponse, event: string, data: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function parseSse(body: string): RunEvent[] {
  return body.split('\n\n').flatMap((frame) => {
    const event = frame.match(/^event: (.+)$/mu)?.[1];
    const id = Number(frame.match(/^id: (.+)$/mu)?.[1]);
    const data = frame.match(/^data: (.+)$/mu)?.[1];
    return event && data ? [{ id, event, data: JSON.parse(data) as Record<string, unknown> }] : [];
  });
}

async function stopServer(started: StartedServer | null): Promise<void> {
  if (!started) return;
  await Promise.resolve(started.shutdown?.());
  started.server.closeAllConnections?.();
  started.server.closeIdleConnections?.();
  if (started.server.listening) {
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
  }
}
