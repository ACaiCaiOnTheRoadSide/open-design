# setup-env.sh — one-shot environment prep shared by the html-to-pptx,
# html-to-image, and html-to-pdf skills.
#
#   sh <skill-root>/scripts/setup-env.sh
#
# This file ships in all three skills and must stay BYTE-IDENTICAL between them
# (scripts/guard.ts enforces this): each skill stages self-contained into the
# sandbox, but all copies drive the SAME shared workspace
# (${TMPDIR:-/tmp}/od-pptx-export) so the expensive Chromium acquisition (~320MB on musl
# sandboxes) happens once per session no matter which skill runs first. That
# sharing is also why pptxgenjs is installed even for image-only sessions:
# the node_modules/.od-pptx-deps-ok marker is shared, so whichever copy runs
# first must satisfy both skills' dependencies.
#
# Creates the dependency workspace OUTSIDE the project directory, installs
# playwright/pptxgenjs, and obtains a Chromium that can actually run on this
# system — the musl-vs-glibc branch decision lives HERE, once, so the agent
# never has to re-derive it (a hand-rolled `npx playwright install` or
# `apk add chromium` on an Alpine sandbox produces a browser that can NEVER
# launch). Writes $WORKDIR/env.sh for every later command to source.
#
# Idempotent: re-running skips every download already present and resumes a
# partial bundle download, so a retry after a network failure is safe.
#
# Knobs (normal runs need none of these):
#   OD_PPTX_FORCE_BUNDLE=1   ignore any system chromium (e.g. a broken one on
#                            PATH) and install a known-good browser instead
#   OD_PPTX_APK_FALLBACK=1   on Alpine, userspace `apk fetch` instead of the
#                            prebuilt bundle (when the bundle URL is unreachable)
#   OD_PPTX_NPM_REGISTRY / PLAYWRIGHT_DOWNLOAD_HOST   mirror overrides
set -eu

WORKDIR="${OD_PPTX_WORKDIR:-${TMPDIR:-/tmp}/od-pptx-export}"
mkdir -p "$WORKDIR"
cd "$WORKDIR"

# --- npm workspace (dependencies must never land in the project dir: ---
# --- everything there syncs back to the user's file list)             ---
[ -f package.json ] || npm init -y >/dev/null
# The marker is written only after a fully successful install, so an
# interrupted npm run (OOM kill, network drop) is repaired on the next
# invocation instead of being skipped because the package dirs merely exist.
if [ ! -f node_modules/.od-pptx-deps-ok ]; then
  npm i --registry="${OD_PPTX_NPM_REGISTRY:-https://registry.npmmirror.com}" playwright pptxgenjs
  touch node_modules/.od-pptx-deps-ok
fi

# --- Chromium: pick the branch that matches the system ---
BROWSER="$(command -v chromium-browser || command -v chromium || true)"
if [ "${OD_PPTX_FORCE_BUNDLE:-0}" = "1" ]; then BROWSER=""; fi
echo "export PLAYWRIGHT_BROWSERS_PATH=\"$WORKDIR/browsers\"" > "$WORKDIR/env.sh"

if [ -z "$BROWSER" ] && [ -f /etc/alpine-release ]; then
  # musl (Alpine) without root: Playwright's glibc browser can NEVER run here
  # ("Error relocating ..."). Install a self-contained musl Chromium instead:
  # the prebuilt bundle (Alpine 3.20 chromium + CJK fonts + the full dependency
  # closure, one HTTP GET) — or userspace `apk fetch` when OD_PPTX_APK_FALLBACK=1.
  PREFIX="$WORKDIR/chromium-root"
  mkdir -p "$PREFIX" "$WORKDIR/fc-cache"
  if [ ! -f "$PREFIX/usr/lib/chromium/chrome" ]; then
    if [ "${OD_PPTX_APK_FALLBACK:-0}" = "1" ]; then
      # apk fetch only downloads — no root needed; .apk files are plain tar.gz.
      mkdir -p "$WORKDIR/apks"
      apk --no-cache fetch --recursive --output "$WORKDIR/apks" chromium font-noto-cjk ttf-dejavu fontconfig
      for f in "$WORKDIR"/apks/*.apk; do tar -xzf "$f" -C "$PREFIX" 2>/dev/null || true; done
      [ -f "$PREFIX/usr/lib/chromium/chrome" ] || {
        echo "apk fallback did not produce $PREFIX/usr/lib/chromium/chrome" >&2
        exit 1
      }
    else
      BUNDLE_URL_GITHUB="https://github.com/ACaiCaiOnTheRoadSide/ai-design-ppt/releases/download/chromium-alpine3.20-x86_64/chromium-alpine3.20-x86_64.tar.gz"
      BUNDLE_SHA256="140e35183c490e21caeb239cff54ec2fbb4caf89a8310f31877b86161c5ccdb4"
      # Prefer fetching from the daemon (internal network, no GitHub dependency).
      # OD_DAEMON_URL is injected by the sandbox bootstrap; fall back to GitHub
      # when the daemon endpoint is unavailable (local dev, non-sandboxed runs).
      BUNDLE_URL="${OD_DAEMON_URL:+${OD_DAEMON_URL}/api/chromium-bundle.tar.gz}"
      # -C - resumes a partial file left by an interrupted earlier run. Hosted
      # daemon APIs require the run-scoped bearer already used by od sync; never
      # forward the Huskbox tenant/API secret (setup does not read it).
      daemon_bundle_ok=0
      if [ -n "$BUNDLE_URL" ]; then
        if [ -n "${OD_API_TOKEN:-}" ]; then
          curl -fsSL --retry 3 -C - -H "Authorization: Bearer $OD_API_TOKEN" \
            -o "$WORKDIR/chromium-bundle.tar.gz" "$BUNDLE_URL" && daemon_bundle_ok=1
        else
          curl -fsSL --retry 3 -C - -o "$WORKDIR/chromium-bundle.tar.gz" "$BUNDLE_URL" && daemon_bundle_ok=1
        fi
      fi
      if [ "$daemon_bundle_ok" != "1" ]; then
        curl -fsSL --retry 3 -C - -o "$WORKDIR/chromium-bundle.tar.gz" "$BUNDLE_URL_GITHUB"
      fi
      got="$(sha256sum "$WORKDIR/chromium-bundle.tar.gz" | cut -d' ' -f1)"
      [ "$got" = "$BUNDLE_SHA256" ] || {
        rm -f "$WORKDIR/chromium-bundle.tar.gz"
        echo "chromium bundle checksum mismatch: $got (corrupt download removed — re-run to fetch fresh)" >&2
        exit 1
      }
      tar -xzf "$WORKDIR/chromium-bundle.tar.gz" -C "$PREFIX"
      rm -f "$WORKDIR/chromium-bundle.tar.gz"
    fi
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
  # Skip the npx round-trip entirely once a completed install exists.
  if [ -z "$(find "$WORKDIR/browsers" -maxdepth 2 -path '*chromium*' -name INSTALLATION_COMPLETE -print 2>/dev/null | head -1)" ]; then
    export PLAYWRIGHT_BROWSERS_PATH="$WORKDIR/browsers"
    # China-network mirror; harmless elsewhere. Override with
    # PLAYWRIGHT_DOWNLOAD_HOST= (empty) only if the mirror 404s.
    export PLAYWRIGHT_DOWNLOAD_HOST="${PLAYWRIGHT_DOWNLOAD_HOST-https://cdn.npmmirror.com/binaries/playwright}"
    npx playwright install chromium-headless-shell || npx playwright install chromium
  fi
else
  # A system chromium exists — pin it explicitly for the render scripts, whose
  # own fallback detection only probes /usr/bin paths, not the whole PATH.
  echo "export OD_PPTX_CHROMIUM=\"$BROWSER\"" >> "$WORKDIR/env.sh"
fi

echo "ok: export environment ready — source $WORKDIR/env.sh before rendering"
