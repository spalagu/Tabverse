#!/usr/bin/env bash
# Rebuild the bundled icon-font subset from an installed Symbols Nerd Font Mono.
#
# Only the icon ranges are kept: text glyphs come from the machine's own
# monospace font, this font exists purely so Private Use Area icons (powerline
# separators, prompt icons) have somewhere to come from.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="${NERD_SYMBOLS_TTF:-$HOME/Library/Fonts/SymbolsNerdFontMono-Regular.ttf}"
[ -f "$SRC" ] || { echo "source font not found: $SRC" >&2; exit 1; }

pyftsubset "$SRC" \
  --output-file=assets/fonts/nerd-symbols.woff2 \
  --flavor=woff2 \
  --layout-features='' --no-hinting --desubroutinize \
  --unicodes="U+E000-E00A,U+E0A0-E0A3,U+E0B0-E0D7,U+E200-E2A9,U+E300-E3E3,U+E5FA-E6B7,U+E700-E8EF,U+EA60-EC1E,U+ED00-EFCE,U+F000-F2FF,U+F300-F381,U+F400-F533,U+F0001-F1AF0"

ls -lh assets/fonts/nerd-symbols.woff2
