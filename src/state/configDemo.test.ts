import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BOOT_CONFIG_KEY,
  CONFIG_KEYS,
  DEMO_SCHEMA_KEY,
  NO_CONFIG_BACKEND,
  type ConfigValues,
  type Setting,
  configGet,
  configReset,
  configSchema,
  configSet,
  configSlice,
  numberRange,
} from "./config";


/** Resolved against the working directory, which the runner sets to the
 *  repository root (config.test.ts relies on the same, for the same reason:
 *  `import.meta.url` is not a file URL in this environment). */
const REPO = process.cwd();
const GATE = resolve(REPO, "tools", "config-registry-extractor.py");
const REGISTRY = resolve(REPO, "src-tauri", "src", "config.rs");

interface Payload {
  registry: string;
  values: ConfigValues;
  schema: Setting[];
}

/**
 * The registry, through the same extractor tools/vite-demo-config.mjs runs
 * at dev-server start. Calling it rather than re-reading config.rs here is
 * the point: a second reader would be a second truth, and the export is
 * exactly what the demo is handed.
 */
function derive(registry: string = REGISTRY): Payload {
  const out = execFileSync(
    "python3",
    [GATE, "--emit-json", "-", "--registry", registry],
    { cwd: REPO, encoding: "utf8" }
  );
  return JSON.parse(out) as Payload;
}

const w = () => window as unknown as Record<string, unknown>;

/** Put a derived registry where the dev server's plugin would have put it. */
function install(payload: Payload | null): void {
  if (payload === null) {
    delete w()[BOOT_CONFIG_KEY];
    delete w()[DEMO_SCHEMA_KEY];
    return;
  }
  w()[BOOT_CONFIG_KEY] = payload.values;
  w()[DEMO_SCHEMA_KEY] = payload.schema;
}

/** The value a dotted key names, wherever it sits in the file's shape. */
function at(values: ConfigValues, key: string): unknown {
  const [section, field] = key.split(".");
  const table = (values as unknown as Record<string, Record<string, unknown>>)[
    section as string
  ];
  return table?.[field as string];
}

beforeEach(() => {
  // The demo path is chosen by the absence of the desktop core, exactly as
  // persist.ts chooses its localStorage carrier.
  delete w().__TAURI_INTERNALS__;
  localStorage.clear();
  install(derive());
});

afterEach(() => {
  install(null);
  localStorage.clear();
});

describe("the demo is given the registry, not a copy of it", () => {
  it("answers config_schema with every setting the registry declares", async () => {
    const rows = await configSchema();
    expect(rows.length).toBeGreaterThan(0);
    // Every key the interface knows how to write must be a row it can read,
    // or a control would render against a row that is not there.
    for (const key of Object.values(CONFIG_KEYS)) {
      expect(rows.map((r) => r.key)).toContain(key);
    }
  });

  it("answers config_get with a value for all six, none of them null", async () => {
    const snap = await configGet();
    const slice = configSlice(snap.values);
    for (const [field, value] of Object.entries(slice)) {
      expect(value, field).not.toBeNull();
    }
  });

  it("says the same thing through both commands", async () => {
    // config_get's values and config_schema's defaults are two shapes of one
    // fact, and the changed-only view judges one against the other: if they
    // could disagree it would report every setting as modified.
    const [snap, rows] = await Promise.all([configGet(), configSchema()]);
    for (const row of rows) {
      expect(at(snap.values, row.key), row.key).toEqual(row.default);
    }
  });

  it("carries the numeric bounds the sidebar drag clamps to", async () => {
    const range = numberRange(await configSchema(), CONFIG_KEYS.sidebarWidth);
    expect(range).not.toBeNull();
    expect(range?.min).toBeLessThan(range?.max as number);
  });

  it("reports no file and no warnings before anything has been edited", async () => {
    // Not an empty-path lie and not a fabricated one: nothing has
    // contributed a value yet, so nothing is listed.
    const snap = await configGet();
    expect(snap.sources).toEqual([]);
    expect(snap.warnings).toEqual([]);
  });

  it("names a source once its carrier exists, so the migration is once", async () => {
    // The store treats "no source at all" as "this user has no configuration
    // file yet" and moves their old session-held settings in — once, marked
    // done by the file it just created. Reporting no source forever would
    // re-run that on every read, and the damage is specific and visible: the
    // theme's reset appears to do nothing, because the migration writes the
    // old stored preference straight back over it. The carrier is this
    // demo's equivalent of that file, so it is named once it is there.
    expect((await configGet()).sources).toEqual([]);
    await configSet(CONFIG_KEYS.sidebarPinned, false);
    expect((await configGet()).sources.length).toBe(1);
  });
});

describe("a page nobody injected a registry into", () => {
  it("still refuses all four calls rather than inventing values", async () => {
    install(null);
    await expect(configGet()).rejects.toBe(NO_CONFIG_BACKEND);
    await expect(configSchema()).rejects.toBe(NO_CONFIG_BACKEND);
    await expect(configSet(CONFIG_KEYS.theme, "dark")).rejects.toBe(
      NO_CONFIG_BACKEND
    );
    await expect(configReset(CONFIG_KEYS.theme)).rejects.toBe(
      NO_CONFIG_BACKEND
    );
  });

  it("refuses when only the values arrived and no registry did", async () => {
    const payload = derive();
    install(payload);
    delete w()[DEMO_SCHEMA_KEY];
    await expect(configSchema()).rejects.toBe(NO_CONFIG_BACKEND);
    await expect(configGet()).rejects.toBe(NO_CONFIG_BACKEND);
  });
});

describe("what the demo's user changes", () => {
  /** A token from a choice's own domain that is not what it is now. */
  async function otherToken(key: string): Promise<string> {
    const row = (await configSchema()).find((r) => r.key === key);
    const kind = row?.kind as { choice?: { options: string[] } };
    const options = kind.choice?.options ?? [];
    const other = options.find((o) => o !== row?.default);
    expect(other, `${key} has a second option`).toBeDefined();
    return other as string;
  }

  it("comes back on the next read", async () => {
    const next = await otherToken(CONFIG_KEYS.theme);
    await configSet(CONFIG_KEYS.theme, next);
    expect(at((await configGet()).values, CONFIG_KEYS.theme)).toBe(next);
  });

  it("leaves every other setting at what the registry says", async () => {
    const before = (await configGet()).values;
    await configSet(CONFIG_KEYS.theme, await otherToken(CONFIG_KEYS.theme));
    const after = (await configGet()).values;
    for (const key of Object.values(CONFIG_KEYS)) {
      if (key === CONFIG_KEYS.theme) continue;
      expect(at(after, key), key).toEqual(at(before, key));
    }
  });

  it("is deleted by a reset, not overwritten with today's default", async () => {
    const key = CONFIG_KEYS.archiveAfter;
    const registryValue = at((await configGet()).values, key);
    await configSet(key, await otherToken(key));
    await configReset(key);
    expect(at((await configGet()).values, key)).toEqual(registryValue);
    const stored = JSON.parse(
      localStorage.getItem("tabverse.demo.config") ?? "{}"
    ) as Record<string, unknown>;
    expect(Object.keys(stored)).not.toContain(key);
  });

  it("ignores a stored key the registry no longer knows", async () => {
    const before = (await configGet()).values;
    localStorage.setItem(
      "tabverse.demo.config",
      JSON.stringify({ "appearance.sidebar_wdith": 1, "gone.setting": true })
    );
    expect((await configGet()).values).toEqual(before);
  });

  it("is refused when the registry does not know the key", async () => {
    // What the core does (config_set rejects an unknown key rather than
    // inventing a line for it). A demo that accepted it would be showing a
    // tolerance the product does not have.
    await expect(configSet("browser.homepage", "x")).rejects.toBeTruthy();
    await expect(configReset("browser.homepage")).rejects.toBeTruthy();
    expect(localStorage.getItem("tabverse.demo.config")).toBeNull();
  });

  it("is refused when the value is outside the setting's own domain", async () => {
    const rows = await configSchema();
    const choice = rows.find((r) => typeof r.kind === "object" && "choice" in r.kind);
    const options = (choice?.kind as { choice: { options: string[] } }).choice
      .options;
    // A token no domain in the registry contains, built from the domain so
    // it cannot accidentally become a real one.
    await expect(
      configSet(choice?.key as string, `${options.join("-")}-no`)
    ).rejects.toBeTruthy();

    const width = numberRange(rows, CONFIG_KEYS.sidebarWidth);
    await expect(
      configSet(CONFIG_KEYS.sidebarWidth, (width?.max as number) + 1)
    ).rejects.toBeTruthy();
    await expect(
      configSet(CONFIG_KEYS.sidebarWidth, (width?.min as number) - 1)
    ).rejects.toBeTruthy();

    // Refused before anything is stored, exactly as the core refuses before
    // it opens the file.
    expect(localStorage.getItem("tabverse.demo.config")).toBeNull();
  });

  it("survives storage holding something that is not a configuration", async () => {
    for (const junk of ["", "{", "null", "42", "[1,2]"]) {
      localStorage.setItem("tabverse.demo.config", junk);
      await expect(configGet(), junk).resolves.toBeDefined();
    }
  });
});

describe("the demo's values move when the registry's do", () => {
  it("follows a default edited in config.rs", async () => {
    // THE DISCRIMINATING TEST. Everything above passes against a frontend
    // that keeps its own copy of the defaults, as long as the copy is
    // currently right. This one edits the registry and requires the demo to
    // have changed with it, which no copy can do.
    //
    // The new width is read out of the registry's own declared bounds rather
    // than written down here — a number typed into this file would be one
    // more literal to go stale, and would fail the day the range moved.
    const before = derive();
    const range = numberRange(before.schema, CONFIG_KEYS.sidebarWidth);
    expect(range).not.toBeNull();
    const current = at(before.values, CONFIG_KEYS.sidebarWidth) as number;
    const mutated =
      current === (range?.min as number) + 1
        ? (range?.min as number) + 2
        : (range?.min as number) + 1;
    expect(mutated).not.toBe(current);

    const src = readFileSync(REGISTRY, "utf8");
    const block = /impl Default for Config\s*\{[\s\S]*?\n\}/.exec(src);
    expect(block, "the default block is findable").not.toBeNull();
    const field = CONFIG_KEYS.sidebarWidth.split(".")[1] as string;
    const edited = (block as RegExpExecArray)[0].replace(
      new RegExp(`(${field}:\\s*)\\d+`),
      `$1${mutated}`
    );
    expect(edited, "the edit changed something").not.toBe(
      (block as RegExpExecArray)[0]
    );

    const dir = mkdtempSync(join(tmpdir(), "tabverse-registry-"));
    const copy = join(dir, "config.rs");
    writeFileSync(
      copy,
      src.slice(0, (block as RegExpExecArray).index) +
        edited +
        src.slice(
          (block as RegExpExecArray).index + (block as RegExpExecArray)[0].length
        )
    );

    install(derive(copy));
    expect(at((await configGet()).values, CONFIG_KEYS.sidebarWidth)).toBe(
      mutated
    );
    expect(
      (await configSchema()).find((r) => r.key === CONFIG_KEYS.sidebarWidth)
        ?.default
    ).toBe(mutated);

    // And back: the unedited registry still says what it said, so the change
    // above came from the file and not from the test having broken something.
    install(derive());
    expect(at((await configGet()).values, CONFIG_KEYS.sidebarWidth)).toBe(
      current
    );
  });
});
