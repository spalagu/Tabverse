#!/usr/bin/env bash
# Rebuild the bundled ligature-font subset from an installed Fira Code.
#
# WHY THIS FONT IS BUNDLED AT ALL: user-installed fonts are not consistently
# visible to the packaged webview. Menlo and Monaco, the reliable system
# faces, carry no ligatures. So a
# ligature switch that relied on the machine's own fonts would be a switch with
# nothing behind it. A @font-face file is loaded by the page itself and never
# goes through system font resolution, which is why this one works.
#
# THE ONE FLAG THAT MATTERS IS --layout-features. The sibling script
# build-font-subset.sh passes '' because an icon font needs no shaping; here the
# ligatures ARE the shaping, and dropping the flag produces a font that looks
# identical in a file listing and forms no ligature at all. Measured on this
# machine with hb-shape, same source, same unicodes:
#   with    calt:  === -> [gid716|gid716|gid636]   (three ligature pieces)
#   without calt:  === -> [gid30|gid30|gid30]      (three plain equals signs)
# Fira Code draws a ligature as one piece per cell, which is what keeps the
# grid monospaced; the substitution is what joins them.
set -euo pipefail
cd "$(dirname "$0")/.."

SRC="${FIRA_CODE_TTF:-$HOME/Library/Fonts/FiraCodeNerdFontMono-Regular.ttf}"
[ -f "$SRC" ] || { echo "source font not found: $SRC" >&2; exit 1; }

# No font ships without the licence that lets us ship it. Fira Code is under
# the SIL Open Font License 1.1, which requires the licence to travel with the
# font — so a missing file here stops the build rather than producing a
# redistributable that omits it.
LICENSE=assets/fonts/LICENSE-fira-code.txt
[ -f "$LICENSE" ] || { echo "licence text missing: $LICENSE" >&2; exit 1; }

# Text, and only text. The Private Use Area is deliberately absent: icons come
# from nerd-symbols.woff2 (build-font-subset.sh), which is the complete,
# version-pinned icon font this app already ships, and duplicating those
# thousands of glyphs here would multiply the download for nothing.
#
#   0020-007E  ASCII — where every programming ligature lives
#   00A0-00FF  Latin-1: accented letters, ± × ÷ ° µ
#   2010-205E  dashes, quotes, ellipsis, dagger, per-mille
#   2190-21FF  arrows        2200-22FF  mathematical operators
#   2500-259F  box drawing and block elements, for TUI output
#   25A0-25FF  geometric shapes
pyftsubset "$SRC" \
  --output-file=assets/fonts/fira-code-ligatures.woff2 \
  --flavor=woff2 \
  --layout-features='calt,liga,ccmp' --no-hinting --desubroutinize \
  --unicodes="U+0020-007E,U+00A0-00FF,U+2010-2027,U+2030-205E,U+2190-21FF,U+2200-22FF,U+2500-259F,U+25A0-25FF"

ls -lh assets/fonts/fira-code-ligatures.woff2
