import { describe, expect, it } from "vitest";
import {
  EMPTY_UNDO,
  UNDO_LIMIT,
  forwardFor,
  parentDir,
  planUndo,
  popRedo,
  popUndo,
  recordOp,
  settleRedo,
  settleUndo,
  type UndoEntry,
} from "./undoStack";


const move: UndoEntry = {
  kind: "transfer",
  cut: true,
  src: "/w1/a.txt",
  landed: "/w1/sub/a 2.txt",
};
const copy: UndoEntry = {
  kind: "transfer",
  cut: false,
  src: "/w1/a.txt",
  landed: "/w1/sub/a 2.txt",
};

describe("inverses", () => {
  it("a move goes home from where it LANDED — the yielded name is the one remembered", () => {
    const plan = planUndo(move);
    // From the answer fs_transfer gave, not from the name that was asked
    // for: an inverse built from "/w1/sub/a.txt" would move a file that
    // is not there.
    expect(plan).toEqual({ undo: "transfer", from: "/w1/sub/a 2.txt", into: "/w1" });
  });

  it("every executable inverse names a DIRECTORY, never a bare path back", () => {
    // The shape of the rule: into is always a directory, so the backend's
    // free_name yields when the original name was taken meanwhile. A
    // rename-straight-home plan would put the old absolute path here.
    const cases: [UndoEntry, string][] = [
      [move, move.src],
      [{ kind: "rename", from: "/w1/a.txt", to: "/w1/b.txt" }, "/w1/a.txt"],
    ];
    for (const [entry, startedAt] of cases) {
      const plan = planUndo(entry);
      if (plan.undo !== "transfer") throw new Error("expected a transfer plan");
      // The into is exactly the directory the op started in — a directory,
      // never the old file's absolute path.
      expect(plan.into).toBe(parentDir(startedAt));
      expect(plan.into).not.toContain(".");
    }
  });

  it("a copy's inverse takes the COPY away and leaves the source alone", () => {
    expect(planUndo(copy)).toEqual({ undo: "trash", path: "/w1/sub/a 2.txt" });
  });

  it("a rename's inverse returns to the directory it left, not onto the old name", () => {
    expect(planUndo({ kind: "rename", from: "/w1/a.txt", to: "/w1/b.txt" })).toEqual({
      undo: "transfer",
      from: "/w1/b.txt",
      into: "/w1",
    });
  });

  it("a create's inverse takes the new thing to the Trash", () => {
    expect(planUndo({ kind: "create", path: "/w1/new", dir: true })).toEqual({
      undo: "trash",
      path: "/w1/new",
    });
  });

  it("trash refuses honestly — no API restores from the system Trash", () => {
    expect(planUndo({ kind: "trash", path: "/w1/gone.txt" })).toEqual({
      undo: "none",
      why: "trash",
      path: "/w1/gone.txt",
    });
  });

 it("an overwrite refuses honestly — what Replace destroyed cannot come back", () => {
    // The criterion's red line: if the stack ever recorded an overwrite
    // as an ordinary transfer, this plan would become executable and the
    // undo would reverse a step it promised not to.
    expect(planUndo({ kind: "overwritten", path: "/w1/sub/a.txt" })).toEqual({
      undo: "none",
      why: "overwritten",
      path: "/w1/sub/a.txt",
    });
  });
});

describe("the two stacks", () => {
  it("a new operation clears the redo branch — history forks", () => {
    let st = EMPTY_UNDO;
    st = settleUndo(st, { op: "create", path: "/w1/x", dir: false });
    expect(st.redo).toHaveLength(1);
    st = recordOp(st, move);
    expect(st.redo).toEqual([]);
  });

  it("undo and redo walk without eating each other's remains", () => {
    let st = EMPTY_UNDO;
    st = recordOp(st, move);
    st = recordOp(st, copy);
    st = recordOp(st, { kind: "create", path: "/w1/n.txt", dir: false });

    const u1 = popUndo(st)!;
    expect(u1.entry.kind).toBe("create");
    const u2 = popUndo(u1.state)!;
    expect(u2.entry.kind).toBe("transfer");

    // Redo two, undo one — the oldest step must still be there.
    let st2 = settleUndo(u2.state, forwardFor(u2.entry, null));
    const r1 = popRedo(st2)!;
    // The copy's redo copies the SOURCE again (its inverse took the copy
    // to the Trash; the source is what is still there to copy).
    expect(r1.op).toEqual({ op: "transfer", from: "/w1/a.txt", into: "/w1/sub", cut: false });
    st2 = settleRedo(r1.state, { kind: "transfer", cut: false, src: "/w1/a.txt", landed: "/w1/sub/a.txt" });
    const u3 = popUndo(st2)!;
    // The replayed copy sits on top again — with its FRESH landing, the
    // one the redo's fs_transfer answered.
    expect(u3.entry).toEqual({
      kind: "transfer",
      cut: false,
      src: "/w1/a.txt",
      landed: "/w1/sub/a.txt",
    });
    // And beneath it the move never moved: a replay does not strand the
    // undo stack's past.
    const u4 = popUndo(u3.state)!;
    expect(u4.entry).toEqual(move);
    expect(popUndo(u4.state)).toBeNull();
  });

  it("holds the last 50 steps; older ones fall off", () => {
    let st = EMPTY_UNDO;
    for (let i = 0; i < UNDO_LIMIT + 10; i++) {
      st = recordOp(st, { kind: "trash", path: `/w1/f${i}.txt` });
    }
    expect(st.undo).toHaveLength(UNDO_LIMIT);
    expect(st.undo[0]).toEqual({ kind: "trash", path: `/w1/f${UNDO_LIMIT + 10 - UNDO_LIMIT}.txt` });
    expect(st.undo[st.undo.length - 1]).toEqual({
      kind: "trash",
      path: `/w1/f${UNDO_LIMIT + 9}.txt`,
    });
  });

  it("redo's forward op starts from where the INVERSE landed, not from history", () => {
    // Undo moved the file home and it had to yield there ("/w1/a 2.txt");
    // redo must take it from THERE, or it would move a ghost.
    const op = forwardFor(move, "/w1/a 2.txt");
    expect(op).toEqual({ op: "transfer", from: "/w1/a 2.txt", into: "/w1/sub", cut: true });
  });
});

describe("parentDir", () => {
  it("splits the last segment and never returns empty", () => {
    expect(parentDir("/w1/a.txt")).toBe("/w1");
    expect(parentDir("/w1/sub/a 2.txt")).toBe("/w1/sub");
    expect(parentDir("/a")).toBe("/");
    expect(parentDir("/")).toBe("/");
  });
});
