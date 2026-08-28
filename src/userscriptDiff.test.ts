import { describe, expect, it } from "vitest";
import { diffLines, MAX_DIFF_CELLS, type DiffLine } from "./userscriptDiff";

/** Compact form for asserting on a whole diff at once. */
function marks(lines: DiffLine[]): string {
  return lines.map((l) => (l.kind === "same" ? "." : l.kind === "del" ? "-" : "+") + l.text).join(" ");
}

describe("diffLines", () => {
  it("marks identical texts as all-kept, no lines from splitting", () => {
    expect(marks(diffLines("a\nb", "a\nb"))).toBe(".a .b");
  });

  it("treats the empty string as zero lines, not one empty line", () => {
    expect(diffLines("", "")).toEqual([]);
    expect(marks(diffLines("", "x"))).toBe("+x");
    expect(marks(diffLines("x\ny", ""))).toBe("-x -y");
  });

  it("finds the common middle of a plain edit", () => {
    // One line changed in the middle: kept context on both sides, the old
    // line removed before the new line is added.
    expect(marks(diffLines("header\nold()\ntail", "header\nnew()\ntail"))).toBe(
      ".header -old() +new() .tail"
    );
  });

  it("inserts and deletes at both ends", () => {
    expect(marks(diffLines("keep\nend", "start\nkeep\nend\nextra"))).toBe(
      "+start .keep .end +extra"
    );
    expect(marks(diffLines("start\nkeep\nend\nextra", "keep\nend"))).toBe(
      "-start .keep .end -extra"
    );
  });

  it("keeps repeated lines attached to the right run", () => {
    // Duplicated lines are where a naive diff mispairs; the LCS must keep
    // the first run where it was and mark only the real addition.
    expect(marks(diffLines("x\nx\nx", "x\nx\nx\nx"))).toBe(".x .x .x +x");
  });

  it("splits on CRLF the same as LF", () => {
    expect(marks(diffLines("a\r\nb", "a\nb\r\n"))).toBe(".a .b");
    expect(marks(diffLines("a\r\nb", "a\nc"))).toBe(".a -b +c");
  });

  it("ignores one trailing line break on either side", () => {
    expect(diffLines("a\nb\n", "a\nb")).toEqual(diffLines("a\nb", "a\nb"));
  });

  it("degrades to whole-old-then-whole-new over the cell ceiling", () => {
    // A pair of texts whose exact matrix is over MAX_DIFF_CELLS: the diff
    // must still answer, with every old line removed and every new line
    // added — coarse but complete, and never claiming a line is unchanged.
    const n = 3000;
    const oldText = Array.from({ length: n }, (_, i) => `o${i}`).join("\n");
    const newText = Array.from({ length: n }, (_, i) => `n${i}`).join("\n");
    expect(n * n).toBeGreaterThan(MAX_DIFF_CELLS);
    const d = diffLines(oldText, newText);
    expect(d).toHaveLength(n * 2);
    expect(d.slice(0, n).every((l) => l.kind === "del")).toBe(true);
    expect(d.slice(n).every((l) => l.kind === "add")).toBe(true);
    // And a shared line is NOT called kept in the degraded form.
    const shared = diffLines(`x\n${oldText}`, `x\n${newText}`);
    expect(shared.some((l) => l.kind === "same")).toBe(false);
  });

  it("never mislabels a changed line as kept (mutation anchor)", () => {
    // The property the dialog's honesty rests on: no line appears as
    // "same" unless it is present in BOTH texts.
    const d = diffLines("a\nsecret()\nb", "a\nharmless()\nb");
    const kept = d.filter((l) => l.kind === "same").map((l) => l.text);
    expect(kept).toContain("a");
    expect(kept).toContain("b");
    expect(kept).not.toContain("secret()");
  });
});
