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
[ -f package.json ] || npm init -y >/dev/null
npm i --registry=https://registry.npmmirror.com playwright pptxgenjs
```

Skip installs that are already present (`$WORKDIR` persists within a session —
re-running the export must not re-download anything).

## Step 2 — obtain a Chromium (pick the branch that matches the system)

Environment differences (musl vs glibc, root vs not) are handled here, once.
The result is `$WORKDIR/env.sh`, which every later step sources — shell state
does not survive between your commands, so the env MUST live in that file.

```bash
WORKDIR=/tmp/od-pptx-export
BROWSER="$(command -v chromium-browser || command -v chromium || true)"
echo "export PLAYWRIGHT_BROWSERS_PATH=\"$WORKDIR/browsers\"" > "$WORKDIR/env.sh"
if [ -z "$BROWSER" ] && [ -f /etc/alpine-release ]; then
  # musl (Alpine) without root: Playwright's glibc browser can NEVER run here
  # ("Error relocating ..."). Download the prebuilt self-contained musl
  # Chromium bundle (Alpine 3.20 chromium + CJK fonts + the full dependency
  # closure, repacked as one tarball) — no apk tooling involved, one HTTP GET.
  PREFIX="$WORKDIR/chromium-root"
  BUNDLE_URL="https://github.com/ACaiCaiOnTheRoadSide/ai-design-ppt/releases/download/chromium-alpine3.20-x86_64/chromium-alpine3.20-x86_64.tar.gz"
  BUNDLE_SHA256="140e35183c490e21caeb239cff54ec2fbb4caf89a8310f31877b86161c5ccdb4"
  mkdir -p "$PREFIX" "$WORKDIR/fc-cache"
  if [ ! -f "$PREFIX/usr/lib/chromium/chrome" ]; then
    curl -fsSL --retry 3 -o "$WORKDIR/chromium-bundle.tar.gz" "$BUNDLE_URL"
    got="$(sha256sum "$WORKDIR/chromium-bundle.tar.gz" | cut -d' ' -f1)"
    [ "$got" = "$BUNDLE_SHA256" ] || { echo "chromium bundle checksum mismatch: $got" >&2; exit 1; }
    tar -xzf "$WORKDIR/chromium-bundle.tar.gz" -C "$PREFIX"
    rm -f "$WORKDIR/chromium-bundle.tar.gz"
  fi
  printf '%s\n' '<?xml version="1.0"?>' \
    '<!DOCTYPE fontconfig SYSTEM "fonts.dtd">' '<fontconfig>' \
    "  <dir>$PREFIX/usr/share/fonts</dir>" \
    "  <cachedir>$WORKDIR/fc-cache</cachedir>" '</fontconfig>' > "$WORKDIR/fonts.conf"
  {
    echo "export OD_PPTX_CHROMIUM=\"$PREFIX/usr/lib/chromium/chrome\""
    echo "export LD_LIBRARY_PATH=\"$PREFIX/usr/lib:$PREFIX/lib:$PREFIX/usr/lib/pulseaudio\""
    echo "export FONTCONFIG_FILE=\"$WORKDIR/fonts.conf\""
  } >> "$WORKDIR/env.sh"
elif [ -z "$BROWSER" ]; then
  # glibc system without a system browser: Playwright's own build works.
  export PLAYWRIGHT_BROWSERS_PATH="$WORKDIR/browsers"
  # China-network mirror; harmless elsewhere. Drop it only if it 404s.
  export PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright
  npx playwright install chromium-headless-shell || npx playwright install chromium
fi
# else: a system chromium exists — the render script auto-detects it.
```

The bundle is a single ~320MB download; run it once per session (`$WORKDIR`
persists — the `chrome` existence check above makes a retry skip the download).

## Step 3 — get the render script into the workspace

The script ships with this skill at `scripts/render-pptx.mjs`, and the
editable-mode engine at `assets/dom-to-pptx.bundle.js.gz`. Copy them from
the skill root advertised in the skill preamble — in staged runtimes that is
`.od-skills/html-to-pptx/` inside the project working directory, otherwise
use the absolute skill-root path from the preamble:

```bash
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

## Step 4 — render

```bash
# screenshot mode (default)
. /tmp/od-pptx-export/env.sh && NODE_OPTIONS=--max-old-space-size=256 \
node /tmp/od-pptx-export/render-pptx.mjs "<project-dir>/<deck>.html" "<project-dir>/<deck-title>.pptx"

# editable mode (native text/shapes — only when the user chose it)
. /tmp/od-pptx-export/env.sh && NODE_OPTIONS=--max-old-space-size=256 \
node /tmp/od-pptx-export/render-pptx.mjs --editable "<project-dir>/<deck>.html" "<project-dir>/<deck-title>.pptx"
```

Always source `env.sh` in the same command — the browser location, library
path, and font config from Step 2 live there, and shell state does not carry
over between your commands. Keep the `NODE_OPTIONS` cap — sandbox runtimes
limit the whole container to ~1GiB shared by your own process, this script,
and Chromium; an uncapped Node heap invites the OOM killer.

- The output path MUST be inside the project directory — that is what makes it
  sync back and appear in the user's file list.
- Name the .pptx after the deck's human title when known, not the raw filename.
- The script logs `slide N/M captured` progress and a final `ok:` line with
  slide count and per-phase timings.

## Step 5 — verify and report

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
- **Chromium fails to launch with missing shared libraries / `Error
  relocating`**: `Error relocating` means a glibc browser is being run on a
  musl (Alpine) system — installing dependencies can never fix that. You are
  on the wrong branch of Step 2: run its Alpine branch (prebuilt bundle
  download) and render again via `env.sh`. On glibc systems you may try
  `npx playwright install-deps chromium` (needs root/apt). Never silently
  produce a different artifact.
- **Bundle download fails (URL unreachable / checksum mismatch after
  retries)**: retry the download ONCE. If it fails again, fall back to the
  userspace apk install (`apk fetch` only downloads — no root needed — and
  .apk files are plain tar.gz that the same env.sh layout points at):
  `mkdir -p "$WORKDIR/apks" && apk --no-cache fetch --recursive --output
  "$WORKDIR/apks" chromium font-noto-cjk ttf-dejavu fontconfig && for f in
  "$WORKDIR"/apks/*.apk; do tar -xzf "$f" -C "$PREFIX" 2>/dev/null || true;
  done`, then continue Step 2 from the fonts.conf line. If BOTH paths fail,
  STOP and report — do not try Playwright's glibc browser on Alpine.
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
  engine bundle was not found, redo Step 3 (copy
  `assets/dom-to-pptx.bundle.js.gz` next to the script) and retry. If the
  engine itself failed on this deck, retry ONCE; if it fails again, run the
  default screenshot mode instead and TELL the user the deck could not be
  converted to editable shapes, so they received the screenshot-based .pptx —
  never fall back silently.
- **Relative assets missing in the capture** (rare): serve the project
  directory (`python3 -m http.server` or `npx serve`) and pass an
  `http://127.0.0.1:<port>/<deck>.html` URL to the script instead of the file
  path.
