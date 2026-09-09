---
name: ecommerce-image-workflow
en_name: "Ecommerce Image Workflow"
description: |
  Reference-product ecommerce image workflow for generating a compact set
  of product-faithful main, feature, and lifestyle images from real product
  reference photos. V1 requires uploaded product imagery and intentionally
  defers brief-only concept generation and platform-specific batch exports.
triggers:
  - "ecommerce product images"
  - "product image set"
  - "product photography workflow"
  - "product main image"
  - "product feature shot"
  - "reference product commerce images"
  - "lifestyle product image"
  - "amazon product images"
  - "shopify product images"
  - "taobao product images"
od:
  mode: image
  surface: image
  category: image-generation
  scenario: marketing
  preview:
    type: html
    entry: example.html
  design_system:
    requires: false
  example_prompt: |
    Use the Ecommerce Image Workflow to turn my uploaded product reference
    photo into a compact ecommerce image set: one main packshot, one feature
    highlight image, and one lifestyle scene. Preserve the exact product
    identity, color, material, logo placement, structure, and proportions.
---

# Ecommerce Image Workflow

Create a compact ecommerce image set from real product reference imagery.
This V1 skill is intentionally narrow: it supports **reference-product mode
only**. If the user only describes a product and does not provide a product
photo, ask for one and stop. Do not create a brief-only concept product in
this version.

## Resource map

```text
ecommerce-image-workflow/
|-- SKILL.md
|-- example.html
`-- references/
    `-- checklist.md
```

## What this skill produces

By default, generate three ecommerce-ready image assets for one product:

1. **Main image** - clean product-first packshot on white or soft neutral
   background.
2. **Feature image** - one selling point shown clearly with controlled callout
   space, without relying on tiny unreadable in-image text.
3. **Lifestyle image** - product shown in a plausible use context while keeping
   the product faithful to the reference.

Also create:

- `image-manifest.json` describing reference inputs, slots, prompts, outputs,
  aspect ratios, and fidelity notes.
- `ecommerce-gallery.html` as a small preview gallery linking the generated
  files and summarizing the image roles.

## Input contract

Required:

- At least one uploaded product reference image in the active project.

Ask only for missing essentials:

- Product name or short label if it is not obvious.
- Main selling point if the feature image cannot be inferred safely.
- Target marketplace or aspect only if the user asks for platform-specific
  framing.

Do not ask broad discovery questions. Keep the workflow moving.

## Workflow

### Step 0 - Confirm reference-product mode

Before planning, verify that the current project includes a real product
reference image.

If no product image is available, reply:

> Please upload at least one product reference image first. This V1 workflow
> preserves a real product from reference photos; brief-only concept generation
> is deferred to a later version.

Then stop.

### Step 1 - Extract product identity anchors

Inspect the reference image and write a short internal identity lock:

- Product category and form factor.
- Shape and silhouette.
- Primary colors and materials.
- Logo, label, pattern, fasteners, ports, straps, handles, or other fixed
  details.
- Scale cues and proportions.
- What must not change.

Use these anchors in every generation prompt.

### Step 2 - Build a three-slot shot plan

Create a compact shot plan before dispatch:

| Slot | Default aspect | Goal |
|---|---:|---|
| main | 1:1 | Product-first marketplace image on white or soft neutral background |
| feature | 4:5 | One clear selling point with close-up detail or simple callout space |
| lifestyle | 4:5 | Realistic use context with the product still visually faithful |

If the project metadata provides `imageAspect`, use it when the user expects a
single aspect across the set. Otherwise use the slot defaults above.

### Step 3 - Compose prompts with a fidelity lock

Every prompt must include this product fidelity instruction near the top:

```text
Preserve the exact product identity from the reference image: shape,
silhouette, color, material, logo/label placement, visible construction
details, and proportions. Do not redesign the product. Do not add, remove,
or relocate product features.
```

Then add slot-specific instructions:

#### Main image prompt

- Product centered and fully visible.
- White, off-white, or very light grey background.
- Soft studio lighting with clean shadow.
- No props unless the user asked for them.
- No in-frame marketing text.

#### Feature image prompt

- Focus on one user-provided or safely inferred feature.
- Use close-up composition, cutaway-style crop, or clean negative space for
  later designer-added labels.
- Keep the product visually balanced in the frame. If no explicit callout
  structure is being generated, center the product. If label space is needed,
  offset the product only slightly and make the empty space feel intentional.
- Do not invent certifications, performance numbers, materials, or claims.
- Avoid tiny rendered text; leave label space instead.

#### Lifestyle image prompt

- Use a realistic environment matched to the product category.
- Keep the product the focal point.
- Show human interaction only if it helps explain use and does not obscure the
  product.
- Preserve product scale and structure.

### Step 4 - Generate through capable MCP tools

Inspect the actual tools exposed in this run and select an image-generation tool
by its declared schema. The tool must support the product reference image needed
for fidelity. Do not hardcode a server, provider, tool, or model name, use the
OpenDesign media dispatcher, call provider APIs directly, or ask for provider
credentials.

For each slot, invoke the capable MCP tool with the project-relative product
reference, full slot prompt, and requested aspect. Inspect the returned result
shape and persist URL, base64, binary, resource URI, or temporary-file output as
a regular non-empty file at `./assets/<product-slug>-<slot>.<ext>` beneath the
current project `cwd`. Record each persisted project-relative filename in
`image-manifest.json`.

If no available MCP tool supports reference-guided image generation, stop and
use the media contract's sanitized no-tool completion. Keep raw tool errors only
in the tool trace.

### Step 5 - Write `image-manifest.json`

After generation, create a project file named `image-manifest.json`:

```json
{
  "workflow": "ecommerce-image-workflow",
  "mode": "reference-product",
  "productName": "Example product",
  "referenceImages": ["reference-product.png"],
  "fidelityNotes": [
    "Preserve product identity, color, material, construction, and proportions.",
    "Do not treat these outputs as platform-compliance proof without human review."
  ],
  "slots": [
    {
      "id": "main",
      "role": "marketplace packshot",
      "aspect": "1:1",
      "output": "example-product-main.png",
      "promptSummary": "Centered product-first packshot on a clean neutral background."
    },
    {
      "id": "feature",
      "role": "single feature highlight",
      "aspect": "4:5",
      "output": "example-product-feature.png",
      "promptSummary": "Close-up or negative-space composition for one verified selling point."
    },
    {
      "id": "lifestyle",
      "role": "usage context",
      "aspect": "4:5",
      "output": "example-product-lifestyle.png",
      "promptSummary": "Realistic scene with the product as the focal point."
    }
  ]
}
```

Keep the manifest honest. If a detail is unknown, write `null` or a short note
instead of inventing claims.

### Step 6 - Write `ecommerce-gallery.html`

Create a simple single-file HTML gallery that:

- Shows the reference image first.
- Shows the three generated slots with their role names.
- Lists product-fidelity notes.
- Links to `image-manifest.json`.
- Uses system fonts and local project files only; no CDN imports.

### Step 7 - Hand off

Reply with:

- The generated filenames.
- A one-sentence summary of the fidelity lock used.
- A reminder that marketplace-specific compliance, final text overlays, and
  claim/legal review remain human review steps.

Do not emit an `<artifact>` tag.

## Hard rules

- V1 requires real product reference imagery. No brief-only concept products.
- One product per run.
- Default to exactly three slots: main, feature, lifestyle.
- Preserve the product; do not redesign it.
- Do not invent claims, certifications, measurements, ingredients, or
  performance data.
- Select a capable MCP tool by its declared schema; do not use the OpenDesign
  media dispatcher or call provider APIs directly.
- Always create `image-manifest.json` after generation.
- Run `references/checklist.md` before handoff.

## Bundled font assets

Keep `assets/fonts/` with every copied or generated template. Preserve the authored relative link/import to `assets/fonts/local-fonts.css`; it registers the template fonts locally. Do not add remote font stylesheets, font preconnects, remote `@import` rules, or remote `@font-face` URLs.
