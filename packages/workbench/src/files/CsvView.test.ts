import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


type CsvView = typeof import("./CsvView");
type Strings = typeof import("../strings");

/** A CSV whose data rows exceed CSV_ROW_LIMIT, so the parse truncates. */
function truncatedText(): string {
  const lines = ["id,name"];
  for (let i = 0; i < 1200; i++) lines.push(`${i},row-${i}`);
  return lines.join("\n") + "\n";
}

const mounted: Array<() => void> = [];

async function fresh(): Promise<{
  CsvView: CsvView["CsvView"];
  STR: Strings["STR"];
}> {
  vi.resetModules();
  const mod = await import("./CsvView");
  const strings = await import("../strings");
  return { CsvView: mod.CsvView, STR: strings.STR };
}

function render(
  View: CsvView["CsvView"],
  props: {
    text: string;
    onEdit?: (t: string) => void;
    truncated?: boolean;
  }
): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  flushSync(() =>
    root.render(
      createElement(View, {
        text: props.text,
        delimiter: ",",
        onEdit: props.onEdit,
      })
    )
  );
  mounted.push(() => {
    flushSync(() => root.unmount());
    host.remove();
  });
  return host;
}

function rightClick(el: Element) {
  el.dispatchEvent(
    new MouseEvent("contextmenu", { bubbles: true, cancelable: true })
  );
}

async function settle() {
  await new Promise((r) => setTimeout(r, 0));
  flushSync(() => {});
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
});

describe("the CSV grid's row/column menu", () => {
  it("the four actions rebuild the file and hand it to onEdit", async () => {
    const { CsvView: View, STR } = await fresh();
    const edits: string[] = [];
    const host = render(View, {
      text: "id,name\n1,ada\n2,bob\n",
      onEdit: (t) => edits.push(t),
    });

    // Row menu on the second row: insert above.
    const rowHeads = host.querySelectorAll(".csv-rowhead");
    rightClick(rowHeads[2]); // [0] is the corner th; data rows start at 1
    await settle();
    const insertRowBtn = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".csv-grid-menu .ctx-item")
    ).find((b) => b.textContent === STR.files.csv.insertRow)!;
    expect(insertRowBtn).toBeTruthy();
    flushSync(() => insertRowBtn.click());
    await settle();
    expect(edits).toHaveLength(1);
    expect(edits[0]).toBe("id,name\n1,ada\n,\n2,bob\n");

    // Column menu on the first column: delete.
    const th = host.querySelectorAll("thead th")[1]; // [0] is the corner
    rightClick(th);
    await settle();
    const delCol = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".csv-grid-menu .ctx-item")
    ).find((b) => b.textContent === STR.files.csv.deleteColumn)!;
    flushSync(() => delCol.click());
    await settle();
    expect(edits[1]).toBe("name\nada\nbob\n");
  });

  it("a truncated file disables all four actions, with the reason on the item", async () => {
    const { CsvView: View, STR } = await fresh();
    const edits: string[] = [];
    const host = render(View, {
      text: truncatedText(),
      onEdit: (t) => edits.push(t),
    });

    // The truncation notice is on screen: the gate has a visible reason
    // before the menu is even opened.
    expect(host.textContent).toContain(
      STR.files.csv.truncationNote({ shown: 1000, total: 1200 })
    );

    rightClick(host.querySelectorAll(".csv-rowhead")[1]);
    await settle();
    const items = Array.from(
      host.querySelectorAll<HTMLButtonElement>(".csv-grid-menu .ctx-item")
    );
    expect(items.length).toBe(2);
    for (const item of items) {
      expect(item.disabled).toBe(true);
      expect(item.title).toBe(STR.files.csv.blockedTruncated);
    }

    // Clicking a disabled item changes nothing — the menu just closes.
    items[0].click();
    await settle();
    expect(edits).toHaveLength(0);

    // The column menu carries the same gate.
    rightClick(host.querySelectorAll("thead th")[1]);
    await settle();
    for (const item of host.querySelectorAll<HTMLButtonElement>(
      ".csv-grid-menu .ctx-item"
    )) {
      expect(item.disabled).toBe(true);
    }
  });

  it("a file without an edit channel is gated too, by the other reason", async () => {
    const { CsvView: View, STR } = await fresh();
    const host = render(View, { text: "a,b\n1,2\n" });
    rightClick(host.querySelectorAll(".csv-rowhead")[1]);
    await settle();
    const item = host.querySelector<HTMLButtonElement>(".csv-grid-menu .ctx-item")!;
    expect(item.disabled).toBe(true);
    expect(item.title).toBe(STR.files.csv.blockedNoEdit);
  });
});
