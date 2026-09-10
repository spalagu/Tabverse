import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => unknown>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

import { flushAll } from "../persist";
import {
  CONFIG_NOT_READ,
  NETWORK_KEYS,
  choiceOptions,
  flushConfigWrites,
  type ConfigValues,
  type Setting,
} from "../state/config";
import { useStore } from "../state/store";
import { STR } from "../strings";
import { SettingsView, type SettingsViewProps } from "./SettingsView";
import { SETTINGS_SECTIONS } from "./settingsSections";
import { strAt } from "./settingsSearch";

/**
 * The key this page writes the switch to.
 *
 * Spelled here rather than imported, on purpose: this is the assertion that
 * the page and the file agree on ONE string, and importing the page's own
 * constant would assert only that it equals itself. The last describe ties
 * this literal to the registry's own spelling.
 */
const COVER_KEY = "network.cover_page_traffic";

function config(network: Record<string, unknown> | null): ConfigValues {
  return {
    appearance: { theme: "light", sidebar_width: 301, sidebar_pinned: false },
    browser: {
      search_engine: "duckduckgo",
      custom_search_template: "",
      archive_after: "24h",
    },
    // Cast at this one boundary on purpose: the whole point of `serve` is
    // to hand the page shapes a real core might send — a `[network]`
    // missing the page-traffic key among them — and those are not shapes
    // the wire type would let this file write down.
    network: (network ?? undefined) as ConfigValues["network"],
  };
}

/** Serve the page, with `[network]` as given — null meaning a core that has
 *  never heard of this section. */
function serve(network: Record<string, unknown> | null) {
  mocks.invoke.mockImplementation(async (cmd) => {
    if (cmd === "config_schema") return [];
    if (cmd === "config_get") {
      return { values: config(network), warnings: [], sources: ["/x"] };
    }
    if (cmd === "app_health") {
      return { shellIntegration: false, homeDir: "/home/u", version: "0.0.0" };
    }
    if (cmd === "list_trusted_hosts") return [];
    if (cmd === "default_apps_status") return [];
    // Empty answers rather than undefined for the two list loaders, so a
    // freshly evaluated module graph (see `renderAsMac`) — whose import-time
    // `isTauri` sees the patched window and therefore really asks — renders
    // the empty list rather than crashing on `undefined.length`.
    if (cmd === "media_list") return [];
    if (cmd === "userscripts_list") return [];
    return undefined;
  });
}

async function settle() {
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 20; j++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const mounted: Array<() => void> = [];

function render(props?: SettingsViewProps): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  // The generic is spelled out because the props parameter is optional on
  // the component (it has a default), and inference alone would widen it
  // past the `createElement` constraint rather than read the component's
  // own type off it.
  flushSync(() =>
    root.render(createElement<SettingsViewProps>(SettingsView, props))
  );
  mounted.push(() => {
    flushSync(() => root.unmount());
    host.remove();
  });
  return host;
}

/** The page's text as a Mac would get it, for the one assertion that must
 *  not pass on the development machine's platform by accident.
 *
 *  `IS_MAC` (src/platform.ts) is read once at module evaluation, so the only
 *  honest way to see the Mac's page is to patch `navigator.platform` and
 *  re-evaluate the graph. Fresh modules, one render, the text captured
 *  before the unmount (which empties the host), everything restored. */
async function renderAsMacText(props?: SettingsViewProps): Promise<string> {
  const nav = navigator as unknown as Record<string, unknown>;
  const desc = Object.getOwnPropertyDescriptor(navigator, "platform");
  Object.defineProperty(navigator, "platform", {
    value: "MacIntel",
    configurable: true,
  });
  try {
    vi.resetModules();
    const fresh = await import("./SettingsView");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root: Root = createRoot(host);
    // Same explicit generic as `render` above, for the same reason.
    flushSync(() =>
      root.render(
        createElement<SettingsViewProps>(fresh.SettingsView, props)
      )
    );
    await settle();
    const text = host.textContent ?? "";
    flushSync(() => root.unmount());
    host.remove();
    return text;
  } finally {
    if (desc) Object.defineProperty(navigator, "platform", desc);
    else delete nav.platform;
    vi.resetModules();
  }
}

const control = (host: HTMLElement) =>
  host.querySelector<HTMLButtonElement>(`[data-setting-key="${COVER_KEY}"]`);

const w = () => window as unknown as Record<string, unknown>;

beforeEach(async () => {
  await flushAll();
  await flushConfigWrites();
  localStorage.clear();
  mocks.invoke.mockReset();
  w().__TAURI_INTERNALS__ = {};
  useStore.setState({ ...CONFIG_NOT_READ, themePreference: "system" });
});

afterEach(async () => {
  while (mounted.length > 0) mounted.pop()?.();
  delete w().__TAURI_INTERNALS__;
  await flushConfigWrites();
});

describe("the name-lookup section", () => {
  it("is a section of the page with the three registry keys on it", async () => {
    serve({
      dns_mode: "system",
      dns_custom_url: "",
      cover_page_traffic: false,
    });
    const host = render();
    await settle();
    const doc = new DOMParser().parseFromString(host.innerHTML, "text/html");
    const section = doc.querySelector("section#network");
    expect(section, "the page has no #network section").not.toBeNull();

    // Addressed by the key the FILE uses, which is also what the settings
    // search highlights and what a failed save names. A control the registry
    // cannot address is a control nothing else on this page can reach.
    for (const key of Object.values(NETWORK_KEYS)) {
      expect(
        doc.querySelector(`[data-setting-key="${key}"]`) !== null ||
          // The address box is drawn only in the mode that asks for one, and
          // the mode served here is not it — so its absence is the mode not
          // asking, not the control being missing. The mode select must be
          // there regardless.
          key === NETWORK_KEYS.dnsCustomUrl,
        `no control is bound to ${key}`
      ).toBe(true);
    }
    expect(
      doc.querySelector(`[data-setting-key="${NETWORK_KEYS.dnsMode}"]`),
      "the mode control is missing"
    ).not.toBeNull();
  });

  it("is in the section list, so the rail and the jump target reach it", () => {
    expect(SETTINGS_SECTIONS.some((s) => s.id === "network")).toBe(true);
  });

  it("names every exit the setting does not reach, with the switch off", async () => {
    serve({
      dns_mode: "system",
      dns_custom_url: "",
      cover_page_traffic: false,
    });
    const host = render();
    await settle();
    const text = host.textContent ?? "";
    // Read out of the strings table rather than retyped, so this asserts that
    // the page renders the sentences — not that two copies of them agree.
    const exits = [
      STR.settings.network.uncoveredWebview,
      STR.settings.network.uncoveredRemote,
      STR.settings.network.uncoveredSocket,
      STR.settings.network.uncoveredTerminal,
      STR.settings.network.uncoveredProvider,
    ];
    const missing = exits.filter((line) => !text.includes(line));
    expect(missing, "exits the page does not admit to").toEqual([]);
    // The control: the section really did render, so "found nothing missing"
    // cannot be the empty page passing.
    expect(text).toContain(STR.settings.network.uncoveredHeading);
    expect(text).toContain(STR.settings.network.heading);
    // And the claim of the OTHER state is absent here — an off switch that
    // also said "covered" would be saying it to someone it is not true for.
    expect(text).not.toContain(STR.settings.network.coveredWebview);
  });

  it("says pages are covered when the switch is on and a provider chosen", async () => {
    serve({
      dns_mode: "cloudflare",
      dns_custom_url: "",
      cover_page_traffic: true,
    });
    const host = render();
    await settle();
    const text = host.textContent ?? "";
    expect(text).toContain(STR.settings.network.coveredWebview);
    // Both directions, for the same reason the off test asserts the reverse:
    // the uncovered sentence and the covered sentence are claims about the
    // same tabs, and the page owes each reader exactly one of them.
    expect(text).not.toContain(STR.settings.network.uncoveredWebview);
    expect(text).not.toContain(STR.settings.network.coverDownWebview);
    expect(control(host)?.getAttribute("aria-checked")).toBe("true");
  });

  it("keeps the uncovered sentence when the switch is on but no provider is chosen", async () => {
    // The switch rides on the mode above it: with the system resolver
    // chosen there is nothing for page traffic to be carried through, and a
    // claim of coverage here would be false.
    serve({
      dns_mode: "system",
      dns_custom_url: "",
      cover_page_traffic: true,
    });
    const host = render();
    await settle();
    const text = host.textContent ?? "";
    expect(text).toContain(STR.settings.network.uncoveredWebview);
    expect(text).not.toContain(STR.settings.network.coveredWebview);
  });
});

describe("the page-traffic switch", () => {
  it("is a switch that shows what the file says", async () => {
    serve({
      dns_mode: "cloudflare",
      dns_custom_url: "",
      cover_page_traffic: true,
    });
    const host = render();
    await settle();
    const button = control(host)!;
    expect(button.getAttribute("role")).toBe("switch");
    expect(button.getAttribute("aria-checked")).toBe("true");
    expect(button.disabled).toBe(false);
    expect(button.textContent).toBe(STR.settings.appearance.on);
  });

  it("writes the opposite of what it shows, under the file's key", async () => {
    serve({
      dns_mode: "cloudflare",
      dns_custom_url: "",
      cover_page_traffic: true,
    });
    const host = render();
    await settle();

    flushSync(() => control(host)!.click());
    await settle();
    await flushConfigWrites();

    expect(mocks.invoke.mock.calls).toContainEqual([
      "config_set",
      { key: COVER_KEY, value: false },
    ]);
    // And the control moved at once, rather than after a round trip.
    expect(control(host)!.getAttribute("aria-checked")).toBe("false");
    // The sentence moved with it, in the same render — a page that switched
    // the control and kept the covered claim would be contradicting itself.
    expect(host.textContent).not.toContain(STR.settings.network.coveredWebview);
    expect(host.textContent).toContain(STR.settings.network.uncoveredWebview);
  });

  it("refuses to act while the file has not answered, and says why", async () => {
    // A core older than this setting: the `[network]` section arrives with
    // no cover key at all. The switch must not draw a value of its own.
    serve({ dns_mode: "cloudflare", dns_custom_url: "" });
    const host = render();
    await settle();

    const button = control(host)!;
    expect(button.disabled, "an unread switch must not be pressable").toBe(true);
    expect(button.getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).toContain(STR.settings.network.coverUnread);

    // Pressed all the same — a disabled button can still be clicked
    // programmatically, and nothing may be written.
    flushSync(() => button.click());
    await settle();
    await flushConfigWrites();
    const writes = mocks.invoke.mock.calls.filter(
      ([cmd, args]) =>
        cmd === "config_set" &&
        (args as { key?: string } | undefined)?.key === COVER_KEY
    );
    expect(writes, "an unread switch wrote a value").toEqual([]);
  });

  it("says what it carries and when it applies", async () => {
    serve({
      dns_mode: "system",
      dns_custom_url: "",
      cover_page_traffic: false,
    });
    const host = render();
    await settle();
    const text = host.textContent ?? "";
    // From the strings table rather than retyped: this asserts that the page
    // shows the boundary and the timing, not that two copies agree.
    expect(text).toContain(STR.settings.network.coverPageTraffic);
    expect(text).toContain(STR.settings.network.coverNote);
    expect(text).toContain(STR.settings.network.coverWhen);
  });
});

describe("the platform notes and the proxy-down banner", () => {
  it("notes the Windows difference where there is no gate, and no gate note by default", async () => {
    // happy-dom reports a non-Mac platform ("X11; …"), which is the page a
    // Windows machine gets: the difference is said there and only there.
    serve({
      dns_mode: "cloudflare",
      dns_custom_url: "",
      cover_page_traffic: true,
    });
    const host = render();
    await settle();
    const text = host.textContent ?? "";
    expect(text).toContain(STR.settings.network.coverWindowsNote);
    // Coverable-by-default is the honest placeholder (SettingsViewProps):
    // nothing has said this machine cannot be covered, so the gate note is
    // absent rather than guessed at.
    expect(text).not.toContain(STR.settings.network.coverGateNote);
    expect(text).not.toContain(STR.settings.network.proxyDownHeading);
  });

  it("draws neither platform note on a Mac that can be covered", async () => {
    // The Mac's own page: no Windows note there, and still no gate note —
    // the gate note is `isCoverable: false`'s to trigger, not the
    // platform's. Re-evaluated on a patched platform because `IS_MAC` is
    // read once at module load.
    serve({
      dns_mode: "cloudflare",
      dns_custom_url: "",
      cover_page_traffic: true,
    });
    const text = await renderAsMacText();
    expect(text).not.toContain(STR.settings.network.coverWindowsNote);
    expect(text).not.toContain(STR.settings.network.coverGateNote);
    // The page itself still rendered its section, so the absences above are
    // not the empty page passing.
    expect(text).toContain(STR.settings.network.heading);
  });

  it("shows the gate note when the machine cannot be covered", async () => {
    serve({
      dns_mode: "cloudflare",
      dns_custom_url: "",
      cover_page_traffic: true,
    });
    const host = render({ isCoverable: false });
    await settle();
    const text = host.textContent ?? "";
    expect(text).toContain(STR.settings.network.coverGateNote);
    // The claim did not survive the gate: outside it, pages are not covered,
    // whatever the switch says.
    expect(text).not.toContain(STR.settings.network.coveredWebview);
  });

  it("shows the warn banner and the fallen-back sentence when the proxy is down", async () => {
    serve({
      dns_mode: "cloudflare",
      dns_custom_url: "",
      cover_page_traffic: true,
    });
    const host = render({ pageProxyDown: true });
    await settle();
    const text = host.textContent ?? "";
    // The banner, in the section's own colours: what happened, what new
    // tabs do, and what already-open tabs do.
    expect(text).toContain(STR.settings.network.proxyDownHeading);
    expect(text).toContain(STR.settings.network.proxyDownBlurb);
    // The status line fell back with it, and the covered claim is gone —
    // the two would contradict each other over the same tabs.
    expect(text).toContain(STR.settings.network.coverDownWebview);
    expect(text).not.toContain(STR.settings.network.coveredWebview);
  });

  it("shows no banner when coverage was never asked for", async () => {
    // The proxy only runs for someone who asked for it; with the switch
    // off, "down" is not this page's news to break.
    serve({
      dns_mode: "cloudflare",
      dns_custom_url: "",
      cover_page_traffic: false,
    });
    const host = render({ pageProxyDown: true });
    await settle();
    expect(host.textContent ?? "").not.toContain(
      STR.settings.network.proxyDownHeading
    );
    expect(host.textContent ?? "").not.toContain(
      STR.settings.network.coverDownWebview
    );
  });
});

describe("the registry row", () => {
  it("takes the providers on offer from the registry, not from a list here", () => {
    // Two schemas differing only in their domain. A `<select>` with its
    // options written out beside it answers the same both times; one that
    // reads the registry answers differently, which is the whole property.
    const row = (options: string[]): Setting[] => [
      {
        key: NETWORK_KEYS.dnsMode,
        kind: { choice: { options } },
        section: "network",
        str_key: "settings.network.dnsMode",
        default: options[0],
      },
    ];
    expect(choiceOptions(row(["system", "cloudflare"]), NETWORK_KEYS.dnsMode)).toEqual([
      "system",
      "cloudflare",
    ]);
    expect(
      choiceOptions(row(["system", "cloudflare", "google", "quad9"]), NETWORK_KEYS.dnsMode)
    ).toHaveLength(4);
    // A key the schema does not carry, and a key that is not a choice, are
    // both "nothing to offer" — never a guessed list.
    expect(choiceOptions(row(["system"]), NETWORK_KEYS.dnsCustomUrl)).toEqual([]);
    expect(choiceOptions([], NETWORK_KEYS.dnsMode)).toEqual([]);
  });

  it("has the key the file uses, and a title for the row to point at", () => {
    // The literal is pinned in this file and imported nowhere, so this
    // compares the page's spelling with the file's rather than with itself.
    // A rename on either side fails here instead of as a write the core
    // silently refuses.
    const keys = NETWORK_KEYS as unknown as Record<string, string>;
    expect(keys.coverPageTraffic).toBe(COVER_KEY);
    // The row's `str_key` is `settings.network.coverPageTraffic`
    // (src-tauri/src/config.rs). A missing leaf is silent — the settings
    // search indexes the row with a null title — so nothing but this would
    // notice the control losing its name.
    expect(strAt("settings.network.coverPageTraffic")).toBe(
      STR.settings.network.coverPageTraffic
    );
    expect(STR.settings.network.coverPageTraffic.length).toBeGreaterThan(0);
  });
});
