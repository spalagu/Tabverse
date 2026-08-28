import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsView } from "./SettingsView";
import { SETTINGS_SECTIONS } from "./settingsSections";
import { STR } from "../strings";
import { useStore } from "../state/store";
import { CONFIG_NOT_READ, type ConfigWarning } from "../state/config";
import { themeIds } from "../theme/tokens";


/**
 * The settings page, mounted for real and returned as the element it drew
 * into.
 *
 * Mounted rather than rendered to a string: zustand answers a server render
 * from the store's *initial* state, so a page rendered that way shows what
 * the app looked like before it read anything — which for these banners is
 * always "no banner", and every assertion below would pass against a page
 * that draws nothing at all.
 */
function renderSettings(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  flushSync(() => root.render(createElement(SettingsView)));
  mounted.push(() => {
    flushSync(() => root.unmount());
    host.remove();
  });
  return host;
}

const mounted: Array<() => void> = [];

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.();
});

/** The parser's own report, as config_get rejects with it. */
const LOCATED_ERROR =
  "/home/u/.config/tabverse/config.toml:3:17: sidebar_width must be " +
  "between 180 and 520 — 999 is not\n" +
  "  |\n" +
  "3 | sidebar_width = 999\n" +
  "  |                 ^^^\n";

const WARNINGS: ConfigWarning[] = [
  {
    key: "appearance.sidebar_wdith",
    path: "/home/u/.config/tabverse/config.toml",
    line: 4,
    column: 1,
  },
  {
    key: "browser.serch_engine",
    path: "/home/u/.config/tabverse/config.toml",
    line: 12,
    column: 1,
  },
];

const quiet = () =>
  useStore.setState({
    configError: null,
    configWarnings: [],
    configWarningsDismissed: false,
    configPath: null,
  });

afterEach(quiet);

describe("a configuration file that could not be read", () => {
  it("says nothing at all while the file is fine", () => {
    quiet();
    expect(renderSettings().querySelector(".settings-banner")).toBeNull();
  });

  it("carries the report whole: line, column, source line and caret", () => {
    quiet();
    useStore.setState({
      configError: LOCATED_ERROR,
      configPath: "/home/u/.config/tabverse/config.toml",
    });
    const banner = renderSettings().querySelector(".settings-banner.danger");
    expect(banner, "the error banner").not.toBeNull();

    const detail = banner!.querySelector(".settings-banner-detail");
    expect(detail, "the report is shown, not summarized").not.toBeNull();
    const text = detail!.textContent ?? "";
    // Each part named separately: a failure should say which half of "where
    // is it" went missing.
    expect(text, "the line and column").toContain(":3:17:");
    expect(text, "the source line").toContain("sidebar_width = 999");
    expect(text, "the caret under the value").toContain("^^^");
    expect(text, "the sentence in the user's terms").toContain(
      "must be between 180 and 520"
    );
  });

  it("draws the report in a monospaced, scrollable block", () => {
    // Not decoration: the caret line points at the right column only in a
    // monospaced face, and a long source line has to scroll inside the
    // banner rather than widen the whole page.
    quiet();
    useStore.setState({ configError: LOCATED_ERROR });
    const detail = renderSettings().querySelector(".settings-banner-detail");
    expect(detail!.tagName.toLowerCase()).toBe("pre");
    const css = readStylesheet();
    const rule = ruleFor(css, ".settings-banner-detail");
    expect(rule, ".settings-banner-detail must be styled").not.toBeNull();
    expect(rule!, "monospace").toContain("var(--font-mono)");
    expect(rule!, "scrolls on its own").toContain("overflow-x: auto");
  });

  it("offers to show the file, and only when it knows which one", () => {
    quiet();
    useStore.setState({
      configError: LOCATED_ERROR,
      configPath: "/home/u/.config/tabverse/config.toml",
    });
    const withPath = renderSettings().querySelector(".settings-banner.danger");
    expect(withPath!.textContent).toContain(STR.settings.config.openFile);

    quiet();
    useStore.setState({ configError: "something went wrong", configPath: null });
    const withoutPath = renderSettings().querySelector(
      ".settings-banner.danger"
    );
    expect(withoutPath, "the banner still appears").not.toBeNull();
    expect(withoutPath!.textContent).not.toContain(STR.settings.config.openFile);
  });

  it("stays: it is a standing condition, and carries no way to close it", () => {
    quiet();
    useStore.setState({ configError: LOCATED_ERROR, configPath: "/c.toml" });
    const banner = renderSettings().querySelector(".settings-banner.danger");
    expect(banner!.textContent).not.toContain(
      STR.settings.config.dismissWarnings
    );
    // Announced, not merely drawn: the page may be opened long after the
    // failure, and this is the first thing on it that matters.
    expect(banner!.getAttribute("role")).toBe("alert");
  });

  it("takes every word from the strings table", () => {
    quiet();
    useStore.setState({ configError: LOCATED_ERROR, configPath: "/c.toml" });
    const banner = renderSettings().querySelector(".settings-banner.danger");
    const text = banner!.textContent ?? "";
    expect(text).toContain(STR.settings.config.errorHeading);
    expect(text).toContain(STR.settings.config.errorBlurb);
  });
});

describe("keys the file names that we do not know", () => {
  it("lists every one of them with its line", () => {
    quiet();
    useStore.setState({ configWarnings: WARNINGS });
    const banner = renderSettings().querySelector(".settings-banner.warn");
    expect(banner, "the warning banner").not.toBeNull();

    const items = Array.from(banner!.querySelectorAll("li")).map(
      (li) => li.textContent ?? ""
    );
    expect(items.length, "one row per warning").toBe(WARNINGS.length);
    for (const w of WARNINGS) {
      const row = items.find((t) => t.includes(w.key));
      expect(row, `${w.key} is listed`).toBeDefined();
      // The line number is the whole point: "somewhere in your file there is
      // a typo" is not something anyone can act on.
      expect(row, `${w.key} carries its line`).toContain(String(w.line));
      expect(row).toBe(
        STR.settings.config.warningLine({ line: w.line, key: w.key })
      );
    }
  });

  it("can be closed, unlike the error", () => {
    quiet();
    useStore.setState({ configWarnings: WARNINGS });
    const banner = renderSettings().querySelector(".settings-banner.warn");
    expect(banner!.textContent).toContain(STR.settings.config.dismissWarnings);

    quiet();
    useStore.setState({
      configWarnings: WARNINGS,
      configWarningsDismissed: true,
    });
    expect(
      renderSettings().querySelector(".settings-banner.warn"),
      "closed stays closed"
    ).toBeNull();
  });

  it("does not stop the page from being a settings page", () => {
    quiet();
    useStore.setState({ configError: LOCATED_ERROR, configWarnings: WARNINGS });
    const doc = renderSettings();
    const sections = Array.from(doc.querySelectorAll("section"));
    expect(sections.length).toBe(SETTINGS_SECTIONS.length);
    for (const banner of Array.from(doc.querySelectorAll(".settings-banner"))) {
      expect(banner.closest("section"), "a banner is not inside a section")
        .toBeNull();
    }
  });
});

describe("a setting that has not been read", () => {
  it("shows no value and takes no input", () => {
    quiet();
    useStore.setState({ ...CONFIG_NOT_READ });
    const page = renderSettings();

    const selects = Array.from(
      page.querySelectorAll<HTMLSelectElement>("select.settings-select")
    );
    expect(selects.length, "the two dropdown settings").toBeGreaterThanOrEqual(2);
    for (const el of selects) {
      // Not "the default is showing": nothing is, because nothing is known.
      // A dropdown sitting on a value the file never gave is how a user ends
      // up believing a setting is something it is not.
      expect(el.value, "no option is selected").toBe("");
      expect(el.disabled, "and it cannot be changed").toBe(true);
    }

    const themeButtons = Array.from(
      page.querySelectorAll<HTMLButtonElement>(".segmented-btn")
    );
    expect(themeButtons.length).toBe(themeIds().length + 1);
    for (const b of themeButtons) {
      expect(b.getAttribute("aria-checked"), "none is the chosen one").toBe(
        "false"
      );
      expect(b.disabled).toBe(true);
    }
  });

  it("judges each setting on its own, not on the whole set", () => {
    // The theme has a cold-start path of its own and is usually known before
    // the file has been read at all. One flag for all six would switch the
    // theme control off for no reason.
    quiet();
    useStore.setState({ ...CONFIG_NOT_READ, themePreference: "dark" });
    const page = renderSettings();
    for (const b of Array.from(
      page.querySelectorAll<HTMLButtonElement>(".segmented-btn")
    )) {
      expect(b.disabled, "the theme is known, so it is offered").toBe(false);
    }
    for (const el of Array.from(
      page.querySelectorAll<HTMLSelectElement>("select.settings-select")
    )) {
      expect(el.disabled, "the others are not").toBe(true);
    }
  });
});

// ---------------------------------------------------------------- helpers

let stylesheet: string | null = null;

/** The application stylesheet, read once. */
function readStylesheet(): string {
  if (stylesheet === null) {
    // Node imports are legal here: this is a test, and the file is read as
    // text rather than as a module.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const { resolve } = require("node:path") as typeof import("node:path");
    stylesheet = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
  }
  return stylesheet;
}

/** The body of the first rule whose selector list names `selector`. */
function ruleFor(css: string, selector: string): string | null {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) return null;
  const end = css.indexOf("}", at);
  return end === -1 ? null : css.slice(at, end);
}
