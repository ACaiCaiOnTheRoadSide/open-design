---
name: publish-website
description: |
  Publish the current project's design artifact to the public showcase wall as
  a hosted static site. Packages the project directory (index.html at the top
  level) into a zip and uploads it over multipart to the showcase API, then
  reports the live URL back to the user. The site is publicly visible after the
  showcase administrators approve it. Re-publishing the same project updates
  the existing site instead of creating a second one. Use when the user asks to
  publish / 发布 / 上线 an artifact to the showcase (案例墙).
triggers:
  - "publish to showcase"
  - "发布到 showcase"
  - "发布到案例墙"
  - "发布网站"
  - "publish-website"
od:
  mode: utility
  scenario: engineering
---

# Publish → showcase (static site)

Package a finished design artifact and upload it to the showcase wall, where it
is hosted as a real website at a public URL.

**Follow the steps below exactly. Do NOT improvise.** Do not invent a
`client_id` or a `ticket`, do not hand-roll the zip layout or the curl call
(the bundled script encodes both), and do not report a URL you did not receive
from the server. If a step fails, report the actual error to the user instead
of claiming the site was published. If the same command fails the same way
twice, stop and report — do not keep retrying it.

## What the caller gives you

The publish request carries **only the client id** (`--client-id "od-<...>"`).
Use it verbatim; never invent one. Everything else you ask the user for, once,
in Step 1.

## Preconditions

- The project directory is published **whole**, as a static site. The
  top level must therefore contain an `index.html` — that is the site's entry
  page.
- If there is no top-level `index.html`:
  - exactly one HTML file in the project → the script promotes it to
    `index.html` inside its staging copy (your project files are never
    renamed);
  - several HTML files and no `index.html` → **stop** and ask the user which
    page should be the entry page. Do not guess.

## Step 1 — ask for the site metadata (ONE form, once)

Emit exactly **one** `<question-form>` — all fields together. Do **not** ask
field-by-field, do not ask in prose, and do not ask again on a later turn once
you have the answers.

The user has *already* accepted the public-visibility notice in the host's
confirm dialog before this run started — the form repeats it as a reminder, but
consent is not yours to obtain and not yours to skip.

Seed every `defaultValue` from the artifact's **real content** (the entry page's
`<title>`, `<h1>`, first-screen copy; a README's opening line). Never invent a
description the page does not support — if you truly cannot infer one, leave
`defaultValue` empty and let the user write it.

Write the form's user-facing text in the UI locale of this run.

```
<question-form id="publish" title="发布到案例墙" submitLabel="发布">
{
  "description": "发布后由管理员审核,通过后会在公开案例墙上展示,任何人都能访问。",
  "questions": [
    { "id": "site_name", "label": "作品名称", "type": "text",
      "defaultValue": "<inferred from the artifact>", "required": true },
    { "id": "site_description", "label": "一句话介绍", "type": "text",
      "placeholder": "这个作品是做什么的?",
      "defaultValue": "<inferred from the artifact>", "required": true },
    { "id": "site_author", "label": "作者", "type": "text",
      "placeholder": "匿名", "defaultValue": "" }
  ]
}
</question-form>
```

Emit the complete block in assistant text and end your turn — the host renders
it and the answers come back as the next user message (`[form answers — publish]`).
An empty `site_author` means `anonymous`.

## Step 2 — prepare the workspace (ONE bundled script — run it, don't re-derive it)

The publish script packs the site with `jszip`, so it needs a workspace with
that dependency installed. That is one bundled script — **no browser, nothing
like the export skills' Chromium dance**:

```bash
sh <skill-root>/scripts/setup-env.sh
```

It creates `/tmp/od-publish` **outside** the project directory (anything inside
the project syncs back into the user's file list — node_modules must never land
there), installs `jszip` from npmmirror, and is idempotent. It finishes with an
`ok:` line.

Do NOT substitute your own setup — no `apk add zip`, no hand-rolled archive, no
`npm i` somewhere else.

## Step 3 — publish

One bundled script does the rest — staging, dev-file exclusion, zip layout
check, upload, response parsing, ticket bookkeeping.

First put the user's three answers in a JSON file, **using your file-writing
tool — not a shell command**:

```json
// /tmp/od-publish/meta.json
{ "name": "<site_name>", "description": "<site_description>", "author": "<site_author>" }
```

Then copy the script into the workspace and run it **from there** — that is
where `node_modules` lives, so that is the only place its `jszip` import
resolves:

```bash
WORKDIR=/tmp/od-publish
cp <skill-root>/scripts/publish.mjs "$WORKDIR/"
node "$WORKDIR/publish.mjs" \
  --project-dir "<project-dir>" \
  --client-id "<client_id>" \
  --meta-file "$WORKDIR/meta.json"
```

> **Why the file, and why not `echo`/heredoc:** the user's text is arbitrary —
> quotes, `$(...)`, backticks, newlines. Passing it through a shell command line
> would let it be re-interpreted by the shell. Writing it with your file tool and
> handing the script a path means the text never touches a command line at all.
> The `--name` / `--description` / `--author` flags still exist for manual use,
> but **you must use `--meta-file`.**

`<skill-root>` is the path advertised in the skill preamble — in staged
runtimes that is `.od-skills/publish-website/` inside the project working
directory. If that path does not exist on the local filesystem, STOP and report
that the skill files were not synced into this workspace. Do not fetch the
script over the network (sandbox runtimes have no daemon credentials — those
requests fail with `API_TOKEN_REQUIRED` no matter how they are retried) and do
not write a replacement script from memory.

What the publish script does, so you don't have to:

- builds the archive with jszip, renaming a lone non-`index.html` entry page to
  `index.html` **inside the zip only** — the user's own files are never renamed;
- excludes source and junk that must never reach a public site: `.git`,
  `.od`, `.od-skills`, `node_modules`, `.env*`, lockfiles, `src/`, TS/config
  files, and the skill's own ticket file;
- verifies `index.html` really is at the zip's top level before uploading;
- reuses the **ticket** stored at `<project-dir>/.showcase-publish.json` when
  the project was published before, so a re-publish **updates the same site**
  rather than creating a duplicate — and writes the ticket back after a
  successful upload. Never edit or delete that file by hand.
- retries the upload once on network failure, then gives up.

The script prints its result as the last line:

- `ok: <site_url>` — published; the exit code is 0.
- `error: <reason>` — nothing was published; the exit code is non-zero.

## Step 4 — report

On `ok:`, tell the user, with the URL **on its own line as a plain clickable
link** (never inside a code block):

```
已发布到 showcase 案例墙:

<site_url>

上线前需要 showcase 管理员审核通过,审核期间链接可能还打不开。想知道审核状态随时问我。
```

Mention that re-publishing this project later updates the same page (the
ticket is remembered), so they don't need to keep track of anything.

On `error:`, report the reason the script printed, verbatim. **Do not** fabricate
a URL, do not claim a pending review, and do not present a local file path as if
it were the published site.

## Checking the review status (only when the user asks)

Never poll this — call it only when the user asks about review/上线 status:

```bash
node /tmp/od-publish/publish.mjs --status --project-dir "<project-dir>"
```

It reads the stored ticket and prints one of `pending_review`, `online`,
`offline`, `rejected`, plus the admin's reason when there is one. Relay it:

- `pending_review` → 应用已提交,审核中。
- `online` → 审核通过,已上线:`<site_url>`
- `rejected` → 审核未通过。+ the reason if the server gave one (if it gave
  none, say the admin did not fill one in — do not speculate).
- `offline` → 应用已下线。+ the reason if the server gave one.

## Troubleshooting

| Symptom | What it means / what to do |
|---|---|
| `error: no index.html` | Several HTML files, none named `index.html`. Ask the user which page is the entry page, then re-run with `--entry <file.html>`. |
| `error: upload failed (HTTP 403 resubmit_blocked)` | The showcase admins blocked this client from submitting again. Report it; do not retry, and do not work around it with a different client id. |
| `error: upload failed (HTTP 4xx …)` | Relay the server's message. A 4xx is a rejected submission, not a network blip — do not retry. |
| `error: curl not available` | Report it; the sandbox cannot reach the network. Do not substitute wget-from-memory. |
| Script missing from the skill root | The skill was not synced into the workspace. Report it; do not reconstruct the script. |
