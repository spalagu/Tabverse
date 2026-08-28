import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BOOT_CONFIG_KEY,
  DEMO_SCHEMA_KEY,
  TERMINAL_KEYS,
  configGet,
  configSchema,
  type ConfigValues,
  type Setting,
} from "./config";
import { SETTINGS_SECTIONS } from "../components/settingsSections";


const REPO = process.cwd();
const GATE = resolve(REPO, "tools", "config-registry-extractor.py");

interface Payload {
  registry: string;
  values: ConfigValues;
  schema: Setting[];
}

/** The registry, through the extractor the dev-server plugin runs. */
function derive(): Payload {
  const out = execFileSync("python3", [GATE, "--emit-json", "-"], {
    cwd: REPO,
    encoding: "utf8",
  });
  return JSON.parse(out) as Payload;
}

const w = () => window as unknown as Record<string, unknown>;

beforeEach(() => {
  delete w().__TAURI_INTERNALS__;
  localStorage.clear();
});

afterEach(() => {
  delete w()[BOOT_CONFIG_KEY];
  delete w()[DEMO_SCHEMA_KEY];
  localStorage.clear();
});

describe("terminal.completions_url as a registry row", () => {
  it("exists, is text, and demands an http(s) address that is never empty", async () => {
    w()[BOOT_CONFIG_KEY] = derive().values;
    w()[DEMO_SCHEMA_KEY] = derive().schema;

    const schema = await configSchema();
    const row = schema.find((r) => r.key === TERMINAL_KEYS.completionsUrl);
    expect(row, `${TERMINAL_KEYS.completionsUrl} is registered`).toBeDefined();

    // The rule the settings box, the file and the demo all judge by: an
    // address, and not an optional one — the Update button beside this
    // row has nothing to press without one.
    expect(row?.kind).toEqual({
      text: {
        allow_empty: false,
        must_contain: null,
        schemes: ["http", "https"],
      },
    });
  });

  it("points at a section the settings page renders", () => {
    const payload = derive();
    const row = payload.schema.find(
      (r) => r.key === TERMINAL_KEYS.completionsUrl
    );
    expect(row).toBeDefined();
    expect(
      SETTINGS_SECTIONS.some((s) => s.id === row!.section),
      `${row!.section} must be in the section list, or the row is unjumpable`
    ).toBe(true);
  });

  it("carries a default the file actually produces", async () => {
    const payload = derive();
    w()[BOOT_CONFIG_KEY] = payload.values;
    w()[DEMO_SCHEMA_KEY] = payload.schema;

    // The registry's declared default and an absent file's answer must be
    // one fact, not two that agree today: read both out of the same
    // derived payload and the config it hands the page.
    const schema = await configSchema();
    const row = schema.find((r) => r.key === TERMINAL_KEYS.completionsUrl)!;
    const snap = await configGet();
    expect(snap.values.terminal?.completions_url).toBe(row.default as string);
    // Shape only, never the literal: this side owns no copy of the URL.
    expect(String(row.default).startsWith("https://")).toBe(true);
  });
});
