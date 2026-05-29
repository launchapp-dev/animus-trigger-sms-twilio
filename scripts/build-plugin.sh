#!/usr/bin/env bash
# Build the plugin bundle if it isn't already present.
#
# We run this from `postinstall` so that installing this package straight from
# its git URL (the documented `animus plugin install` path) leaves the
# `dist/index.cjs` bin in place. The `prepack` script handles the same job for
# npm publish. Both are idempotent: if `dist/index.cjs` already exists we skip.
set -euo pipefail

if [ -f dist/index.cjs ]; then
  echo "[build-plugin] dist/index.cjs already present; skipping" >&2
  exit 0
fi

# When `npm install` is invoked at a consumer (not from inside this package),
# tsup may not be available — postinstall fires only after dev deps install
# locally, so this path is for git-install in the plugin's own tree.
if [ ! -x node_modules/.bin/tsup ]; then
  echo "[build-plugin] tsup not installed; skipping (consumer install)" >&2
  exit 0
fi

node_modules/.bin/tsup
chmod +x dist/index.cjs || true
echo "[build-plugin] built dist/index.cjs" >&2
