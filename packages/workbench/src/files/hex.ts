
/** Bytes fetched per page. */
export const HEX_PAGE = 4096;

/** Bytes per dump row, the classic width. */
export const HEX_ROW = 16;

export interface HexRow {
  /** Zero-padded hex offset of the row's first byte. */
  offset: string;
  /** 16 two-digit cells, single-spaced, double-spaced between the groups
      of 8; short rows are padded so the ASCII gutter stays aligned. */
  hex: string;
  /** Printable ASCII, everything else as '·'. */
  ascii: string;
}

/** Hex digits needed for the last addressable byte, floored at 8. */
export function offsetDigits(total: number): number {
  if (total <= 1) return 8;
  return Math.max(8, (total - 1).toString(16).length);
}

export function hexRows(
  bytes: Uint8Array,
  base: number,
  digits: number
): HexRow[] {
  const rows: HexRow[] = [];
  for (let o = 0; o < bytes.length; o += HEX_ROW) {
    const slice = bytes.subarray(o, Math.min(o + HEX_ROW, bytes.length));
    rows.push({
      offset: (base + o).toString(16).padStart(digits, "0"),
      hex: hexCells(slice),
      ascii: asciiGutter(slice),
    });
  }
  return rows;
}

function hexCells(slice: Uint8Array): string {
  const cells: string[] = [];
  for (let i = 0; i < HEX_ROW; i++) {
    cells.push(
      i < slice.length ? slice[i].toString(16).padStart(2, "0") : "  "
    );
  }
  return `${cells.slice(0, 8).join(" ")}  ${cells.slice(8).join(" ")}`;
}

/** The row's cells split at the 8-byte seam for the two-group render.
    Fixed widths rather than searching for the gap: short rows pad their
    tail with blanks, and padding must shape exactly like data or the two
    groups — and with them the ASCII gutter — drift out of alignment. */
export function hexGroups(hex: string): [string, string] {
  return [hex.slice(0, 23), hex.slice(25)];
}

function asciiGutter(slice: Uint8Array): string {
  let s = "";
  for (const b of slice) {
    s += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·";
  }
  return s;
}

/** "0x1a2b" (any case) or plain decimal → byte offset; null if neither. */
export function parseOffsetInput(s: string): number | null {
  const t = s.trim().toLowerCase();
  if (/^0x[0-9a-f]+$/.test(t)) return parseInt(t.slice(2), 16);
  if (/^[0-9]+$/.test(t)) return parseInt(t, 10);
  return null;
}

/** Clamp into the file, then align to the start of the row holding it. */
export function clampToRow(offset: number, total: number): number {
  if (total <= 0) return 0;
  const clamped = Math.min(Math.max(0, offset), total - 1);
  return clamped - (clamped % HEX_ROW);
}

/** Start of the page containing the file's last byte. */
export function lastPageStart(total: number, page = HEX_PAGE): number {
  if (total <= page) return 0;
  return Math.floor((total - 1) / page) * page;
}
