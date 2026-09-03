---
name: html-to-pdf
description: |
  Export an HTML page or slide deck from the current project to a downloadable,
  text-preserving PDF with sandbox-owned Chromium. Use in SaaS/Huskbox runtimes;
  it never depends on Electron, window.print(), or the user's browser. Ordinary
  pages preserve the complete scrollable document; decks preserve one slide per
  PDF page. Text remains selectable/searchable whenever Chromium can represent it.
triggers:
  - "export pdf"
  - "export as pdf"
  - "导出 pdf"
  - "导出为 pdf"
  - "html 转 pdf"
  - "html-to-pdf"
od:
  mode: utility
  scenario: engineering
---

# HTML → PDF (sandbox Chromium)

Use this skill for deterministic SaaS PDF export. The bundled script runs
Playwright against Chromium inside the current Huskbox sandbox and calls native
`page.pdf()`. Do not call Electron APIs or the user's browser print dialog.

The output contains real PDF text and vector-capable CSS where Chromium supports
them. Canvas, video frames, WebGL, filters, and other raster-only content may
still be embedded as images by Chromium.

## Preconditions

- The target is an HTML file inside the current project.
- If no file was named and multiple HTML files exist, ask which one to export.
- The output must be a `.pdf` file inside the project so workspace sync returns
  it to the user's file list.

## Step 1 — prepare Chromium

Run the bundled setup exactly as shipped:

```bash
sh <skill-root>/scripts/setup-env.sh
```

In staged SaaS runs `<skill-root>` is normally `.od-skills/html-to-pdf` under the
project. The setup is idempotent and writes:

```text
${TMPDIR:-/tmp}/od-pptx-export/env.sh
```

Do not improvise `apk add`, `apt install`, or `npx playwright install`. The setup
selects a browser compatible with the sandbox libc and configures bundled CJK
fonts. If the file is missing, stop and report that the Skill was not staged.

## Step 2 — copy the renderer into the dependency workspace

```bash
WORKDIR=${TMPDIR:-/tmp}/od-pptx-export
cp <skill-root>/scripts/render-pdf.mjs "$WORKDIR/"
```

The renderer must run from `$WORKDIR` so its `playwright` import resolves from
the isolated dependencies installed by Step 1.

## Step 3 — export

Ordinary page:

```bash
. ${TMPDIR:-/tmp}/od-pptx-export/env.sh && NODE_OPTIONS=--max-old-space-size=256 \
node ${TMPDIR:-/tmp}/od-pptx-export/render-pdf.mjs \
  "<project-dir>/<page>.html" "<project-dir>/<title>.pdf"
```

Deck explicitly identified by the viewer:

```bash
. ${TMPDIR:-/tmp}/od-pptx-export/env.sh && NODE_OPTIONS=--max-old-space-size=256 \
node ${TMPDIR:-/tmp}/od-pptx-export/render-pdf.mjs --deck \
  "<project-dir>/<deck>.html" "<project-dir>/<title>.pdf"
```

Rules:

- Pass `--deck` whenever the request states that the viewer identified a deck.
- Never substitute `render-image.mjs --format pdf`; that deck path creates an
  image-only PDF and loses selectable text.
- Never call `window.print()` or an Electron bridge.
- To match a known preview viewport, set `OD_PDF_WIDTH` and `OD_PDF_HEIGHT`
  before the render command. Defaults are `1440x1000`.
- Render again for every request; an older PDF is not proof of success.

The renderer:

- serves local project files over a loopback HTTP server so relative assets and
  ES modules resolve;
- waits for fonts, `<img>` elements, and CSS images;
- prewarms lazy/reveal content;
- emulates screen media and preserves backgrounds/colors;
- emits a single custom-size page for normal documents up to the safe Chromium
  paper limit, otherwise paginates at the configured viewport height;
- emits one custom-size PDF page per deck slide;
- validates the `%PDF-` header and a non-trivial output size.

## Step 4 — verify and report

1. Confirm the command prints an `ok:` line.
2. Confirm the PDF exists inside the project and is non-empty.
3. Report the exact filename and page count from the `ok:` line.
4. Do not claim that text is selectable if the renderer failed. Do not create a
   screenshot PDF as a silent substitute.

## Troubleshooting

- **Chromium cannot launch**: rerun bundled `setup-env.sh` once and source
  `env.sh` in the same render command. On Alpine relocation errors use
  `OD_PPTX_FORCE_BUNDLE=1 sh <skill-root>/scripts/setup-env.sh`.
- **Wrong fonts**: remote webfonts were probably unreachable. The bundled CJK
  fonts prevent missing Chinese glyphs, but exact brand typography requires the
  font files to exist in the project or be reachable through the sandbox proxy.
- **Missing assets**: ensure `OD_PROJECT_DIR` points at the project root. The
  renderer rejects outputs outside that root and serves inputs only from it.
- **Deck has the wrong page count**: rerun with `--deck`. If no slide matches are
  found, report the actual structure mismatch rather than exporting one page.
- **Complex visual effect differs**: Chromium print preserves text and most CSS,
  but screen-only canvas/WebGL/video output may require the separate screenshot
  PDF fallback. Ask before changing modes; do not downgrade silently.
