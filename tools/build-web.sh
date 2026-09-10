#!/usr/bin/env bash
# Build the browser client, twice from one source: the multi-file Pages site
# (dist-pages/) and the single-file offline fallback
# (dist-web/tabverse-remote.html).
#
# ring (via iroh's TLS) compiles C for wasm32, which Apple's clang cannot
# target, so point cc-rs at the wasi-sdk toolchain.
set -euo pipefail
cd "$(dirname "$0")/.."

WASI="${WASI_SDK:-}"
if [ -z "$WASI" ] || [ ! -x "$WASI/bin/clang" ]; then
  echo "WASI_SDK must point to a wasi-sdk installation" >&2
  echo "download wasi-sdk from https://github.com/WebAssembly/wasi-sdk/releases" >&2
  exit 1
fi

export CC_wasm32_unknown_unknown="$WASI/bin/clang"
export AR_wasm32_unknown_unknown="$WASI/bin/llvm-ar"
export CFLAGS_wasm32_unknown_unknown="--sysroot=$WASI/share/wasi-sysroot"

cargo build -p tabverse-web --target wasm32-unknown-unknown --release
wasm-bindgen --target web --out-dir crates/tabverse-web/pkg --no-typescript \
  target/wasm32-unknown-unknown/release/tabverse_web.wasm

npx vite build --config vite.pages.config.ts
node tools/build-join-pages.mjs
npx vite build --config vite.web.config.ts
node tools/build-join-page.mjs
