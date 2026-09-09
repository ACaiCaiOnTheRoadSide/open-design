---
name: audio-jingle
description: |
  Audio generation skill — jingles, beds, voiceover, and sound effects.
  Selects an available MCP tool by declared capability and saves one MP3/WAV
  file beneath the project `assets/` directory.
triggers:
  - "music"
  - "jingle"
  - "bed"
  - "voiceover"
  - "tts"
  - "sound effect"
  - "音乐"
  - "配音"
  - "音效"
od:
  mode: audio
  surface: audio
  scenario: marketing
  preview:
    type: html
    entry: example.html
  design_system:
    requires: false
  example_prompt: |
    A 30-second upbeat indie-pop jingle for a coffee shop launch — warm
    electric piano lead, brushed drums, gentle bass, a single sun-soaked
    "ahhh" choir on the chorus. No vocals. Loop-friendly tail.
---

# Audio Jingle Skill

Three sub-modes. The active project's `audioKind` decides which one
runs:

| `audioKind` | Required capability | Plan focus |
|---|---|---|
| `music` | music generation | genre + tempo + instrumentation |
| `speech` | speech generation | script + voice + pacing |
| `sfx` | sound-effect generation | texture + impact + duration |

## Resource map

```
audio-jingle/
├── SKILL.md
└── example.html
```

## Workflow

### Step 0 — Read the project metadata

`audioKind`, `audioModel`, `audioDuration` (seconds), and (for speech)
`voice`. Branch by known values and use them verbatim. Missing metadata is not
an instruction to ask: infer a safe default when possible, and emit a
clarifying form only when the missing answer would materially change the
requested output or prevent generation.

A voice identifier is tool-specific. Inspect the selected MCP tool schema before
passing one. If only a prose voice brief is available, use a supported prose
field or the tool's default; do not invent an identifier or ask for provider
credentials.

### Step 1 — Plan

**Music**
- Genre + reference artists (1-2)
- Tempo (BPM) + key
- Instrumentation (3-5 instruments max)
- Vocals: yes / no / hummed / choir
- Mood arc (intro → chorus → outro)

**Speech**
- Script (final, not draft — TTS runs verbatim)
- Voice target + pacing; pass a voice identifier only when the selected tool's
  schema declares one
- Pronunciation hints for proper nouns / acronyms

**SFX**
- Texture (impact / whoosh / ambience / foley)
- Duration + envelope (sharp attack vs. gentle swell)
- Layering note (single hit vs. stacked)

State the plan in 2-3 sentences before generation.

### Step 2 — Compose the prompt

Use the selected MCP tool's declared schema. Pass `audioDuration` through a
supported structured field rather than relying only on prose.

### Step 3 — Generate through a capable MCP tool

Inspect the actual tools available in this run and select an audio-generation
tool by its declared schema. Do not hardcode a server, provider, tool, or model
name, use the OpenDesign media dispatcher, call provider APIs directly, or ask
for provider credentials. Invoke the capable MCP tool with the assembled prompt
and requested audio parameters, then persist its result as a regular non-empty
file at `./assets/<short-slug>-<duration>s.<ext>` beneath the current project
`cwd`.

### Step 4 — Hand off

Use the media completion contract's single sanitized sentence. Keep tool,
provider, model, path, and raw error details only in the tool trace.

## Hard rules

- TTS runs your script **literally**. Proof it before generation — even one
  stray comma changes the cadence.
- Pass only voice fields declared by the selected MCP tool schema; never invent
  provider-specific identifiers.
- Music: under 30s = single section; 30–90s = intro + body; 90s+ =
  full arc. Don't try to fit a 3-act song into 15 seconds.
- SFX: prefer one well-described layer over a paragraph of "make it
  cool" — generators reward specific texture words.
- Save the file every turn. The audio viewer shows transport controls
  the moment the file lands.

## Bundled font assets

Keep `assets/fonts/` with every copied or generated template. Preserve the authored relative link/import to `assets/fonts/local-fonts.css`; it registers the template fonts locally. Do not add remote font stylesheets, font preconnects, remote `@import` rules, or remote `@font-face` URLs.
