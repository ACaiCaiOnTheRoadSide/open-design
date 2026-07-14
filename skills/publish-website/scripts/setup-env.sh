#!/bin/sh
# Dependency workspace for the publish-website skill.
#
# One job: get `jszip` installed somewhere the publish script can import it.
# We package the site with jszip rather than a hand-rolled PKZIP writer — it is
# the same library the daemon itself uses (apps/daemon/package.json) and the one
# pptxgenjs builds .pptx files with, so the archive the showcase server has to
# unpack is produced by a battle-tested implementation instead of ours.
#
# The workspace lives OUTSIDE the project directory on purpose: everything under
# the project dir syncs back into the user's file list, and nobody wants
# node_modules there. The script is copied in beside node_modules so its
# `jszip` import resolves against this workspace.
#
# Idempotent: re-running after a network failure re-tries only what is missing.
set -eu

WORKDIR="${OD_PUBLISH_WORKDIR:-/tmp/od-publish}"
mkdir -p "$WORKDIR"
cd "$WORKDIR"

[ -f package.json ] || npm init -y >/dev/null 2>&1

# The marker is written only after a fully successful install, so an interrupted
# run (network drop, OOM kill) is repaired next time instead of being skipped
# because node_modules merely exists.
if [ ! -f node_modules/.od-publish-deps-ok ]; then
  npm i --no-audit --no-fund \
    --registry="${OD_PUBLISH_NPM_REGISTRY:-https://registry.npmmirror.com}" \
    jszip
  touch node_modules/.od-publish-deps-ok
fi

echo "ok: workspace $WORKDIR ready (jszip installed)"
