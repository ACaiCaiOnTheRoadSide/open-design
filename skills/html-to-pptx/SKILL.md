---
name: html-to-pptx
description: |
  Export an HTML slide deck from the current project to a downloadable .pptx
  using headless Chromium — for web/sandbox runtimes where the built-in desktop
  PPTX export is unavailable. Two modes: screenshot (default — each slide as a
  pixel-perfect PNG, one image per slide) and editable (--editable — native
  PowerPoint text/shapes via the bundled dom-to-pptx engine). The .pptx is
  written inside the project directory so it appears in the user's file list.
  Use when the user asks to export or convert an HTML deck to PPTX/PowerPoint
  and there is no desktop renderer.
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

Deterministic PPTX export for environments without the desktop (Electron)
renderer. The bundled script ports the desktop export semantics (slide
detection, presenter-chrome hiding, stage measurement, per-slide paging, the
dom-to-pptx editable handoff) to Playwright.

Two modes — use the one the user asked for (default to screenshot when
unspecified):

- **Screenshot (default)**: each slide captured as a pixel-perfect PNG,
  assembled one-image-per-slide with PptxGenJS. Exact visual fidelity; the
  slides are pictures, not editable text.
- **Editable (`--editable`)**: the script injects the dom-to-pptx browser
  engine (ships with this skill under `assets/`) and emits native PowerPoint
  shapes/text — users can edit the result in PowerPoint. Layout fidelity on
  exotic CSS is lower than screenshot mode.

**Follow the steps below exactly. Do NOT improvise your own conversion OR
your own environment setup.** No hand-written python-pptx layouts, no drawing
replacement SVGs, and NEVER drive `assets/dom-to-pptx.bundle.js.gz` with your
own script — the engine only sees text that render-pptx.mjs's slide-reveal
prep has made visible; a hand-rolled driver produces a .pptx of empty
background shapes. Environment prep is likewise NOT yours to re-derive: run
the bundled `setup-env.sh` (Step 1), never your own browser install. If a
step fails, report the actual error to the user instead of fabricating a
result. If the same command fails the same way twice, stop and report — do
not keep retrying it.

## Preconditions

- The target file is an HTML deck in the project directory (slides marked by
  `.slide`, `[data-screen-label]`, `.deck-slide`, or `.ppt-slide` — the script
  verifies this and exits with code 4 if the file is not a deck).
- If the user did not name a file and the project has more than one HTML deck,
  ask which one to export.

## Step 1 — prepare the environment (ONE bundled script — run it, don't re-derive it)

Workspace creation, npm dependencies, and browser acquisition are a single
script that ships with this skill:

```bash
sh <skill-root>/scripts/setup-env.sh
```

`<skill-root>` is the path advertised in the skill preamble — in staged
runtimes that is `.od-skills/html-to-pptx/` inside the project working
directory.

What it does (so you don't have to): creates `/tmp/od-pptx-export` OUTSIDE
the project directory (dependencies in the project dir would sync back into
the user's file list), installs `playwright`/`pptxgenjs`, then picks the ONLY
browser branch that can work on this system — on musl (Alpine) sandboxes it
downloads a prebuilt self-contained musl Chromium bundle (~320MB, sha256
verified, once per session); on glibc systems it uses Playwright's own
browser; when a system chromium exists it uses that. It finishes with an
`ok:` line and writes `/tmp/od-pptx-export/env.sh`, which every later command
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

The script ships with this skill at `scripts/render-pptx.mjs`, and the
editable-mode engine at `assets/dom-to-pptx.bundle.js.gz`. Copy them from
the skill root advertised in the skill preamble — in staged runtimes that is
`.od-skills/html-to-pptx/` inside the project working directory, otherwise
use the absolute skill-root path from the preamble:

```bash
WORKDIR=/tmp/od-pptx-export
cp <skill-root>/scripts/render-pptx.mjs "$WORKDIR/"
cp <skill-root>/assets/dom-to-pptx.bundle.js.gz "$WORKDIR/"   # editable mode only
```

If NEITHER skill-root path exists on the local filesystem, STOP and report
that the skill files were not synced into this workspace. Do not try to fetch
the script over the network (sandbox runtimes have no daemon credentials —
those requests fail with `API_TOKEN_REQUIRED` no matter how they are retried)
and do not write a replacement script from memory.

The script must live in `$WORKDIR` so its `playwright`/`pptxgenjs` imports
resolve against the workspace `node_modules`; the engine bundle must sit next
to the script (the script also finds it via `<skill-root>/assets/` when run
in place).

## Step 3 — render

```bash
# screenshot mode (default)
. /tmp/od-pptx-export/env.sh && NODE_OPTIONS=--max-old-space-size=256 \
node /tmp/od-pptx-export/render-pptx.mjs "<project-dir>/<deck>.html" "<project-dir>/<deck-title>-截图版.pptx"

# editable mode (native text/shapes — only when the user chose it)
. /tmp/od-pptx-export/env.sh && NODE_OPTIONS=--max-old-space-size=256 \
node /tmp/od-pptx-export/render-pptx.mjs --editable "<project-dir>/<deck>.html" "<project-dir>/<deck-title>-可编辑版.pptx"
```

The two modes are DIFFERENT artifacts and their filenames MUST stay distinct:
always append the mode marker to the output name — `-截图版` for screenshot
mode, `-可编辑版` for editable mode (use `-screenshot` / `-editable` instead
when the deck title is not Chinese). A .pptx from the OTHER mode (or from an
earlier run) already sitting in the project directory does NOT satisfy the
current request — never point at an existing file and report the export as
done; run the render for the requested mode every time.

Always source `env.sh` in the same command — the browser location, library
path, and font config from Step 1 live there, and shell state does not carry
over between your commands. Keep the `NODE_OPTIONS` cap — sandbox runtimes
limit the whole container to ~1GiB shared by your own process, this script,
and Chromium; an uncapped Node heap invites the OOM killer.

- The output path MUST be inside the project directory — that is what makes it
  sync back and appear in the user's file list.
- Name the .pptx after the deck's human title when known, not the raw filename,
  and always keep the mode marker suffix described above.
- The script logs `slide N/M captured` progress and a final `ok:` line with
  slide count and per-phase timings.

## Step 4 — verify and report

1. Confirm the `.pptx` exists in the project directory and is non-trivial
   (`ls -la`; a real deck is at least tens of KB).
2. Confirm the slide count in the `ok:` line matches the deck.
3. Tell the user the export is done and the exact file name (including the
   mode marker) to look for in the project file list. Include the slide count.

## Troubleshooting

- **Process reports `Killed` (exit code 137)**: the sandbox hit its memory
  limit (~1GiB for everything in the container). Do NOT retry in a loop.
  First kill any leftover processes from earlier attempts
  (`pkill -f headless_shell; pkill -f render-pptx` — ignore errors), then
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
  deck references remote webfonts (e.g. fonts.googleapis.com) that this
  sandbox cannot reach. The script forwards `HTTPS_PROXY` to Chromium
  automatically when set. If fonts still fall back, finish the export and
  tell the user the deck's webfonts were unreachable from the sandbox, so
  system fonts were substituted — do not treat this as a failure.
- **Exit code 4 (`no slide surfaces found`)**: the file is not a deck. Tell
  the user PPTX export needs a slide-based document; offer image/PDF export of
  the page instead.
- **Exit code 5 (editable engine missing or failed)**: if the message says the
  engine bundle was not found, redo Step 2 (copy
  `assets/dom-to-pptx.bundle.js.gz` next to the script) and retry. If the
  message starts with `editable export refused`, do NOT retry — the deck
  keeps its text/images hidden behind reveal mechanics the exporter could
  not trigger; run screenshot mode, check the slides are not blank/text-less,
  and tell the user editable conversion is not possible for this deck. For other engine failures, retry ONCE; if it
  fails again, run the default screenshot mode instead and TELL the user the
  deck could not be converted to editable shapes, so they received the
  screenshot-based .pptx — never fall back silently. A fallback output is a
  screenshot artifact: name it with the screenshot marker (`-截图版`), not the
  editable one.
- **Relative assets missing in the capture** (rare): serve the project
  directory (`python3 -m http.server` or `npx serve`) and pass an
  `http://127.0.0.1:<port>/<deck>.html` URL to the script instead of the file
  path.
