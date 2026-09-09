---
name: video-shortform
description: |
  Short-form video generation skill — 3-10 second clips for product
  reveals, motion teasers, ambient loops. Selects an available MCP tool
  by declared capability and saves one video beneath the project
  `assets/` directory. When the workspace also ships an
  interactive-video / hyperframes skill, prefer composing several short
  shots into a single timeline rather than one long monolithic clip.
triggers:
  - "video"
  - "clip"
  - "shortform"
  - "reel"
  - "短视频"
  - "动效"
od:
  mode: video
  surface: video
  scenario: marketing
  preview:
    type: html
    entry: example.html
  design_system:
    requires: false
  example_prompt: |
    5-second product reveal — ceramic coffee mug rotating on a soft
    paper backdrop, warm side-light from camera-left, micro dust motes
    drifting through the beam. Cinematic, 16:9, slow drift on the camera.
---

# Video Shortform Skill

Short-form (≤ 10s) is the sweet spot for current text-to-video models —
they're great at one **shot** with one **idea**, weaker at multi-cut
narratives. Plan one shot per call.

When an active HyperFrames workflow is also present, its scaffold may prepare
editable motion-design source. That source is not final video; final bytes still
come from a capable MCP tool selected from the current run.

## Resource map

```
video-shortform/
├── SKILL.md
└── example.html
```

## Workflow

### Step 0 — Read the project metadata

`videoLength` (seconds) and `videoAspect` are requested output constraints.
Treat any `videoModel` metadata as descriptive context only. Inspect the actual
MCP tool schema and adapt unsupported constraints honestly rather than assuming
a named model's limits.

### Step 1 — Plan the shot

Write the shotlist BEFORE calling the model:

| Slot | Content |
|---|---|
| Subject | What's in frame? |
| Camera | Static / pan / push-in / orbit? |
| Lighting | Key direction + temperature |
| Motion | What moves, at what pace? Subject motion vs camera motion. |
| Sound | Ambient bed? (only if the model supports audio) |

Normally, show this to the user as a one-sentence plan before generation — they
can redirect cheaply.

### Step 2 — Compose the prompt

Use the selected MCP tool's declared schema. Pass `videoAspect` and
`videoLength` through supported structured fields rather than relying only on
prose. For motion-design briefs, focus on subject, layout, palette, motion
character, and overall tone.

### Step 3 — Generate through a capable MCP tool

Inspect the actual tools available in this run and select a video-generation
tool by its declared schema. Do not hardcode a server, provider, tool, or model
name, use the OpenDesign media dispatcher, call provider APIs directly, or ask
for provider credentials. Invoke the capable MCP tool with the assembled shot
prompt, aspect, and duration, then persist its result as a regular non-empty file
at `./assets/<short-slug>-<seconds>s.<ext>` beneath the current project `cwd`.

### Step 4 — Hand off

Use the media completion contract's single sanitized sentence. Keep tool,
provider, model, path, and raw error details only in the tool trace.

## Hard rules

- One shot per turn. Multi-shot timelines belong in a hyperframes /
  interactive-video skill, not here.
- Match `videoAspect` exactly — re-renders are slow.
- Never ship a video without saving the file — the user expects
  something to play in the file viewer.
- When the MCP tool fails, keep the raw error in the tool trace and use the
  sanitized product-level completion required by the media contract.
- Do not claim a render has been generated until a regular non-empty project
  file exists beneath `./assets/`.

## Bundled font assets

Keep `assets/fonts/` with every copied or generated template. Preserve the authored relative link/import to `assets/fonts/local-fonts.css`; it registers the template fonts locally. Do not add remote font stylesheets, font preconnects, remote `@import` rules, or remote `@font-face` URLs.
