---
name: html-to-image
description: |
  Export an HTML page from the current project to a downloadable full-page
  image (png/jpeg/webp) or PDF using headless Chromium — for web/sandbox runtimes
  where the built-in desktop image export is unavailable. An ordinary page
  becomes ONE full-page screenshot (the whole scrollable document, never just
  the visible viewport); a slide deck becomes one long image with every slide
  stitched top-to-bottom. The image is written inside the project directory so
  it appears in the user's file list. Use when the user asks to export an HTML
  artifact as an image/screenshot and there is no desktop renderer.
triggers:
  - "export as image"
  - "导出图片"
  - "导出为图片"
  - "html 转图片"
  - "整页截图"
  - "html-to-image"
  - "导出 pdf"
  - "export pdf"
od:
  mode: utility
  scenario: engineering
---

# HTML → image (headless Chromium)

Deterministic full-page image export for environments without the desktop
(Electron) renderer. The bundled script ports the desktop export semantics
(full-document capture, slide detection, presenter-chrome hiding, stage
measurement, per-slide paging, vertical stitching) to Playwright.

What it produces — ALWAYS the whole artifact, never a partial view:

- **Ordinary page**: one full-page screenshot, top of the document to the
  bottom of the scrollable content.
- **Slide deck** (`<deck-stage>` / `[data-screen-label]` / `.deck-slide` /
  `.ppt-slide`, or `.slide` with deck structure): every slide captured
  pixel-perfect and stitched vertically into one long image.

Formats: `png` (default), `jpeg`, `webp`, `pdf` — pass the one the user chose. PDF exports an ordinary page completely (paginated when necessary) and preserves each deck slide as its own PDF page.

**Follow the steps below exactly. Do NOT improvise your own conversion OR
your own environment setup.** No hand-drawn replacement SVGs, no partial
viewport screenshots passed off as the export, no re-implementing the capture
with your own Playwright driver. Environment prep is likewise NOT yours to
re-derive: run the bundled `setup-env.sh` (Step 1), never your own browser
install. If a step fails, report the actual error to the user instead of
fabricating a result. If the same command fails the same way twice, stop and
report — do not keep retrying it.

## Preconditions

- The target file is an HTML file in the project directory (any HTML works —
  page or deck; the script picks the capture mode itself).
- If the user did not name a file and the project has more than one HTML file,
  ask which one to export.

## Step 1 — prepare the environment (ONE bundled script — run it, don't re-derive it)

Workspace creation, npm dependencies, and browser acquisition are a single
script that ships with this skill:

```bash
sh <skill-root>/scripts/setup-env.sh
```

`<skill-root>` is the path advertised in the skill preamble — in staged
runtimes that is `.od-skills/html-to-image/` inside the project working
directory.

What it does (so you don't have to): creates `${TMPDIR:-/tmp}/od-pptx-export` OUTSIDE
the project directory (the workspace is deliberately SHARED with the
html-to-pptx skill, so a session that already exported a .pptx reuses the
same browser download), installs the npm dependencies, then picks the ONLY
browser branch that can work on this system — on musl (Alpine) sandboxes it
downloads a prebuilt self-contained musl Chromium bundle (~320MB, sha256
verified, once per session); on glibc systems it uses Playwright's own
browser; when a system chromium exists it uses that. It finishes with an
`ok:` line and writes `${TMPDIR:-/tmp}/od-pptx-export/env.sh`, which every later command
MUST source (shell state does not survive between your commands).

Do NOT substitute your own environment setup for this script — no
`apk add`/`apt install`, no bare `npx playwright install`, no Chromium from
anywhere else. On Alpine, Playwright's glibc browser can NEVER run (`Error
relocating ...`) no matter what dependencies are added; the musl-vs-glibc
decision is encoded in the script so it cannot be gotten wrong. The script
is idempotent — re-running it after a network failure is safe and skips
everything already downloaded.

If `scripts/setup-env.sh` is missing from the skill root, STOP and report
that the skill files were not synced into this workspace — do not
reconstruct it from memory.

## Step 2 — get the render script into the workspace

The script ships with this skill at `scripts/render-image.mjs`. Copy it from
the skill root advertised in the skill preamble — in staged runtimes that is
`.od-skills/html-to-image/` inside the project working directory, otherwise
use the absolute skill-root path from the preamble:

```bash
WORKDIR=${TMPDIR:-/tmp}/od-pptx-export
cp <skill-root>/scripts/render-image.mjs "$WORKDIR/"
```

If NEITHER skill-root path exists on the local filesystem, STOP and report
that the skill files were not synced into this workspace. Do not try to fetch
the script over the network (sandbox runtimes have no daemon credentials —
those requests fail with `API_TOKEN_REQUIRED` no matter how they are retried)
and do not write a replacement script from memory.

The script must live in `$WORKDIR` so its `playwright` import resolves
against the workspace `node_modules`.

## Step 3 — render

```bash
. ${TMPDIR:-/tmp}/od-pptx-export/env.sh && NODE_OPTIONS=--max-old-space-size=256 \
node ${TMPDIR:-/tmp}/od-pptx-export/render-image.mjs [--deck] --format <png|jpeg|webp|pdf> \
  "<project-dir>/<page>.html" "<project-dir>/<page-title>-整页图.<png|jpg|webp|pdf>"
```

- Pass `--format` with exactly the format the user chose (default `png` when
  unspecified). `--quality 1-100` tunes jpeg/webp compression (default 92).
  For PDF use a `.pdf` output name (the `-整页图` marker is optional).
- When the export request says the viewer identified the artifact as a deck,
  pass `--deck`. This authoritative signal prevents a deck whose DOM does not
  satisfy the conservative auto-detection heuristic from degrading to a
  first-slide-only ordinary-page screenshot.
- The output path MUST be inside the project directory — that is what makes it
  sync back and appear in the user's file list.
- Name the image after the page's human title when known, not the raw
  filename, and keep the `-整页图` marker (use `-full-page` instead when the
  title is not Chinese) so re-exports in another format never collide.
- An image exported earlier (or in another format) already sitting in the
  project directory does NOT satisfy the current request; run the render for
  the requested format every time.
- Always source `env.sh` in the same command — the browser location, library
  path, and font config from Step 1 live there, and shell state does not
  carry over between your commands. Keep the `NODE_OPTIONS` cap — sandbox
  runtimes limit the whole container to ~1GiB shared by your own process,
  this script, and Chromium; an uncapped Node heap invites the OOM killer.
- For decks the script logs `slide N/M captured` progress; both modes finish
  with a final `ok:` line carrying the output dimensions and timings.

## Step 4 — verify and report

1. Confirm the image exists in the project directory and is non-trivial
   (`ls -la`; a real page capture is at least tens of KB).
2. Confirm the `ok:` line's dimensions are sane (a full page is usually much
   taller than 1080px; a deck reports `N slides`).
3. Tell the user the export is done and the exact file name to look for in
   the project file list. Include the pixel dimensions (and slide count for
   decks).

## Troubleshooting

- **Process reports `Killed` (exit code 137)**: the sandbox hit its memory
  limit (~1GiB for everything in the container). Do NOT retry in a loop.
  First kill any leftover processes from earlier attempts
  (`pkill -f headless_shell; pkill -f render-image` — ignore errors), then
  retry ONCE. If it is killed again, stop and tell the user the export needs
  more sandbox memory than this environment provides.
- **Browser download fails / hangs**: re-run `sh <skill-root>/scripts/setup-env.sh`
  ONCE (it is idempotent and resumes where it left off). If the Playwright
  mirror 404s on a glibc system, disable it for that re-run:
  `PLAYWRIGHT_DOWNLOAD_HOST= sh <skill-root>/scripts/setup-env.sh`. If the
  sandbox provides an HTTP proxy (`HTTPS_PROXY`), keep it exported when
  running the script.
- **Chromium fails to launch with missing shared libraries / `Error
  relocating`**: `Error relocating` means a glibc browser is being run on a
  musl (Alpine) system — installing dependencies can never fix that. Either
  the environment was set up by hand instead of by the bundled script, or the
  system ships a broken chromium on PATH that the script trusted. Run
  `OD_PPTX_FORCE_BUNDLE=1 sh <skill-root>/scripts/setup-env.sh` (ignores any
  system chromium and installs the known-good browser for this libc) and
  render again via `env.sh`. On glibc systems you may try
  `npx playwright install-deps chromium` (needs root/apt). Never silently
  produce a different artifact.
- **Bundle download fails (URL unreachable / checksum mismatch after
  retries)**: re-run `setup-env.sh` ONCE (a partial download resumes instead
  of restarting). If it fails again, switch the SAME script to its userspace
  apk branch (`apk fetch` only downloads — no root needed):

  ```bash
  OD_PPTX_APK_FALLBACK=1 sh <skill-root>/scripts/setup-env.sh
  ```

  If BOTH paths fail, STOP and report — do not try Playwright's glibc
  browser on Alpine.
- **Output uses wrong/fallback fonts while layout is otherwise correct**: the
  page references remote webfonts (e.g. fonts.googleapis.com) that this
  sandbox cannot reach. The script forwards `HTTPS_PROXY` to Chromium
  automatically when set. If fonts still fall back, finish the export and
  tell the user the page's webfonts were unreachable from the sandbox, so
  system fonts were substituted — do not treat this as a failure.
- **PDF export**: PDF is not subject to the single-image side/area limit. For decks the script emits one slide per PDF page; ordinary long pages are paginated by Chromium.
- **Exit code 7 (`output image would exceed encoder limits`)**: read the
  error message — it names which limit was hit. If it names WebP's 16383px
  format limit, the artifact CAN still export as png/jpeg: tell the user webp
  cannot hold a page this tall and ask (or fall back per their instruction)
  to png. For the generic side/area limits the page or deck is too large for
  one image in any format — do not chop the page into pieces on your own;
  tell the user a single-image export is not possible for this artifact and
  offer PDF export instead.
- **Relative assets missing in the capture** (rare): serve the project
  directory (`python3 -m http.server` or `npx serve`) and pass an
  `http://127.0.0.1:<port>/<page>.html` URL to the script instead of the file
  path.
