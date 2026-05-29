#!/usr/bin/env bash
# Build the @launchapp-dev/animus-plugin-sdk dependency when it was installed
# from a git URL (no prebuilt dist/). The published-from-git tarball includes
# `src/` but not `dist/` or `tsconfig.build.json`, so we compile in place using
# a minimal config so our package can import the SDK by its declared
# `main`/`types` paths.
set -euo pipefail

SDK_DIR="node_modules/@launchapp-dev/animus-plugin-sdk"
if [ ! -d "$SDK_DIR" ]; then
  echo "[build-sdk] $SDK_DIR not found; skipping" >&2
  exit 0
fi
if [ -f "$SDK_DIR/dist/index.js" ] && [ -f "$SDK_DIR/dist/index.d.ts" ]; then
  echo "[build-sdk] SDK already built; skipping" >&2
  exit 0
fi

cd "$SDK_DIR"

# Write a minimal tsconfig if the SDK didn't publish its build config.
if [ ! -f tsconfig.build.json ]; then
  cat > tsconfig.build.json <<'JSON'
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "types": ["node"],
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "declaration": true,
    "sourceMap": false
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/**/*.test.ts", "node_modules", "dist"]
}
JSON
fi

../../typescript/bin/tsc -p tsconfig.build.json 2>/dev/null \
  || ../../.bin/tsc -p tsconfig.build.json 2>/dev/null \
  || npx --no-install tsc -p tsconfig.build.json

echo "[build-sdk] built $SDK_DIR/dist/" >&2
