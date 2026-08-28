import { createElement, Fragment } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";


const mocks = vi.hoisted(() => ({
  invoke: vi.fn<(cmd: string, args?: Record<string, unknown>) => unknown>(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));

const { ProfilesSection, parseEnv } = await import("./ProfilesSection");
const { ConfirmHost } = await import("./Confirm");
const { SETTINGS_SECTIONS, PROFILES_SECTION_ID } = await import(
  "./settingsSections"
);
const { BOOT_CONFIG_KEY, DEMO_SCHEMA_KEY } = await import("../state/config");
type ConfigProfile = import("../state/config").ConfigProfile;
type ConfigValues = import("../state/config").ConfigValues;
const { STR } = await import("../strings");

const P = STR.settings.profiles;
const w = () => window as unknown as Record<string, unknown>;

const DEPLOY: ConfigProfile = {
  name: "deploy",
  shell: "/bin/bash",
  cwd: "/srv",
  env: { AWS_PROFILE: "prod" },
};
const LOCAL: ConfigProfile = { name: "local" };

function configWith(profiles: ConfigProfile[]): ConfigValues {
  return {
    appearance: { theme: "light", sidebar_width: 301, sidebar_pinned: false },
    browser: {
      search_engine: "duckduckgo",
      custom_search_template: "",
      archive_after: "24h",
    },
    terminal: { profiles },
  };
}

/** Every call of `cmd`, with its arguments, in call order. */
function calls(cmd: string): Array<Record<string, unknown> | undefined> {
  return mocks.invoke.mock.calls
    .filter(([name]) => name === cmd)
    .map(([, args]) => args);
}

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Mount the section (with the confirmation host beside it, since removing
 * asks) and let the profile read land. */
async function mount(profiles: ConfigProfile[]): Promise<HTMLElement> {
  w()[BOOT_CONFIG_KEY] = configWith(profiles);
  mocks.invoke.mockImplementation(async (cmd: string) => {
    if (cmd === "config_get") {
      return { values: configWith(profiles), warnings: [], sources: ["x"] };
    }
    return undefined;
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  const el = host;
  await act(async () => {
    root = createRoot(el);
    root.render(
      createElement(Fragment, null, [
        createElement(ProfilesSection, { key: "s" }),
        createElement(ConfirmHost, { key: "c" }),
      ])
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return el;
}

/** Click the first element matching `selector` whose text is `text`. */
async function clickByText(
  el: HTMLElement,
  selector: string,
  text: string
): Promise<void> {
  const target = Array.from(el.querySelectorAll(selector)).find(
    (n) => (n.textContent ?? "").trim() === text
  );
  expect(target, `no ${selector} reading “${text}”`).toBeTruthy();
  await act(async () => {
    target!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

/** Type into a box, through its own handler. */
async function type(
  el: HTMLElement,
  id: string,
  value: string
): Promise<void> {
  const box = el.querySelector(`#${id}`) as HTMLInputElement | null;
  expect(box, `no box called ${id}`).not.toBeNull();
  const proto =
    box!.tagName === "TEXTAREA"
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    setter?.call(box, value);
    box!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Choose an option through the select's own change handler. */
async function choose(
  el: HTMLElement,
  id: string,
  value: string
): Promise<void> {
  const select = el.querySelector(`#${id}`) as HTMLSelectElement | null;
  expect(select, `no select called ${id}`).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(
    HTMLSelectElement.prototype,
    "value"
  )?.set;
  await act(async () => {
    setter?.call(select, value);
    select!.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
    true;
  localStorage.clear();
  mocks.invoke.mockReset();
  w().__TAURI_INTERNALS__ = {};
  // One row, so the demo carrier considers itself configured — the profile
  // list is not a registry row, but the demo refuses to answer at all
  // without a schema to be a demo OF.
  w()[DEMO_SCHEMA_KEY] = [
    {
      key: "appearance.sidebar_width",
      kind: { number: { min: 180, max: 520 } },
      section: "appearance",
      str_key: "settings.appearance.sidebarWidth",
      default: 301,
    },
  ];
});

afterEach(() => {
  if (root && host) {
    const done = root;
    act(() => done.unmount());
    host.remove();
  }
  root = null;
  host = null;
  delete w().__TAURI_INTERNALS__;
  delete w()[BOOT_CONFIG_KEY];
  delete w()[DEMO_SCHEMA_KEY];
  localStorage.clear();
});

describe("the section on the page", () => {
  it("is a section with the anchor the rest of the app jumps to", () => {
    const html = renderToStaticMarkup(createElement(ProfilesSection));
    const doc = new DOMParser().parseFromString(html, "text/html");
    const section = doc.querySelector(`section#${PROFILES_SECTION_ID}`);
    expect(section, "the section has no anchor").not.toBeNull();
    expect(section!.querySelector("h3")?.textContent).toBe(P.heading);
  });

  it("is in the section list, so the rail and the jump target reach it", () => {
    expect(
      SETTINGS_SECTIONS.some((s) => s.id === PROFILES_SECTION_ID)
    ).toBe(true);
  });

  it("lists what each profile says, and says so when it says nothing", async () => {
    const el = await mount([DEPLOY, LOCAL]);
    const text = el.textContent ?? "";
    expect(text).toContain("deploy");
    expect(text).toContain("/bin/bash");
    // A profile that is nothing but a name gets a sentence rather than an
    // empty line that reads as a rendering fault.
    expect(text).toContain(P.summaryPlain);
  });

  it("shows a profile's ligature override in the list", async () => {
    const el = await mount([
      { ...DEPLOY, ligatures: true },
      { ...LOCAL, ligatures: false },
    ]);
    const text = el.textContent ?? "";
    expect(text).toContain(P.summaryLigaturesOn);
    expect(text).toContain(P.summaryLigaturesOff);
  });

  it("says there are none rather than showing an empty table", async () => {
    const el = await mount([]);
    expect(el.textContent ?? "").toContain(P.none);
  });
});

describe("editing a profile", () => {
  it("writes it through the point edit, naming the entry it replaces", async () => {
    const el = await mount([DEPLOY, LOCAL]);
    await clickByText(el, "button", P.edit); // the first row's Edit
    await type(el, "profile-shell", "/bin/zsh");
    await clickByText(el, "button", P.save);

    const written = calls("config_profile_set");
    expect(written.length, "the save did not reach the file").toBe(1);
    // The target is the entry being written over — which is what keeps the
    // comments and the layout around it intact. Nothing here composes TOML.
    expect(written[0]?.target).toBe("deploy");
    const profile = written[0]?.profile as ConfigProfile;
    expect(profile.name).toBe("deploy");
    expect(profile.shell).toBe("/bin/zsh");
    // Untouched boxes are written back as they were.
    expect(profile.cwd).toBe("/srv");
    expect(profile.env).toEqual({ AWS_PROFILE: "prod" });
  });

  it("renames without moving the entry: the target is the old name", async () => {
    const el = await mount([DEPLOY, LOCAL]);
    await clickByText(el, "button", P.edit);
    await type(el, "profile-name", "release");
    await clickByText(el, "button", P.save);

    const [written] = calls("config_profile_set");
    expect(written?.target).toBe("deploy");
    expect((written?.profile as ConfigProfile).name).toBe("release");
  });

  it("keeps a field a future editor version may add", async () => {
    // A profile entity grows fields, and an older editor that rebuilds the
    // entry from only its own boxes would erase each new one on the first
    // unrelated edit. This unknown field stands for that future addition.
    const withExtra = {
      ...DEPLOY,
      font: "Fira Code",
      future_option: "keep-me",
    } as ConfigProfile & { future_option: string };
    const el = await mount([withExtra]);
    await clickByText(el, "button", P.edit);
    await type(el, "profile-cwd", "/srv/app");
    await clickByText(el, "button", P.save);

    const profile = calls("config_profile_set")[0]?.profile as ConfigProfile & {
      future_option?: string;
    };
    expect(profile.cwd).toBe("/srv/app");
    expect(profile.font, "the per-profile font was dropped").toBe("Fira Code");
    expect(
      profile.future_option,
      "a field this editor does not know was dropped"
    ).toBe("keep-me");
  });

  it.each([
    ["", undefined],
    ["on", true],
    ["off", false],
  ] as const)(
    "writes the ligature choice %s as the profile's three-state answer",
    async (choice, expected) => {
      const el = await mount([DEPLOY]);
      await clickByText(el, "button", P.edit);
      await choose(el, "profile-ligatures", choice);
      await clickByText(el, "button", P.save);

      const profile = calls("config_profile_set")[0]?.profile as ConfigProfile;
      expect(profile.ligatures).toBe(expected);
    }
  );

  it("adds a profile the file does not have yet", async () => {
    const el = await mount([DEPLOY]);
    await clickByText(el, "button", P.add);
    await type(el, "profile-name", "docs");
    await type(el, "profile-cwd", "/notes");
    await clickByText(el, "button", P.save);

    const [written] = calls("config_profile_set");
    // Target and name are the same for a new entry, which is what makes the
    // core append it rather than write over something.
    expect(written?.target).toBe("docs");
    expect((written?.profile as ConfigProfile).name).toBe("docs");
  });

  it("leaves an empty box out of the entry instead of writing an empty value", async () => {
    const el = await mount([DEPLOY]);
    await clickByText(el, "button", P.edit);
    await type(el, "profile-shell", "");
    await clickByText(el, "button", P.save);

    const profile = calls("config_profile_set")[0]?.profile as ConfigProfile;
    // Absent means "do what a plain terminal does"; an empty string would be
    // a shell called nothing.
    expect(profile.shell).toBeUndefined();
  });
});

describe("a name the file could not take", () => {
  it("refuses a blank name on the spot, without writing", async () => {
    const el = await mount([DEPLOY]);
    await clickByText(el, "button", P.edit);
    await type(el, "profile-name", "   ");
    await clickByText(el, "button", P.save);

    expect(
      calls("config_profile_set"),
      "a blank name reached the file"
    ).toEqual([]);
    const refusal = el.querySelector("[data-profile-refusal]");
    expect(refusal, "nothing was said about the refusal").not.toBeNull();
    expect((refusal!.textContent ?? "").length).toBeGreaterThan(0);
  });

  it("refuses a name another profile already has, without writing", async () => {
    const el = await mount([DEPLOY, LOCAL]);
    // Edit the second entry and rename it onto the first — the one route to
    // two entries with one name.
    const edits = Array.from(el.querySelectorAll("button")).filter(
      (b) => (b.textContent ?? "").trim() === P.edit
    );
    await act(async () => {
      edits[1].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await type(el, "profile-name", "deploy");
    await clickByText(el, "button", P.save);

    expect(calls("config_profile_set")).toEqual([]);
    const refusal = el.querySelector("[data-profile-refusal]");
    expect(refusal).not.toBeNull();
    // The file format's own sentence, which names the profile at fault.
    expect(refusal!.textContent).toContain("deploy");
  });

  it("refuses an environment line that is not a pair, naming the line", async () => {
    const el = await mount([DEPLOY]);
    await clickByText(el, "button", P.edit);
    await type(el, "profile-env", "ok=1\nnot a pair\n");
    await clickByText(el, "button", P.save);

    expect(calls("config_profile_set")).toEqual([]);
    const refusal = el.querySelector("[data-profile-refusal]");
    expect(refusal?.textContent).toBe(P.envRefusal({ line: 2 }));
  });
});

describe("removing a profile", () => {
  it("asks first, and removes by name once the answer is yes", async () => {
    const el = await mount([DEPLOY, LOCAL]);
    await clickByText(el, "button", P.remove); // the first row's Remove

    // Nothing has happened yet: the question is on screen.
    expect(calls("config_profile_remove")).toEqual([]);
    expect(el.textContent).toContain(P.removeQuestion({ name: "deploy" }));

    // The dialog's own confirm button carries the action's word.
    const buttons = Array.from(el.querySelectorAll(".confirm-actions button"));
    const yes = buttons.find((b) => (b.textContent ?? "").trim() === P.remove);
    expect(yes, "the question has no way to say yes").toBeTruthy();
    await act(async () => {
      yes!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(calls("config_profile_remove")).toEqual([{ name: "deploy" }]);
  });

  it("does nothing when the answer is no", async () => {
    const el = await mount([DEPLOY]);
    await clickByText(el, "button", P.remove);
    await clickByText(el, ".confirm-actions button", STR.common.cancel);
    expect(calls("config_profile_remove")).toEqual([]);
  });
});

describe("the browser demo", () => {
  it("saves without a core, so the page can be walked through there", async () => {
    delete w().__TAURI_INTERNALS__;
    const el = await mount([]);
    expect(el.textContent).toContain(P.demoNote);

    await clickByText(el, "button", P.add);
    await type(el, "profile-name", "demo-one");
    await type(el, "profile-cwd", "/tmp");
    await clickByText(el, "button", P.save);

    expect(calls("config_profile_set"), "the demo called the core").toEqual([]);
    const { configGet, profiles } = await import("../state/config");
    const snap = await configGet();
    expect(profiles(snap.values).map((p) => p.name)).toEqual(["demo-one"]);
    expect(profiles(snap.values)[0].cwd).toBe("/tmp");
  });
});

describe("the environment box", () => {
  it("reads pairs, skips blank lines and keeps everything after the first =", () => {
    expect(parseEnv("A=1\n\n B = 2 \nC=x=y")).toEqual({
      env: { A: "1", B: "2", C: "x=y" },
    });
  });

  it("names the line that is not a pair", () => {
    expect(parseEnv("A=1\nnope")).toEqual({ badLine: 2 });
    // A line that is all `=` has no name in front of it.
    expect(parseEnv("=1")).toEqual({ badLine: 1 });
  });
});
