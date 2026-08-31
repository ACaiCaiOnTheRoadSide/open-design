---
name: motionsites-mainframe-hero
description: Full-screen, video-led creative agency hero with horizontal mouse scrubbing, blurred AI introduction, typewriter copy, responsive navigation, and compact pill actions.
triggers:
  - "video hero landing page"
  - "creative agency hero"
  - "mouse scrub background video"
  - "Mainframe-style marketing page"
od:
  mode: prototype
  platform: desktop
  scenario: marketing
  preview:
    type: html
    entry: example.html
  design_system:
    requires: false
  outputs:
    primary: index.html
  capabilities_required: [file_write]
---

# MotionSites Mainframe Hero

Create a polished, single-page marketing hero based on the baked prototype in this directory.

## Required workflow

1. Read `example.html` before writing output. Treat its layout, visual hierarchy, responsive behavior, and interaction code as the implementation reference.
2. Read `references/source-prompt.md` for the complete source specification and preserve its design intent.
3. Write the finished artifact to `index.html` as a self-contained HTML/CSS/JS page with no build step.
4. Keep the full-screen background video, horizontal mouse scrubbing, fixed navigation, mobile menu, blurred intro, typewriter line, pill actions, copy interaction, focus treatment, reduced-motion behavior, and responsive composition.
5. Replace the example's Mainframe brand content with the user's brand, message, links, calls to action, and contact details. Do not remove the template's signature visual or motion language when adapting the copy.
6. Keep meaningful `data-od-id` attributes on editable regions and interactive controls.
7. Copy or reference the local video and font assets from `assets/background.mp4` and `assets/fonts/albert-sans-variable.woff2`; do not depend on remote asset or font URLs at runtime.

## Visual contract

- Use a viewport-filling video layer with white interface text above it.
- Keep the desktop navigation airy and editorial; collapse it into an accessible full-screen mobile overlay below 768px.
- Preserve the soft blurred introductory label, measured typewriter rhythm, and compact wrapping pill controls.
- Use the heading face only for the wordmark and the body face for all other text.
- Preserve strong keyboard focus indicators and readable content at narrow mobile sizes.

## Motion and interaction contract

- Horizontal pointer movement scrubs the video in both directions with queued seeks rather than flooding the media element.
- Typewriter copy starts after a short delay; actions appear independently with a subtle fade and rise.
- The menu supports keyboard operation and Escape-to-close.
- The contact control copies the adapted email address and announces success without relying solely on color.
- Under `prefers-reduced-motion: reduce`, reveal all content immediately, remove nonessential transitions and blinking, and disable pointer-driven video scrubbing.

## Output checks

- `index.html` opens directly without React, Tailwind, Vite, a package install, or a local server.
- The video path resolves relative to the output.
- There is no horizontal overflow at 375px.
- Every link and button has a visible `:focus-visible` state.
- Mobile navigation state and copy-email feedback remain accessible.

## Bundled font assets

Keep `assets/fonts/` with every copied or generated template. Preserve the existing local `@font-face` declaration and its relative font URL. Do not add remote font stylesheets, font preconnects, remote `@import` rules, or remote `@font-face` URLs.
