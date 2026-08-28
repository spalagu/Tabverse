import { describe, expect, it } from "vitest";
import {
  HISTORY_MAX,
  VISIT_COALESCE_MS,
  VISITS_MAX,
  filterSites,
  filterVisits,
  groupVisitsByDay,
  isRecordableUrl,
  mergeVisit,
  mergeVisitLog,
  rankSites,
  scoreSite,
  type VisitEntry,
  type VisitLogEntry,
} from "./history";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 7, 3, 12, 0, 0);

function entry(part: Partial<VisitEntry> & { url: string }): VisitEntry {
  return {
    title: "",
    host: new URL(part.url).host,
    visits: 1,
    lastVisit: NOW,
    ...part,
  };
}

describe("isRecordableUrl", () => {
  it("accepts an ordinary page", () => {
    expect(isRecordableUrl("https://example.com/docs")).toBe(true);
  });

  it("rejects nothing at all", () => {
    expect(isRecordableUrl("")).toBe(false);
    expect(isRecordableUrl("   ")).toBe(false);
  });

  it("rejects the blank page in every spelling", () => {
    expect(isRecordableUrl("about:blank")).toBe(false);
    expect(isRecordableUrl("ABOUT:BLANK")).toBe(false);
    expect(isRecordableUrl("about:srcdoc")).toBe(false);
  });

  it("rejects addresses that exist only in memory", () => {
    expect(isRecordableUrl("data:text/html,<p>hi</p>")).toBe(false);
    expect(isRecordableUrl("blob:https://example.com/9f2")).toBe(false);
    expect(isRecordableUrl("javascript:void(0)")).toBe(false);
  });

  it("rejects text that is not an address", () => {
    expect(isRecordableUrl("not a url")).toBe(false);
    expect(isRecordableUrl("https://")).toBe(false);
  });
});

describe("mergeVisit", () => {
  it("never records a blank or empty url", () => {
    const list: VisitEntry[] = [];
    for (const bad of ["", "   ", "about:blank", "data:text/plain,x"]) {
      expect(mergeVisit(list, bad, "Title", NOW)).toBe(list);
    }
  });

  it("adds a first visit with its host", () => {
    const [e] = mergeVisit([], "https://news.example.com/top", "Top", NOW);
    expect(e).toEqual({
      url: "https://news.example.com/top",
      title: "Top",
      host: "news.example.com",
      visits: 1,
      lastVisit: NOW,
    });
  });

  it("counts a later visit to the same address", () => {
    const first = mergeVisit([], "https://a.example/", "A", NOW);
    const second = mergeVisit(first, "https://a.example/", "A", NOW + 2 * DAY);
    expect(second).toHaveLength(1);
    expect(second[0].visits).toBe(2);
    expect(second[0].lastVisit).toBe(NOW + 2 * DAY);
  });

  it("takes the title of a page still settling without counting it twice", () => {
    const load = mergeVisit([], "https://a.example/", "", NOW);
    const titled = mergeVisit(load, "https://a.example/", "Real Title", NOW + 400);
    expect(titled[0].visits).toBe(1);
    expect(titled[0].title).toBe("Real Title");
  });

  it("counts again once the page has settled", () => {
    const load = mergeVisit([], "https://a.example/", "A", NOW);
    const later = mergeVisit(
      load,
      "https://a.example/",
      "A",
      NOW + VISIT_COALESCE_MS + 1
    );
    expect(later[0].visits).toBe(2);
  });

  it("keeps the old title when a later load reports none", () => {
    const load = mergeVisit([], "https://a.example/", "Kept", NOW);
    const again = mergeVisit(load, "https://a.example/", "", NOW + DAY);
    expect(again[0].title).toBe("Kept");
  });

  it("leaves the input untouched (callers compare by identity)", () => {
    const list = mergeVisit([], "https://a.example/", "A", NOW);
    const next = mergeVisit(list, "https://b.example/", "B", NOW);
    expect(list).toHaveLength(1);
    expect(next).toHaveLength(2);
  });

  it("caps the store and drops the weakest entry", () => {
    // A full store where site 0 is the stalest: everyone else was visited
    // today, it was visited once, a year ago.
    const full: VisitEntry[] = [];
    for (let i = 0; i < HISTORY_MAX; i++) {
      full.push(
        entry({
          url: `https://s${i}.example/`,
          visits: i === 0 ? 1 : 3,
          lastVisit: i === 0 ? NOW - 365 * DAY : NOW,
        })
      );
    }
    const next = mergeVisit(full, "https://fresh.example/", "Fresh", NOW);
    expect(next).toHaveLength(HISTORY_MAX);
    expect(next.some((e) => e.url === "https://fresh.example/")).toBe(true);
    expect(next.some((e) => e.url === "https://s0.example/")).toBe(false);
  });
});

describe("rankSites", () => {
  it("puts today's few visits above last month's many", () => {
    const ranked = rankSites(
      [
        entry({ url: "https://old.example/", visits: 20, lastVisit: NOW - 30 * DAY }),
        entry({ url: "https://today.example/", visits: 5, lastVisit: NOW }),
      ],
      NOW
    );
    expect(ranked.map((e) => e.host)).toEqual(["today.example", "old.example"]);
  });

  it("prefers the more frequent site when both were visited just now", () => {
    const ranked = rankSites(
      [
        entry({ url: "https://rare.example/", visits: 1 }),
        entry({ url: "https://daily.example/", visits: 30 }),
      ],
      NOW
    );
    expect(ranked[0].host).toBe("daily.example");
  });

  it("prefers the more frequent site when both are equally stale", () => {
    const ranked = rankSites(
      [
        entry({ url: "https://rare.example/", visits: 2, lastVisit: NOW - 10 * DAY }),
        entry({ url: "https://often.example/", visits: 9, lastVisit: NOW - 10 * DAY }),
      ],
      NOW
    );
    expect(ranked[0].host).toBe("often.example");
  });

  it("halves a site's score after one half-life of silence", () => {
    const site = entry({ url: "https://a.example/", visits: 8 });
    const fresh = scoreSite(site, NOW);
    const week = scoreSite(site, NOW + 7 * DAY);
    expect(week).toBeCloseTo(fresh / 2, 10);
  });

  it("does not reward a clock that ran backwards", () => {
    const future = entry({ url: "https://a.example/", visits: 3, lastVisit: NOW + DAY });
    const now = entry({ url: "https://b.example/", visits: 3, lastVisit: NOW });
    expect(scoreSite(future, NOW)).toBe(scoreSite(now, NOW));
  });

  it("orders identically scored sites stably and leaves the input alone", () => {
    const input = [
      entry({ url: "https://b.example/" }),
      entry({ url: "https://a.example/" }),
    ];
    expect(rankSites(input, NOW).map((e) => e.host)).toEqual([
      "a.example",
      "b.example",
    ]);
    expect(input.map((e) => e.host)).toEqual(["b.example", "a.example"]);
  });
});

describe("filterSites", () => {
  const sites = [
    entry({ url: "https://news.example.com/world", title: "World News" }),
    entry({ url: "https://docs.rust-lang.org/book/", title: "The Rust Book" }),
    entry({ url: "https://github.com/tabverse", title: "tabverse" }),
  ];

  it("returns everything for an empty query", () => {
    expect(filterSites(sites, "")).toHaveLength(3);
    expect(filterSites(sites, "   ")).toHaveLength(3);
  });

  it("matches the host", () => {
    expect(filterSites(sites, "rust-lang").map((e) => e.title)).toEqual([
      "The Rust Book",
    ]);
  });

  it("matches the title, ignoring case", () => {
    expect(filterSites(sites, "world news").map((e) => e.host)).toEqual([
      "news.example.com",
    ]);
  });

  it("matches deeper in the address than the host", () => {
    expect(filterSites(sites, "/book").map((e) => e.title)).toEqual([
      "The Rust Book",
    ]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterSites(sites, "zzz")).toEqual([]);
  });

  it("hands back a copy, not the list it was given", () => {
    expect(filterSites(sites, "")).not.toBe(sites);
  });
});


describe("mergeVisitLog", () => {
  it("never records a blank or in-memory address", () => {
    const list: VisitLogEntry[] = [];
    for (const bad of ["", "   ", "about:blank", "data:text/plain,x"]) {
      expect(mergeVisitLog(list, bad, "Title", NOW)).toBe(list);
    }
  });

  it("prepends a new arrival (newest first)", () => {
    const one = mergeVisitLog([], "https://a.example/", "A", NOW);
    const two = mergeVisitLog(one, "https://b.example/", "B", NOW + 60_000);
    expect(two.map((e) => e.url)).toEqual([
      "https://b.example/",
      "https://a.example/",
    ]);
  });

  it("coalesces the settling window into one line and takes the title", () => {
    const load = mergeVisitLog([], "https://a.example/", "", NOW);
    const titled = mergeVisitLog(load, "https://a.example/", "Real", NOW + 400);
    expect(titled).toHaveLength(1);
    expect(titled[0].title).toBe("Real");
  });

  it("logs the same address again once the window has passed", () => {
    const load = mergeVisitLog([], "https://a.example/", "A", NOW);
    const later = mergeVisitLog(
      load,
      "https://a.example/",
      "A",
      NOW + VISIT_COALESCE_MS + 1
    );
    expect(later).toHaveLength(2);
  });

  it("keeps a settling title update from touching another tab's newer line", () => {
    // Tab 1 lands on A, tab 2 lands on B, then A's title arrives: the title
    // must fill in A's existing line, not spawn a duplicate above B.
    const a = mergeVisitLog([], "https://a.example/", "", NOW);
    const b = mergeVisitLog(a, "https://b.example/", "B", NOW + 1000);
    const titled = mergeVisitLog(b, "https://a.example/", "A!", NOW + 2000);
    expect(titled).toHaveLength(2);
    expect(titled.find((e) => e.url === "https://a.example/")?.title).toBe("A!");
  });

  it("keeps an earlier title when a repeat inside the window reports none", () => {
    const load = mergeVisitLog([], "https://a.example/", "Kept", NOW);
    const again = mergeVisitLog(load, "https://a.example/", "", NOW + 400);
    expect(again[0].title).toBe("Kept");
  });

  it("caps the log by dropping the oldest lines", () => {
    let log: VisitLogEntry[] = [];
    for (let i = 0; i < VISITS_MAX + 5; i++) {
      log = mergeVisitLog(
        log,
        `https://s${i}.example/`,
        "",
        NOW + i * (VISIT_COALESCE_MS + 1)
      );
    }
    expect(log).toHaveLength(VISITS_MAX);
    // Newest survives at the top; the very first arrivals are gone.
    expect(log[0].url).toBe(`https://s${VISITS_MAX + 4}.example/`);
    expect(log.some((e) => e.url === "https://s0.example/")).toBe(false);
  });

  it("leaves the input untouched (callers compare by identity)", () => {
    const list = mergeVisitLog([], "https://a.example/", "A", NOW);
    const next = mergeVisitLog(list, "https://b.example/", "B", NOW + 60_000);
    expect(list).toHaveLength(1);
    expect(next).toHaveLength(2);
  });
});

describe("filterVisits", () => {
  const log: VisitLogEntry[] = [
    { url: "https://news.example.com/world", title: "World News", at: NOW },
    { url: "https://docs.rust-lang.org/book/", title: "The Rust Book", at: NOW },
  ];

  it("returns everything for an empty query, as a copy", () => {
    expect(filterVisits(log, "  ")).toHaveLength(2);
    expect(filterVisits(log, "")).not.toBe(log);
  });

  it("matches title and address, ignoring case", () => {
    expect(filterVisits(log, "world news").map((e) => e.url)).toEqual([
      "https://news.example.com/world",
    ]);
    expect(filterVisits(log, "RUST-LANG").map((e) => e.title)).toEqual([
      "The Rust Book",
    ]);
    expect(filterVisits(log, "zzz")).toEqual([]);
  });
});

describe("groupVisitsByDay", () => {
  // Half past noon, so the calendar boundaries sit well inside the data.
  const noonish = new Date(2026, 7, 3, 12, 30, 0).getTime();
  const visit = (at: number): VisitLogEntry => ({
    url: "https://a.example/",
    title: "",
    at,
  });

  it("splits on local midnights, not on 24-hour ages", () => {
    const twoHoursAgo = visit(noonish - 2 * 3_600_000); // today
    const lastEvening = visit(noonish - 16 * 3_600_000); // yesterday, <24h ago
    const beforeThat = visit(noonish - 40 * 3_600_000); // two days back
    const g = groupVisitsByDay([twoHoursAgo, lastEvening, beforeThat], noonish);
    expect(g.today).toEqual([twoHoursAgo]);
    expect(g.yesterday).toEqual([lastEvening]);
    expect(g.earlier).toEqual([beforeThat]);
  });

  it("counts a future-stamped visit (clock ran backwards) as today", () => {
    const g = groupVisitsByDay([visit(noonish + 3_600_000)], noonish);
    expect(g.today).toHaveLength(1);
  });

  it("keeps each shelf in the order it was given", () => {
    const a = visit(noonish - 1000);
    const b = visit(noonish - 2000);
    const g = groupVisitsByDay([a, b], noonish);
    expect(g.today).toEqual([a, b]);
  });
});
