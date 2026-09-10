import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsView } from "./SettingsView";
import {
  CURRENT_SECTION_SLACK_PX,
  SETTINGS_JUMP_PREFIX,
  SETTINGS_SECTIONS,
  currentSectionAt,
  parseSettingsJump,
  settingsJumpTarget,
} from "./settingsSections";

/** The settings page as markup, parsed back into a document to query. */
function renderSettings(): Document {
  const html = renderToStaticMarkup(createElement(SettingsView));
  return new DOMParser().parseFromString(html, "text/html");
}

const EXPECTED_SECTION_COUNT = 18;

describe("settings section anchors", () => {
  it("gives every rendered section an id, all distinct", () => {
    const sections = Array.from(renderSettings().querySelectorAll("section"));
    expect(sections.length).toBe(EXPECTED_SECTION_COUNT);

    const ids = sections.map((s) => s.getAttribute("id"));
    // Named individually, so a failure says which section lost its anchor
    // instead of only that some count is off.
    const missing = sections
      .map((s, i) => ({ i, id: s.getAttribute("id") }))
      .filter((e) => e.id === null || e.id === "")
      .map((e) => `section #${e.i + 1}`);
    expect(missing, "sections without an id").toEqual([]);
    expect(new Set(ids).size, "ids must be distinct").toBe(ids.length);
  });

  it("renders the sections in the order the section list declares", () => {
    const ids = Array.from(renderSettings().querySelectorAll("section")).map(
      (s) => s.getAttribute("id")
    );
    expect(ids).toEqual(SETTINGS_SECTIONS.map((s) => s.id));
  });

  it("absorbed the certificates section into sites, leaving no empty shell", () => {
    const ids = Array.from(renderSettings().querySelectorAll("section")).map(
      (s) => s.getAttribute("id")
    );
    expect(ids).toContain("sites");
    expect(ids).not.toContain("certificates");
    expect(parseSettingsJump("settings:certificates")).toBeNull();
    expect(parseSettingsJump("settings:sites")).toBe("sites");
  });
});

describe("settings section rail", () => {
  it("has one entry per section, each pointing at a section that exists", () => {
    const doc = renderSettings();
    const sectionIds = new Set(
      Array.from(doc.querySelectorAll("section")).map((s) =>
        s.getAttribute("id")
      )
    );
    const items = Array.from(doc.querySelectorAll(".settings-nav-item"));
    expect(items.length).toBe(sectionIds.size);

    for (const item of items) {
      const target = item.getAttribute("data-target");
      expect(target, "rail entry must carry a jump target").not.toBeNull();
      expect(target!.startsWith(SETTINGS_JUMP_PREFIX)).toBe(true);
      const id = target!.slice(SETTINGS_JUMP_PREFIX.length);
      expect(sectionIds.has(id), `${target} has no section`).toBe(true);
    }
  });

  it("takes its wording from the section headings, never a second copy", () => {
    const doc = renderSettings();
    const headingById = new Map<string, string>();
    for (const section of Array.from(doc.querySelectorAll("section"))) {
      const id = section.getAttribute("id");
      const h3 = section.querySelector("h3");
      if (id && h3) headingById.set(id, h3.textContent ?? "");
    }

    const items = Array.from(doc.querySelectorAll(".settings-nav-item"));
    expect(items.length).toBe(headingById.size);
    for (const item of items) {
      const id = item
        .getAttribute("data-target")!
        .slice(SETTINGS_JUMP_PREFIX.length);
      expect(item.textContent, `rail entry for #${id}`).toBe(
        headingById.get(id)
      );
    }
  });

  it("names itself for screen readers", () => {
    const nav = renderSettings().querySelector("nav.settings-nav");
    expect(nav).not.toBeNull();
    expect(nav!.getAttribute("aria-label")).toBeTruthy();
  });

  it("marks exactly one entry as the one being read", () => {
    const doc = renderSettings();
    const current = Array.from(
      doc.querySelectorAll(".settings-nav-item[aria-current]")
    );
    expect(current.length).toBe(1);
    expect(current[0].className).toContain("active");
  });
});

describe("which section is being read", () => {
  // Three sections at 0 / 400 / 800 in a 300-tall page over 1100 of content.
  const offsets = (scrollTop: number) => [
    { id: "first", top: 0 - scrollTop },
    { id: "second", top: 400 - scrollTop },
    { id: "third", top: 800 - scrollTop },
  ];
  const view = (scrollTop: number) => ({
    clientHeight: 300,
    scrollHeight: 1100,
    scrollTop,
  });

  it("names the last section that has passed the top of the page", () => {
    expect(currentSectionAt(offsets(0), view(0))).toBe("first");
    expect(currentSectionAt(offsets(300), view(300))).toBe("first");
    expect(currentSectionAt(offsets(400), view(400))).toBe("second");
    expect(currentSectionAt(offsets(500), view(500))).toBe("second");
    expect(currentSectionAt(offsets(790), view(790))).toBe("third");
  });

  it("counts a section as reached a slack of pixels early", () => {
    // Scrolled to just short of the second section: within the slack it is
    // already the answer, a pixel outside it is not.
    const nearly = 400 - CURRENT_SECTION_SLACK_PX;
    expect(currentSectionAt(offsets(nearly), view(nearly))).toBe("second");
    expect(currentSectionAt(offsets(nearly - 1), view(nearly - 1))).toBe(
      "first"
    );
  });

  it("gives the bottom of the scroll to the last section", () => {
    // The page bottoms out at 800, where the third section's top is still
    // 0px down the page — reachable only because of this rule. Without it
    // the answer here would be "third" by coincidence, so the case that
    // matters is a final section too short to reach the top at all.
    const short = [
      { id: "first", top: -800 },
      { id: "second", top: -400 },
      { id: "tiny", top: 260 },
    ];
    expect(
      currentSectionAt(short, { clientHeight: 300, scrollHeight: 1100, scrollTop: 800 })
    ).toBe("tiny");
    expect(
      currentSectionAt(short, { clientHeight: 300, scrollHeight: 1100, scrollTop: 700 })
    ).toBe("second");
  });

  it("declines to judge a page that has no height", () => {
    // A settings tab that is mounted but is not the tab on screen. Every
    // rectangle reads zero, which would otherwise look like the bottom.
    expect(
      currentSectionAt(
        [
          { id: "first", top: 0 },
          { id: "second", top: 0 },
        ],
        { clientHeight: 0, scrollHeight: 0, scrollTop: 0 }
      )
    ).toBeNull();
  });

  it("handles a page short enough not to scroll", () => {
    expect(
      currentSectionAt(offsets(0), {
        clientHeight: 1100,
        scrollHeight: 1100,
        scrollTop: 0,
      })
    ).toBe("first");
  });
});

describe("settings:<id> jump targets", () => {
  it("round-trips every section id", () => {
    for (const s of SETTINGS_SECTIONS) {
      expect(settingsJumpTarget(s.id)).toBe(`${SETTINGS_JUMP_PREFIX}${s.id}`);
      expect(parseSettingsJump(settingsJumpTarget(s.id))).toBe(s.id);
      expect(parseSettingsJump(s.id)).toBe(s.id);
    }
  });

  it("refuses a target no section answers to", () => {
    // Refused, not silently resolved to something nearby: guidance that
    // points at a setting which no longer exists must be able to tell.
    expect(parseSettingsJump("settings:colour-scheme")).toBeNull();
    expect(parseSettingsJump("appearances")).toBeNull();
    expect(parseSettingsJump("")).toBeNull();
  });

  it("uses ids that are words, not positions", () => {
    for (const s of SETTINGS_SECTIONS) {
      expect(s.id, `${s.id} must be a lowercase word`).toMatch(
        /^[a-z][a-z-]*[a-z]$/
      );
      expect(s.id, `${s.id} must not be a number`).not.toMatch(/\d/);
    }
  });
});
