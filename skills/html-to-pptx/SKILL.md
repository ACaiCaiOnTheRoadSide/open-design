---
name: html-to-pptx
description: |
  Export an HTML slide deck from the current project to a downloadable .pptx
  using headless Chromium — for web/sandbox runtimes where the built-in desktop
  PPTX export is unavailable. Renders each slide to a pixel-perfect PNG and
  assembles a one-image-per-slide PowerPoint file inside the project directory
  so it appears in the user's file list. Use when the user asks to export or
  convert an HTML deck to PPTX/PowerPoint and there is no desktop renderer.
triggers:
  - "export pptx"
  - "导出 pptx"
  - "导出 ppt"
  - "html 转 pptx"
  - "convert to powerpoint"
  - "html-to-pptx"
od:
  mode: utility
  scenario: engineering
---

# HTML → PPTX (headless Chromium)

Deterministic screenshot-based PPTX export for environments without the desktop
(Electron) renderer. The bundled script ports the desktop export semantics
(slide detection, presenter-chrome hiding, stage measurement, per-slide paging)
to Playwright, then assembles the deck with PptxGenJS.

**Follow the steps below exactly. Do NOT improvise your own conversion** (no
hand-written python-pptx layouts, no drawing replacement SVGs). If a step
fails, report the actual error to the user instead of fabricating a result.
If the same command fails the same way twice, stop and report — do not keep
retrying it.

## Preconditions

- The target file is an HTML deck in the project directory (slides marked by
  `.slide`, `[data-screen-label]`, `.deck-slide`, or `.ppt-slide` — the script
  verifies this and exits with code 4 if the file is not a deck).
- If the user did not name a file and the project has more than one HTML deck,
  ask which one to export.

## Step 1 — set up a workspace OUTSIDE the project directory

Dependencies must never land in the project directory (everything in the
project directory syncs back to the user as artifacts — `node_modules` there
would pollute the user's file list).

```bash
WORKDIR=/tmp/od-pptx-export
mkdir -p "$WORKDIR" && cd "$WORKDIR"
export PLAYWRIGHT_BROWSERS_PATH="$WORKDIR/browsers"
# China-network mirrors; harmless elsewhere. Drop them only if they 404.
export PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright
[ -f package.json ] || npm init -y >/dev/null
npm i --registry=https://registry.npmmirror.com playwright pptxgenjs
npx playwright install chromium-headless-shell || npx playwright install chromium
```

Skip installs that are already present (`$WORKDIR` persists within a session —
re-running the export must not re-download Chromium).

## Step 2 — get the render script into the workspace

The script ships with this skill at `scripts/render-pptx.mjs`. Copy it from
the skill root advertised in the skill preamble — in staged runtimes that is
`.od-skills/html-to-pptx/` inside the project working directory, otherwise
use the absolute skill-root path from the preamble:

```bash
cp <skill-root>/scripts/render-pptx.mjs "$WORKDIR/"
```

If NEITHER skill-root path exists on the local filesystem, STOP and report
that the skill files were not synced into this workspace. Do not try to fetch
the script over the network (sandbox runtimes have no daemon credentials —
those requests fail with `API_TOKEN_REQUIRED` no matter how they are retried)
and do not write a replacement script from memory.

The script must live in `$WORKDIR` so its `playwright`/`pptxgenjs` imports
resolve against the workspace `node_modules`.

## Step 3 — render

```bash
NODE_OPTIONS=--max-old-space-size=256 \
node "$WORKDIR/render-pptx.mjs" "<project-dir>/<deck>.html" "<project-dir>/<deck-title>.pptx"
```

Keep the `NODE_OPTIONS` cap — sandbox runtimes limit the whole container to
~1GiB shared by your own process, this script, and Chromium; an uncapped Node
heap invites the OOM killer.

- The output path MUST be inside the project directory — that is what makes it
  sync back and appear in the user's file list.
- Name the .pptx after the deck's human title when known, not the raw filename.
- The script logs `slide N/M captured` progress and a final `ok:` line with
  slide count and per-phase timings.

## Step 4 — verify and report

1. Confirm the `.pptx` exists in the project directory and is non-trivial
   (`ls -la`; a real deck is at least tens of KB).
2. Confirm the slide count in the `ok:` line matches the deck.
3. Tell the user the export is done and the file name to look for in the
   project file list. Include the slide count.

## Troubleshooting

- **Process reports `Killed` (exit code 137)**: the sandbox hit its memory
  limit (~1GiB for everything in the container). Do NOT retry in a loop.
  First kill any leftover processes from earlier attempts
  (`pkill -f headless_shell; pkill -f render-pptx` — ignore errors), then
  retry ONCE. If it is killed again, stop and tell the user the export needs
  more sandbox memory than this environment provides.
- **Browser download fails / hangs**: try without the mirror env vars; if the
  sandbox provides an HTTP proxy (`HTTPS_PROXY`), keep it exported for both
  `npm i` and `playwright install`.
- **Chromium fails to launch with missing shared libraries**: run
  `npx playwright install-deps chromium` (needs root/apt). If that is
  unavailable, report the missing libraries to the user — do not silently
  produce a different artifact.
- **Exit code 4 (`no slide surfaces found`)**: the file is not a deck. Tell
  the user PPTX export needs a slide-based document; offer image/PDF export of
  the page instead.
- **Relative assets missing in the capture** (rare): serve the project
  directory (`python3 -m http.server` or `npx serve`) and pass an
  `http://127.0.0.1:<port>/<deck>.html` URL to the script instead of the file
  path.
