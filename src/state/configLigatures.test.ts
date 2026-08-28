import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BOOT_CONFIG_KEY,
  DEMO_SCHEMA_KEY,
  TERMINAL_KEYS,
  configGet,
  configSchema,
  configSet,
  type ConfigValues,
  type Setting,
} from "./config";
import { resetTerminalFontForTest, terminalLigatures } from "../term/font";


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

function install(payload: Payload | null): void {
  if (payload === null) {
    delete w()[BOOT_CONFIG_KEY];
    delete w()[DEMO_SCHEMA_KEY];
    return;
  }
  w()[BOOT_CONFIG_KEY] = payload.values;
  w()[DEMO_SCHEMA_KEY] = payload.schema;
}

/** The profile the mixed case declares — a build log watcher that keeps its
 * GPU renderer while the setting is on. */
const BUILD_PROFILE = "Build";

beforeEach(() => {
  delete w().__TAURI_INTERNALS__;
  localStorage.clear();
  resetTerminalFontForTest();
});

afterEach(() => {
  install(null);
  localStorage.clear();
  resetTerminalFontForTest();
});

describe("what the file says about ligatures reaches the terminals", () => {
  it("is a registry row, so the settings page and the file agree on its name", async () => {
    install(derive());
    const schema = await configSchema();
    const row = schema.find((r) => r.key === TERMINAL_KEYS.ligatures);
    // The key is the handle two strands of this milestone hold: the settings
    // page draws its control from this row, and the terminal view reads the
    // same key. A row that was not here would leave the switch undrawable.
    expect(row, `${TERMINAL_KEYS.ligatures} is not registered`).toBeDefined();
    expect(row?.kind, "a switch, not a number or a list").toBe("toggle");
  });

  it("arrives at the module the terminals subscribe to when it is written", async () => {
    install(derive());
    // Nothing read yet is null, not off: the module holds no default.
    expect(terminalLigatures(), "before any read").toBeNull();

    await configSet(TERMINAL_KEYS.ligatures, true);
    await configGet();
    expect(terminalLigatures(), "after the user turned it on").toBe(true);

    await configSet(TERMINAL_KEYS.ligatures, false);
    await configGet();
    expect(terminalLigatures(), "and after they turned it back off").toBe(
      false
    );
  });

  it("lets a profile keep the GPU renderer while the setting is on", async () => {
    const payload = derive();
    payload.values.terminal = {
      ...payload.values.terminal,
      profiles: [{ name: BUILD_PROFILE, ligatures: false }],
    };
    install(payload);

    await configSet(TERMINAL_KEYS.ligatures, true);
    await configGet();

    expect(terminalLigatures(), "terminals in general").toBe(true);
    expect(terminalLigatures(BUILD_PROFILE), "the build profile").toBe(false);
    // A profile that says nothing follows the setting rather than the
    // absence of an entry meaning "off".
    expect(terminalLigatures("Some other profile")).toBe(true);
  });
});
