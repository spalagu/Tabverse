import { describe, expect, it } from "vitest";
import {
  SEARCH_HISTORY_MAX,
  historyStep,
  mergeSearchHistory,
  sameSearchParams,
  type SearchParams,
} from "./searchHistory";


const p = (over: Partial<SearchParams> = {}): SearchParams => ({
  query: "needle",
  replacement: "",
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  include: null,
  exclude: null,
  ...over,
});

describe("mergeSearchHistory", () => {
  it("brings the whole package to the front; only an exact repeat dies", () => {
    const list = [p({ query: "a" }), p({ query: "b", caseSensitive: true })];
    // Same word, different toggles: a different question, both stay.
    const grew = mergeSearchHistory(list, p({ query: "a", caseSensitive: true }));
    expect(grew.map((x) => x.query)).toEqual(["a", "a", "b"]);
    // The exact package is a repeat: it moves, it does not duplicate.
    const repeat = mergeSearchHistory(list, p({ query: "a" }));
    expect(repeat.map((x) => x.query)).toEqual(["a", "b"]);
  });

  it("caps at 50, dropping the oldest", () => {
    // Newest first, like the stored list: q0 is the freshest of the old.
    const many = Array.from({ length: SEARCH_HISTORY_MAX }, (_, i) =>
      p({ query: `q${i}` })
    );
    const next = mergeSearchHistory(many, p({ query: "fresh" }));
    expect(next).toHaveLength(SEARCH_HISTORY_MAX);
    expect(next[0].query).toBe("fresh");
    // The oldest (the tail, not the head) fell off to make room.
    expect(next.map((x) => x.query)).not.toContain(
      `q${SEARCH_HISTORY_MAX - 1}`
    );
  });

  it("ignores a blank query without touching the list", () => {
    const list = [p({ query: "a" })];
    expect(mergeSearchHistory(list, p({ query: "   " }))).toEqual(list);
  });
});

describe("sameSearchParams", () => {
  it("compares every field, globs included", () => {
    expect(sameSearchParams(p(), p())).toBe(true);
    expect(sameSearchParams(p(), p({ include: "**/*.rs" }))).toBe(false);
    expect(sameSearchParams(p(), p({ replacement: "x" }))).toBe(false);
  });
});

describe("historyStep", () => {
  const list = [
    p({ query: "newest" }),
    p({ query: "middle", regex: true }),
    p({ query: "oldest" }),
  ];

  it("steps up into the newest entry, then deeper", () => {
    expect(historyStep(list, -1, -1)).toEqual({
      entry: list[0],
      cursor: 0,
    });
    expect(historyStep(list, 0, -1)).toEqual({ entry: list[1], cursor: 1 });
    // Clamped at the oldest — a held arrow cannot walk off the end.
    expect(historyStep(list, 2, -1)).toEqual({ entry: list[2], cursor: 2 });
  });

  it("steps back down and answers null past the newest, so the caller returns to what was being typed", () => {
    expect(historyStep(list, 2, 1)).toEqual({ entry: list[1], cursor: 1 });
    expect(historyStep(list, 0, 1)).toBeNull();
    // From outside the walk (cursor -1), down does nothing.
    expect(historyStep(list, -1, 1)).toBeNull();
  });

  it("an empty history answers null both ways", () => {
    expect(historyStep([], -1, -1)).toBeNull();
    expect(historyStep([], -1, 1)).toBeNull();
  });
});
