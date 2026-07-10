# dom-to-pptx engine (vendored copy)

`dom-to-pptx.bundle.js.gz` is a byte-for-byte copy of
`apps/desktop/vendor/dom-to-pptx/dom-to-pptx.bundle.js.gz` (license:
`dom-to-pptx.LICENSE`). The skill ships its own copy because skill side files
are the only assets staged into agent sandboxes (`.od-skills/html-to-pptx/`)
— the desktop vendor tree never syncs there.

When the desktop vendor bundle is upgraded, re-copy it here in the same
change so the editable export path (`render-pptx.mjs --editable`) stays in
sync with the desktop renderer.
