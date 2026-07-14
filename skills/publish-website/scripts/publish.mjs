#!/usr/bin/env node
// Publish a project directory to the showcase wall as a hosted static site.
//
// Deterministic end-to-end: stage → zip → upload → persist ticket → report.
// Pure Node stdlib on purpose — no npm install, no browser, no `zip` binary
// (Alpine sandboxes ship none of them). The whole pipeline is here rather than
// in the SKILL.md prose so the agent cannot improvise a different zip layout,
// a different field set, or a fabricated URL.
//
// Usage:
//   node publish.mjs --project-dir <dir> --client-id <id> \
//                    --name <site name> --description <text> --author <who> \
//                    [--entry <page.html>]
//   node publish.mjs --status --project-dir <dir>
//
// Exit codes: 0 ok · 1 usage/local error · 2 upload rejected · 3 no entry page.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const API_BASE = process.env.OD_SHOWCASE_API || 'https://ugc-submit.showcase.monkeycode-ai.online';
// The ticket is what makes a re-publish UPDATE the existing site instead of
// littering the wall with duplicates. Kept inside the project so it survives
// across sessions (project files sync back), dot-prefixed and zip-excluded so
// it never reaches the published site or the user's file list.
const TICKET_FILE = '.showcase-publish.json';
const MAX_ZIP_BYTES = 200 * 1024 * 1024;
// Raw budget, enforced before any file is read into memory. Deliberately well
// under the sandbox's ~1GiB, since building the zip costs ~3x the raw size.
const MAX_RAW_BYTES = 150 * 1024 * 1024;

// Never publish source, secrets, or tooling to a public URL.
//
// Two tiers, because depth matters. Machine/tooling dirs can never be a web
// asset, so they are pruned at ANY depth. Project-layout dirs like `src` and
// `vendor` are only junk at the project ROOT — nested, they are very often real
// asset folders (`assets/src/hero.png`, `vendor/chart.js` referenced by the
// page), and pruning those silently ships a site with broken images.
const EXCLUDED_DIRS_ANY_DEPTH = new Set([
  '.git', '.od', '.od-skills', 'node_modules', '__pycache__', 'venv', '.venv',
  '.vscode', '.idea', '.cache', '.next',
]);
const EXCLUDED_DIRS_AT_ROOT = new Set(['src', 'vendor']);
const EXCLUDED_FILES = new Set([
  TICKET_FILE, '.DS_Store', 'package.json', 'package-lock.json',
  'pnpm-lock.yaml', 'yarn.lock', 'vite.config.js', 'vite.config.ts',
  'webpack.config.js', 'next.config.js',
]);
const EXCLUDED_RE = /(^\.env)|(\.log$)|(\.tsx?$)|(^tsconfig.*\.json$)/i;
// Artifacts the OTHER skills write into this same project directory
// (html-to-pptx, html-to-image, zip export). They are not part of the website,
// nobody links to them, and publishing them would put the user's source deck on
// a public URL and bloat the upload. Dropped, and reported so it is not silent.
const EXPORT_ARTIFACT_RE = /\.(pptx|zip)$/i;

function fail(reason, code = 1) {
  console.error(`error: ${reason}`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    if (key === 'status') { out.status = true; continue; }
    const val = argv[i + 1];
    if (val === undefined || val.startsWith('--')) fail(`--${key} needs a value`);
    out[key] = val;
    i += 1;
  }
  return out;
}

// --- zip writer (store + deflate), enough of PKZIP to be a valid archive ---

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function zipFrom(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    // Only pay for compression when it actually wins.
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30); // extra
    cd.writeUInt16LE(0, 32); // comment
    cd.writeUInt16LE(0, 34); // disk
    cd.writeUInt16LE(0, 36); // internal attrs
    cd.writeUInt32LE(0, 38); // external attrs
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, eocd]);
}

// --- staging ---

function collect(root) {
  const files = [];
  const dropped = [];
  let totalBytes = 0;
  const walk = (dir, rel) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const name = ent.name;
      const abs = path.join(dir, name);
      const relPath = rel ? `${rel}/${name}` : name;
      const atRoot = rel === '';
      if (ent.isDirectory()) {
        if (EXCLUDED_DIRS_ANY_DEPTH.has(name)) continue;
        if (atRoot && EXCLUDED_DIRS_AT_ROOT.has(name)) continue;
        walk(abs, relPath);
        continue;
      }
      if (!ent.isFile()) continue;
      if (EXCLUDED_FILES.has(name) || EXCLUDED_RE.test(name)) continue;
      // Only at the ROOT: that is where the sibling export skills drop their
      // .pptx/.zip. Nested, a .zip is very often a real download the page links
      // to (`assets/brand-kit.zip`), and dropping it would 404 the live site.
      if (atRoot && EXPORT_ARTIFACT_RE.test(name)) { dropped.push(relPath); continue; }
      // stat, not read: the size budget has to be enforced BEFORE anything is
      // pulled into memory (see runPublish).
      let size = 0;
      try { size = fs.statSync(abs).size; } catch { continue; }
      totalBytes += size;
      files.push({ name: relPath, abs, size });
    }
  };
  walk(root, '');
  return { files, dropped, totalBytes };
}

// The wall serves `<site>/` → the zip's top-level index.html. A project whose
// entry page is named something else still deserves to publish, so we rename it
// INSIDE the archive only — the user's own files are never touched.
function resolveEntry(files, explicit) {
  // An explicit --entry always wins. Checking index.html first would silently
  // discard it whenever a stale index.html happens to sit in the project — and
  // the troubleshooting table tells the agent to reach for --entry precisely in
  // the messy multi-page case.
  if (explicit) {
    // Tolerate the shapes an agent naturally types: "./report.html", a leading
    // slash, a different case. Failing those with "entry page not found" would
    // tell it the file does not exist — and the skill's stop rules say give up.
    const want = explicit.replace(/^\.?\//, '').toLowerCase();
    const hit = files.find((f) => f.name.toLowerCase() === want);
    if (!hit) fail(`entry page not found: ${explicit}`, 3);
    return hit.name === 'index.html' ? null : hit.name;
  }
  if (files.some((f) => f.name === 'index.html')) return null;
  const rootHtml = files.filter((f) => /^[^/]+\.html?$/i.test(f.name));
  if (rootHtml.length === 1) return rootHtml[0].name;
  if (rootHtml.length === 0) fail('no index.html (the project has no top-level HTML page)', 3);
  fail(
    `no index.html — several candidate pages (${rootHtml.map((f) => f.name).join(', ')}). ` +
    'Ask the user which one is the entry page and pass --entry <file.html>',
    3,
  );
  return null;
}

// Absent → never published, fine. Present but unreadable → STOP, and say why in
// terms of what the CALLER was doing. On the publish path, silently treating a
// corrupt ticket as "never published" would mint a SECOND showcase site and lose
// the only copy of the original's ticket forever. On the status path nothing is
// being published, so telling the user to delete the file would be terrible
// advice — it is the only thing that can still update their live site.
function readTicketFile(projectDir, { forPublish }) {
  const file = path.join(projectDir, TICKET_FILE);
  const consequence = forPublish
    ? 'refusing to publish, because that would create a SECOND site and orphan the existing one. ' +
      'Report this to the user; only they can decide to delete the file and publish anew'
    : 'cannot look up the review status without it. Report this to the user; do NOT delete the file — ' +
      'it is the only credential that can update the existing site';
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    fail(`cannot read ${TICKET_FILE} (${err?.message || err}) — ${consequence}`);
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed?.ticket) fail(`${TICKET_FILE} has no ticket — ${consequence}`);
    return parsed;
  } catch {
    fail(`${TICKET_FILE} is corrupt — ${consequence}`);
  }
  return null;
}

// --- api ---

async function postCreate(fields, zipBuf) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined && v !== null && String(v).length > 0) form.append(k, String(v));
  }
  form.append('site_zip_file', new Blob([zipBuf], { type: 'application/zip' }), 'dist.zip');

  let lastErr = '';
  // One retry, for network flakiness only — a 4xx is a verdict, not a blip.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let res;
    try {
      res = await fetch(`${API_BASE}/v1/create`, { method: 'POST', body: form });
    } catch (err) {
      lastErr = `network error (${err?.message || err})`;
      continue;
    }
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    const data = json?.data || {};
    if (!res.ok) {
      fail(`upload failed (HTTP ${res.status} ${data.message || text.slice(0, 200)})`, 2);
    }
    if (!data.site_url) {
      fail(`upload rejected (${data.message || 'server returned no site_url'})`, 2);
    }
    return data;
  }
  fail(`upload failed — ${lastErr}`, 2);
  return null;
}

async function runStatus(projectDir) {
  const saved = readTicketFile(projectDir, { forPublish: false });
  if (!saved?.ticket) fail('this project has not been published yet (no ticket on file)');
  const url = `${API_BASE}/v1/status?client_id=${encodeURIComponent(saved.clientId || '')}` +
    `&ticket=${encodeURIComponent(saved.ticket)}`;
  let res;
  try {
    res = await fetch(url);
  } catch (err) {
    fail(`network error (${err?.message || err})`);
    return;
  }
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = null; }
  if (!res.ok || !json?.data) fail(`status lookup failed (HTTP ${res.status} ${text.slice(0, 200)})`, 2);
  const d = json.data;
  const parts = [`status: ${d.status}`];
  if (d.takedown_reason) parts.push(`reason: ${d.takedown_reason}`);
  if (d.block_resubmit) parts.push('resubmit: blocked');
  if (saved.siteUrl) parts.push(`url: ${saved.siteUrl}`);
  console.log(parts.join('\n'));
}

async function runPublish(args) {
  const projectDir = path.resolve(args['project-dir'] || process.cwd());
  if (!fs.existsSync(projectDir)) fail(`project dir not found: ${projectDir}`);

  const clientId = args['client-id'];
  if (!clientId) fail('--client-id is required (the caller supplies it; never invent one)');

  // --meta-file is the path the skill mandates: the user's answers are arbitrary
  // text (quotes, $(...), backticks, newlines), and routing them through a shell
  // command line would let the shell re-interpret them. Read as a file and they
  // never touch a command line. The flags remain for manual/CLI use.
  let meta = { name: args.name, description: args.description, author: args.author };
  if (args['meta-file']) {
    try {
      const parsed = JSON.parse(fs.readFileSync(args['meta-file'], 'utf8'));
      meta = { name: parsed.name, description: parsed.description, author: parsed.author };
    } catch (err) {
      fail(`cannot read --meta-file ${args['meta-file']} (${err?.message || err})`);
    }
  }
  const name = typeof meta.name === 'string' ? meta.name.trim() : '';
  const description = typeof meta.description === 'string' ? meta.description.trim() : '';
  const author = (typeof meta.author === 'string' && meta.author.trim()) || 'anonymous';
  if (!name) fail('site name is required (--meta-file name, or --name)');
  if (!description) fail('site description is required (--meta-file description, or --description)');

  const { files, dropped, totalBytes } = collect(projectDir);
  if (files.length === 0) fail('project directory is empty (nothing to publish)');
  if (dropped.length > 0) {
    // Never silent: the user should know their .pptx/.zip exports stayed home.
    console.log(`excluded ${dropped.length} export artifact(s) from the site: ${dropped.join(', ')}`);
  }
  // Budget check BEFORE reading a single byte. Building the archive costs roughly
  // 3× the raw size in memory (raw buffers + deflated chunks + the concatenated
  // result), and this runs in a ~1GiB sandbox shared with the agent process — so
  // an oversized project must be refused here, not discovered by the OOM killer.
  if (totalBytes > MAX_RAW_BYTES) {
    fail(
      `project is too large to publish (${(totalBytes / 1048576).toFixed(1)} MB of files, ` +
      `limit ${(MAX_RAW_BYTES / 1048576).toFixed(0)} MB) — trim heavy assets (video, raw images) and retry`,
    );
  }
  const entry = resolveEntry(files, args.entry);

  const entries = files.map((f) => ({
    name: entry && f.name === entry ? 'index.html' : f.name,
    data: fs.readFileSync(f.abs),
  }));
  const zipBuf = zipFrom(entries);
  if (zipBuf.length > MAX_ZIP_BYTES) {
    fail(`site is too large (${(zipBuf.length / 1048576).toFixed(1)} MB zipped) — trim heavy assets and retry`);
  }
  if (!entries.some((e) => e.name === 'index.html')) fail('index.html is not at the zip top level', 3);

  console.log(`staged ${entries.length} files (${(zipBuf.length / 1024).toFixed(0)} KB)` +
    (entry ? `, entry page ${entry} → index.html` : ''));

  const saved = readTicketFile(projectDir, { forPublish: true });
  const data = await postCreate({
    client_id: clientId,
    kind: 'static',
    site_name: name,
    site_description: description,
    site_author: author,
    ticket: saved?.ticket,
  }, zipBuf);

  const ticket = data.ticket || saved?.ticket || '';
  if (ticket) {
    fs.writeFileSync(
      path.join(projectDir, TICKET_FILE),
      `${JSON.stringify({
        ticket,
        clientId,
        siteUrl: data.site_url,
        siteName: name,
      }, null, 2)}\n`,
    );
  }
  if (saved?.ticket && ticket && ticket !== saved.ticket) {
    console.log(`note: the server issued a new ticket (the old one no longer applies)`);
  }
  console.log(`ok: ${data.site_url}`);
}

const args = parseArgs(process.argv.slice(2));
try {
  if (args.status) await runStatus(path.resolve(args['project-dir'] || process.cwd()));
  else await runPublish(args);
} catch (err) {
  fail(err?.stack || err?.message || String(err));
}
