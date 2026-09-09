---
name: image-poster
description: |
  Single-image generation skill for posters, key art, and editorial
  illustrations. Selects an available MCP tool by declared capability
  and saves one or more PNG/JPEG files beneath the project `assets/`
  directory.
triggers:
  - "poster"
  - "key art"
  - "illustration"
  - "image"
  - "cover art"
  - "海报"
  - "插画"
od:
  mode: image
  surface: image
  scenario: design
  preview:
    type: html
    entry: example.html
  design_system:
    requires: false
  example_prompt: |
    Editorial poster for an indie film festival — one bold abstract
    silhouette over a warm, slightly grainy paper background; hand-set
    sans serif title at the top, festival dates and venue at the bottom
    in monospace. Muted ochre + ink palette.
---

# Image Poster Skill

Produce **one** finished image asset per turn unless the user asks for
variations. Image generation rewards a tight, structured prompt — your
job is to assemble that prompt from the user's brief, then generate through a
capable MCP tool.

## Resource map

```
image-poster/
├── SKILL.md         ← you're reading this
└── example.html     ← what the resulting card looks like in Examples
```

## Workflow

### Step 0 — Read the project metadata

The active project carries `imageAspect` and optional `imageStyle` notes. Use
them as canvas and style anchors. Treat any `imageModel` metadata as descriptive
context only; choose the actual tool from its declared capability and schema.
When a value is not provided, infer a safe default from the brief and media
contract. Ask only when the choice would materially change the requested
result and no safe default can be inferred.

### Step 1 — Compose the prompt

Plan in this exact order before calling any tool:

1. **Subject + composition** — what is in the frame, where, at what
   scale; eye-line and crop.
2. **Lighting + mood** — natural / studio / moody; warm / cool; key
   plus rim plus fill; time of day if outdoor.
3. **Palette + textures** — hex anchors when the user gave a brand
   palette; otherwise a 3-word mood tag (e.g. "muted ochre + ink").
4. **Camera / lens** — only if the user wants photographic realism
   ("85mm portrait, shallow DOF") or a specific film stock.
5. **What to avoid** — common AI-slop patterns ("no extra fingers, no
   warped text, no logo placeholders").

### Step 2 — Generate through a capable MCP tool

Inspect the actual tools available in this run and select an image-generation
tool by its declared schema. Do not hardcode a server, provider, tool, or model
name, use the OpenDesign media dispatcher, call provider APIs directly, or ask
for provider credentials. Invoke the capable MCP tool with the assembled prompt
and requested aspect ratio, then persist its result as a regular non-empty file
at `./assets/<short-descriptive-name>.<ext>` beneath the current project `cwd`.

### Step 3 — Hand off

Use the media completion contract's single sanitized sentence. Keep tool,
provider, model, path, and raw error details only in the tool trace. Do **not**
emit an `<artifact>` tag.

## Hard rules

- One image per turn unless asked for variations.
- Honor `imageAspect` exactly — the upstream cost is the same; matching
  the aspect avoids a re-render.
- No filler typography in the image itself unless the user asked for
  in-frame text. Real copy beats lorem.
- Save every render — never describe an image without producing the
  file. The user expects something to open in the file viewer.

## Bundled font assets

Keep `assets/fonts/` with every copied or generated template. Preserve the authored relative link/import to `assets/fonts/local-fonts.css`; it registers the template fonts locally. Do not add remote font stylesheets, font preconnects, remote `@import` rules, or remote `@font-face` URLs.
