import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const mocks = vi.hoisted(() => {
  const invoke = vi.fn<(cmd: string, args?: Record<string, unknown>) => unknown>();
  // The real @tauri-apps/api/core `invoke` is a thin forwarder onto
  // window.__TAURI_INTERNALS__.invoke — that IS the desktop's bridge. Faking
  // the bridge instead of vi.mock-ing the package is not a style choice:
  // concurrent dynamic imports of an externalized package can race the
  // mocker (observed in this repo: two imports of the same specifier in one
  // graph, one mocked, one real), while the bridge is a single object every
  // copy of the module reads the same way. The flag also has to be up
  // before SettingsView imports, because its isTauri is a module-level
  // const, not a call.
  const w = globalThis as unknown as Record<string, unknown>;
  w.__TAURI_INTERNALS__ = { invoke };
  return { invoke, confirmAsk: vi.fn<(question: string, opts?: unknown) => Promise<boolean>>() };
});

vi.mock("./Confirm", () => ({ confirmAsk: mocks.confirmAsk }));

import { flushAll } from "../persist";
import {
  CONFIG_NOT_READ,
  flushConfigWrites,
  type ConfigValues,
} from "../state/config";
import { useStore } from "../state/store";
import { rememberZoom, clearZoomMemory, zoomFor } from "../zoomMemory";
import { SettingsView } from "./SettingsView";

/** The certificate exceptions the fake core is holding, mutable by revoke. */
let trustedHosts: string[];
/** The remembered media answers, keyed the way page_prompts.rs keys them. */
let mediaAnswers: { host: string; kind: string; allow: boolean }[];
/** The installed scripts and the domains each was granted. */
let installed: { id: string; name: string; grantedHosts: string[] }[];

function serve() {
  mocks.invoke.mockImplementation(async (cmd, args) => {
    const a = (args ?? {}) as Record<string, string>;
    switch (cmd) {
      case "config_schema":
        return [];
      case "config_get":
        return {
          values: {
            appearance: {
              theme: "light",
              sidebar_width: 301,
              sidebar_pinned: false,
            },
            browser: {
              search_engine: "duckduckgo",
              custom_search_template: "",
              archive_after: "24h",
            },
            terminal: {
              font_family: "",
              font_size: 13,
              line_height_percent: 120,
              ligatures: false,
            },
          } satisfies ConfigValues,
          warnings: [],
          sources: ["/x"],
        };
      case "app_health":
        return { shellIntegration: false, homeDir: "/home/u", version: "0.0.0" };
      case "default_apps_status":
        return [];
      // The fake core holds real stores for the three command-backed kinds,
      // so a revoke is followed by a list refresh that reflects it — the
      // same round trip the panel runs.
      case "list_trusted_hosts":
        return [...trustedHosts];
      case "revoke_trusted_host":
        trustedHosts = trustedHosts.filter((h) => h !== a.host);
        return undefined;
      case "media_list":
        return mediaAnswers.map((m) => ({ ...m }));
      case "media_revoke":
        mediaAnswers = mediaAnswers.filter(
          (m) => !(m.host === a.host && m.kind === a.kind)
        );
        return undefined;
      case "userscripts_list":
        // The full ScriptInfo shape: the Sites panel reads id/name/
        // grantedHosts, but the User scripts section on the same page
        // renders the rest of it too.
        return installed.map((s) => ({
          id: s.id,
          name: s.name,
          version: "1.0",
          enabled: true,
          runAt: "document-idle",
          matches: [] as string[],
          includes: [] as string[],
          excludes: [] as string[],
          grants: [] as string[],
          grantedHosts: [...s.grantedHosts],
        }));
      case "userscript_revoke_grant":
        installed = installed.map((s) =>
          s.id === a.scriptId
            ? { ...s, grantedHosts: s.grantedHosts.filter((h) => h !== a.host) }
            : s
        );
        return undefined;
      default:
        return undefined;
    }
  });
}

async function settle() {
  // The fixed turns below cover the invoke → setState → render chain once
  // the first invoke has happened. The step before it — resolving the
  // dynamic import of @tauri-apps/api/core — has no fixed bound under a
  // fully parallel suite run (observed: zero invokes after every turn,
  // with the whole worker pool racing beside this file, while the same
  // test alone passes instantly). So the first call is waited for by
  // condition, then the turns run as they always did.
  for (let i = 0; i < 200 && mocks.invoke.mock.calls.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  for (let i = 0; i < 5; i++) {
    for (let j = 0; j < 20; j++) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

const mounted: Array<() => void> = [];

function render(): HTMLElement {
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

/** Fire a click the way React hears it, then let the async handlers run. */
async function click(el: Element) {
  flushSync(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await settle();
}

beforeEach(async () => {
  await flushAll();
  await flushConfigWrites();
  localStorage.clear();
  mocks.invoke.mockReset();
  mocks.confirmAsk.mockReset();
  mocks.confirmAsk.mockResolvedValue(true);
  useStore.setState({ ...CONFIG_NOT_READ, themePreference: "system" });
  // The zoom memory is a module singleton: reset it like the fake core's
  // files above, so a test's leftovers are not the next test's data.
  clearZoomMemory();
  trustedHosts = ["self-signed.example"];
  mediaAnswers = [
    { host: "calls.example", kind: "camera", allow: true },
    { host: "calls.example", kind: "microphone", allow: false },
    { host: "meet.example", kind: "camera and microphone", allow: true },
  ];
  installed = [
    { id: "s1", name: "Tidy", grantedHosts: ["forum.example"] },
    { id: "s2", name: "Dark", grantedHosts: ["forum.example", "news.example"] },
  ];
  rememberZoom("big-text.example", 1.3);
  rememberZoom("compact.example", 0.9);
});

afterEach(async () => {
  while (mounted.length > 0) mounted.pop()?.();
  await flushConfigWrites();
});

describe("the Sites section's four kinds of memory", () => {
  it("lists every kind: permissions, certificates, zoom, user script domains", async () => {
    serve();
    const host = render();
    await settle();
    const sites = host.querySelector("section#sites");
    expect(sites, "the sites section must exist").not.toBeNull();

    // Permissions: one row per remembered answer, with what was answered.
    expect(sites!.textContent).toContain("calls.example");
    expect(sites!.textContent).toContain("camera and microphone");
    expect(sites!.textContent).toContain("Allowed");
    expect(sites!.textContent).toContain("Refused");
    // Certificates: the absorbed list, host per row.
    expect(sites!.textContent).toContain("self-signed.example");
    // Zoom: the remembered level beside the host.
    expect(sites!.textContent).toContain("big-text.example");
    expect(sites!.textContent).toContain("130%");
    // User script domains: hosts as rows, script names on the second line —
    // both scripts that forum.example was granted, by name.
    expect(sites!.textContent).toContain("forum.example");
    expect(sites!.textContent).toContain("Tidy");
    expect(sites!.textContent).toContain("Dark");
    expect(sites!.textContent).toContain("news.example");
  });

  it("revokes a certificate exception through the command it always used", async () => {
    serve();
    const host = render();
    await settle();
    const row = [...host.querySelectorAll("section#sites tr")].find((tr) =>
      tr.textContent!.includes("self-signed.example")
    )!;
    await click(row.querySelector("button")!);
    expect(
      mocks.invoke.mock.calls.filter(
        ([cmd, args]) =>
          cmd === "revoke_trusted_host" &&
          (args as { host?: string }).host === "self-signed.example"
      ).length
    ).toBe(1);
    expect(
      host.querySelector("section#sites")!.textContent
    ).not.toContain("self-signed.example");
  });

  it("revokes a media answer through the new media_revoke command", async () => {
    serve();
    const host = render();
    await settle();
    const row = [...host.querySelectorAll("section#sites tr")].find((tr) =>
      tr.textContent!.includes("meet.example")
    )!;
    await click(row.querySelector("button")!);
    expect(
      mocks.invoke.mock.calls.filter(
        ([cmd, args]) =>
          cmd === "media_revoke" &&
          (args as { host?: string; kind?: string }).host === "meet.example" &&
          (args as { kind?: string }).kind === "camera and microphone"
      ).length
    ).toBe(1);
  });

  it("forgets a zoom level through the module, not a command", async () => {
    serve();
    const host = render();
    await settle();
    const before = mocks.invoke.mock.calls.length;
    const row = [...host.querySelectorAll("section#sites tr")].find((tr) =>
      tr.textContent!.includes("compact.example")
    )!;
    await click(row.querySelector("button")!);
    expect(
      mocks.invoke.mock.calls
        .slice(before)
        .filter(([cmd]) => String(cmd).includes("revoke"))
    ).toEqual([]);
    expect(zoomFor("compact.example")).toBeUndefined();
    expect(zoomFor("big-text.example")).toBe(1.3);
    expect(
      host.querySelector("section#sites")!.textContent
    ).not.toContain("compact.example");
  });

  it("revokes one script's grant on a host, leaving the host's others", async () => {
    serve();
    const host = render();
    await settle();
    const row = [...host.querySelectorAll("section#sites tr")].find((tr) =>
      tr.textContent!.includes("forum.example")
    )!;
    const tidyX = [...row.querySelectorAll("button")].find((b) =>
      (b.getAttribute("aria-label") ?? "").includes("Tidy")
    )!;
    await click(tidyX);
    expect(
      mocks.invoke.mock.calls.filter(
        ([cmd, args]) =>
          cmd === "userscript_revoke_grant" &&
          (args as { scriptId?: string; host?: string }).scriptId === "s1" &&
          (args as { host?: string }).host === "forum.example"
      ).length
    ).toBe(1);
  });

  it("clears every kind through each kind's own channel, after asking", async () => {
    serve();
    const host = render();
    await settle();
    const sites = host.querySelector("section#sites")!;
    const clear = [...sites.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Clear all site memory")
    )!;
    expect(clear, "the clear button lives in the sites section").toBeTruthy();
    await click(clear);
    // It asked first — with the clear's own question.
    expect(mocks.confirmAsk).toHaveBeenCalledTimes(1);
    // Every kind went through its own channel: both certificate hosts are
    // one each, media three, script grants three pairs (Tidy+Dark on forum,
    // Dark on news), and the zoom module came up empty.
    for (const want of [
      ["revoke_trusted_host", "self-signed.example"],
      ["media_revoke", "calls.example"],
      ["userscript_revoke_grant", "s1"],
      ["userscript_revoke_grant", "s2"],
    ] as const) {
      expect(
        mocks.invoke.mock.calls.some(
          ([cmd]) => cmd === want[0]
        ),
        `${want[0]} must have been invoked`
      ).toBe(true);
    }
    expect(
      mocks.invoke.mock.calls.filter(([cmd]) => cmd === "revoke_trusted_host")
        .length
    ).toBe(1);
    expect(
      mocks.invoke.mock.calls.filter(([cmd]) => cmd === "media_revoke").length
    ).toBe(3);
    expect(
      mocks.invoke.mock.calls.filter(
        ([cmd]) => cmd === "userscript_revoke_grant"
      ).length
    ).toBe(3);
    expect(zoomFor("big-text.example")).toBeUndefined();
  });

  it("does nothing when the clear's confirmation is declined", async () => {
    serve();
    mocks.confirmAsk.mockResolvedValue(false);
    const host = render();
    await settle();
    const sites = host.querySelector("section#sites")!;
    const clear = [...sites.querySelectorAll("button")].find((b) =>
      (b.textContent ?? "").includes("Clear all site memory")
    )!;
    await click(clear);
    expect(
      mocks.invoke.mock.calls.filter(([cmd]) =>
        String(cmd).includes("revoke")
      )
    ).toEqual([]);
    expect(zoomFor("big-text.example")).toBe(1.3);
  });

  it("keeps the clear out of the danger zone", async () => {
    serve();
    const host = render();
    await settle();
    const danger = host.querySelector("section#danger")!;
    expect(danger.textContent).not.toContain("site memory");
    const dangerButtons = [...danger.querySelectorAll("button")].map(
      (b) => b.getAttribute("data-danger") ?? b.textContent
    );
    expect(dangerButtons.every((id) => id !== null)).toBe(true);
  });
});
