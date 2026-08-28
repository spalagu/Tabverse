import { beforeEach, describe, expect, it } from "vitest";
import { Terminal } from "@xterm/xterm";
import { ImageAddon } from "@xterm/addon-image";
import { SerializeAddon } from "@xterm/addon-serialize";
import { buildTermMemory, hasVisibleContent } from "../components/terminal/sessionMemory";


/** A 1x1 transparent PNG (68 bytes), as the wire would carry it. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
/** The PNG's decoded byte size — IIP's mandatory `size` field. */
const PNG_BYTES = atob(PNG_B64).length;

/** The minimal iTerm IIP sequence: inline, decoded size, payload. */
function iipSequence(b64: string, bytes: number): string {
  return `\x1b]1337;File=inline=1;size=${bytes}:${b64}\x07`;
}

/** A real Terminal opened into a hidden div, with images enabled. */
function imageTerminal(): {
  term: Terminal;
  image: ImageAddon;
  dispose: () => void;
} {
  const el = document.createElement("div");
  el.style.display = "none";
  document.body.appendChild(el);
  const term = new Terminal({ allowProposedApi: true, cols: 80, rows: 24 });
  term.open(el);
  const image = new ImageAddon({
    sixelSupport: true,
    iipSupport: true,
  });
  term.loadAddon(image);
  return {
    term,
    image,
    dispose: () => {
      term.dispose();
      el.remove();
    },
  };
}

/** Write data and let the (async) OSC handler settle behind it. */
async function write(term: Terminal, data: string): Promise<void> {
  await new Promise<void>((r) => term.write(data, r));
  await new Promise((r) => setTimeout(r, 20));
}

beforeEach(() => {
  // The decoder stub — installed fresh so test order cannot leak it. See
  // the file comment for the exact boundary of what it replaces.
  (globalThis as { createImageBitmap: unknown }).createImageBitmap = async (
    blob: Blob
  ) => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: dv.getUint32(16), height: dv.getUint32(20), close() {} };
  };
});

describe("a fed image lands in the buffer (the pipeline works here)", () => {
  it("occupies a cell the addon can find again", async () => {
    const { term, image, dispose } = imageTerminal();
    await write(term, "before\r\n" + iipSequence(PNG_B64, PNG_BYTES));

    // The gate on everything below: if the image never lands, the serialize
    // assertions would be measuring an empty promise.
    expect(image.storageUsage, "storage holds the image").toBeGreaterThan(0);
    expect(
      image.getImageAtBufferCell(0, 1),
      "the cell under the cursor carries the image"
    ).toBeDefined();
    dispose();
  });
});

describe("serialize() over image cells (the measured answer)", () => {
  it("emits not one byte of image data, identical to no image at all", async () => {
    const withImage = imageTerminal();
    const serialize = new SerializeAddon();
    withImage.term.loadAddon(serialize);
    await write(
      withImage.term,
      "before\r\n" + iipSequence(PNG_B64, PNG_BYTES)
    );
    expect(withImage.image.storageUsage).toBeGreaterThan(0);
    const serialized = serialize.serialize();

    // The negative assertions, one per shape the bytes could take.
    expect(serialized, "no OSC 1337 restated").not.toContain("1337");
    expect(serialized, "no base64 payload leaked").not.toContain(
      PNG_B64.slice(0, 24)
    );
    // And the positive form of the same claim: a terminal fed the text
    // alone serializes to exactly the same screen.
    const textOnly = imageTerminal();
    const serializeB = new SerializeAddon();
    textOnly.term.loadAddon(serializeB);
    await write(textOnly.term, "before\r\n");
    expect(serialized).toBe(serializeB.serialize());
    // The recorded shape itself, so a future serializer that changes it
    // fails here with the diff in hand rather than downstream.
    expect(serialized.length).toBeLessThan(100);

    withImage.dispose();
    textOnly.dispose();
  });

  it("leaves nothing for the screen memory to store an image by", async () => {
    const { term, image, dispose } = imageTerminal();
    const serialize = new SerializeAddon();
    term.loadAddon(serialize);
    // An image and nothing else on the screen.
    await write(term, iipSequence(PNG_B64, PNG_BYTES));
    expect(image.storageUsage).toBeGreaterThan(0);

    const screen = serialize.serialize();
    expect(hasVisibleContent(screen), "an image alone is not a transcript")
      .toBe(false);
    expect(buildTermMemory(screen, null)).toBeNull();
    // And a real transcript beside an image keeps its text, loses the
    // image, and stays far under the ceiling.
    await write(term, "a command ran\r\n");
    const mem = buildTermMemory(serialize.serialize(), "/w");
    expect(mem).not.toBeNull();
    expect(mem!.screen).toContain("a command ran");
    expect(mem!.screen).not.toContain("1337");
    expect(mem!.screen.length).toBeLessThan(256 * 1024);
    dispose();
  });
});
