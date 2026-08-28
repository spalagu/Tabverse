import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  SEARCH_ENGINES,
  directUrl,
  homeUrlWith,
  searchUrlWith,
  toUrl,
  validSearchTemplate,
} from "./search";
import {
  CONFIG_KEYS,
  DEMO_SCHEMA_KEY,
  configSchema,
  textRule,
  type Setting,
  type TextRule,
} from "./state/config";
import { useStore } from "./state/store";


const REPO = process.cwd();
const GATE = resolve(REPO, "tools", "config-registry-extractor.py");
const REGISTRY = resolve(REPO, "src-tauri", "src", "config.rs");

/** The registry, through the extractor tools/vite-demo-config.mjs runs. */
function derive(registry: string = REGISTRY): { schema: Setting[] } {
  const out = execFileSync(
    "python3",
    [GATE, "--emit-json", "-", "--registry", registry],
    { cwd: REPO, encoding: "utf8" }
  );
  return JSON.parse(out) as { schema: Setting[] };
}

const w = () => window as unknown as Record<string, unknown>;

/** The rule the registry declares for the custom template. */
function registryRule(registry: string = REGISTRY): TextRule {
  const rule = textRule(derive(registry).schema, CONFIG_KEYS.customSearchTemplate);
  expect(rule, "the registry declares a rule for the custom template").not.toBeNull();
  return rule as TextRule;
}

/**
 * Put the registry where the demo's dev-server plugin puts it and read it
 * back through `configSchema`, which is what `searchUrl()` and `homeUrl()`
 * reach the rule by. Without this the store-reading half of these tests
 * would be judging with no rule at all.
 */
async function serveRegistry(registry: string = REGISTRY): Promise<void> {
  delete w().__TAURI_INTERNALS__;
  w()[DEMO_SCHEMA_KEY] = derive(registry).schema;
  await configSchema();
}

beforeEach(async () => {
  useStore.setState({ searchEngine: "duckduckgo", customSearchTemplate: "" });
  await serveRegistry();
});

afterEach(() => {
  delete w()[DEMO_SCHEMA_KEY];
});

describe("directUrl — what counts as an address", () => {
  it("accepts hosts, hosts with paths and ports, schemes, and localhost", () => {
    expect(directUrl("github.com")).toBe("https://github.com");
    expect(directUrl("github.com/foo/bar")).toBe("https://github.com/foo/bar");
    expect(directUrl("example.com:8080/x")).toBe("https://example.com:8080/x");
    expect(directUrl("https://x.test/a?b=1")).toBe("https://x.test/a?b=1");
    expect(directUrl("vscode://open?x=1")).toBe("vscode://open?x=1");
    expect(directUrl("localhost:3000/app")).toBe("http://localhost:3000/app");
  });

  it("refuses queries: they are searches, not places", () => {
    expect(directUrl("how to cook rice")).toBeNull();
    expect(directUrl("githubcom")).toBeNull();
    expect(directUrl("")).toBeNull();
    expect(directUrl("   ")).toBeNull();
  });
});

describe("toUrl — address in, address out; query in, search out", () => {
  it("passes addresses through and sends empty input home", () => {
    expect(toUrl("github.com")).toBe("https://github.com");
    expect(toUrl("")).toBe("https://duckduckgo.com/");
  });

 it("sends empty input to the chosen engine's home, not a fixed one", () => {
    useStore.setState({ searchEngine: "google" });
    expect(toUrl("")).toBe("https://www.google.com/");
    useStore.setState({
      searchEngine: "custom",
      customSearchTemplate: "https://searx.example/search?q=%s",
    });
    expect(toUrl("")).toBe("https://searx.example/");
  });

  it("homeUrlWith falls back exactly like the search fallback does", () => {
    const rule = registryRule();
    expect(homeUrlWith("bing", undefined, rule)).toBe("https://www.bing.com/");
    // A broken custom template must not produce a broken home.
    expect(homeUrlWith("custom", "not a template", rule)).toBe(
      "https://duckduckgo.com/"
    );
    // And neither does a template nobody has a rule to judge yet: an
    // unjudged template is not a template that gets used.
    expect(homeUrlWith("custom", "https://s.test/?q=%s", null)).toBe(
      "https://duckduckgo.com/"
    );
  });

  it("searches a query with the engine the user chose", () => {
    expect(toUrl("rust option")).toBe(
      "https://duckduckgo.com/?q=rust%20option"
    );
    useStore.setState({ searchEngine: "google" });
    expect(toUrl("rust option")).toBe(
      "https://www.google.com/search?q=rust%20option"
    );
    useStore.setState({ searchEngine: "bing" });
    expect(toUrl("rust option")).toBe(
      "https://www.bing.com/search?q=rust%20option"
    );
  });

  it("uses a valid custom template, and falls back when it is broken", () => {
    useStore.setState({
      searchEngine: "custom",
      customSearchTemplate: "https://s.test/find?q=%s&lang=en",
    });
    expect(toUrl("a b")).toBe("https://s.test/find?q=a%20b&lang=en");
    // A template that lost its %s (or never validated) must degrade to a
    // working search, never to a dead bar.
    useStore.setState({ customSearchTemplate: "https://s.test/find" });
    expect(toUrl("a b")).toBe(SEARCH_ENGINES.duckduckgo.template.replace("%s", "a%20b"));
  });
});

describe("searchUrlWith — the pure construction", () => {
  it("encodes the query, including separators that would change the URL", () => {
    expect(searchUrlWith("duckduckgo", undefined, "a&b=c#d", null)).toBe(
      "https://duckduckgo.com/?q=a%26b%3Dc%23d"
    );
  });

  it("replaces every %s the template carries", () => {
    expect(
      searchUrlWith("custom", "https://s.test/%s?echo=%s", "hi", registryRule())
    ).toBe("https://s.test/hi?echo=hi");
  });
});

describe("validSearchTemplate — what settings may accept", () => {
  it("accepts http(s) templates that say where the query goes", () => {
    const rule = registryRule();
    expect(validSearchTemplate("https://x.test/s?q=%s", rule)).toBe(true);
    expect(validSearchTemplate("http://x.test/%s", rule)).toBe(true);
    expect(validSearchTemplate("  https://x.test/s?q=%s  ", rule)).toBe(true);
    // RFC 3986 §3.1: a scheme is case-insensitive. This is the case the two
    // copies of this rule disagreed about — the page said yes and the file
    // said no — and it is now one answer because it is one rule.
    expect(validSearchTemplate("HTTPS://x.test/s?q=%s", rule)).toBe(true);
  });

  it("refuses everything else", () => {
    const rule = registryRule();
    expect(validSearchTemplate("https://x.test/s?q=query", rule)).toBe(false); // no %s
    expect(validSearchTemplate("javascript:alert('%s')", rule)).toBe(false); // not http(s)
    expect(validSearchTemplate("ftp://x.test/%s", rule)).toBe(false);
    expect(validSearchTemplate("x.test/s?q=%s", rule)).toBe(false); // no scheme
    expect(validSearchTemplate("https://x .test/%s", rule)).toBe(false); // not a URL
    expect(validSearchTemplate("", rule)).toBe(false);
  });

  it("has nothing to say without a rule, rather than guessing one", () => {
    // A null rule is "the schema has not arrived". Answering true would let
    // a template through unjudged; answering with a remembered rule would be
    // the second home this function no longer has.
    expect(validSearchTemplate("https://x.test/s?q=%s", null)).toBe(false);
  });

  it("carries no rule of its own: change the registry and it follows", () => {
    // THE DISCRIMINATING TEST for "the constraint has one home". Everything
    // above passes just as well against a `validSearchTemplate` that kept
    // its old `includes("%s")` and `^https?://` — as long as that copy still
    // agrees with the registry. This edits `Kind::Text`'s rule in a copy of
    // config.rs, re-derives the schema through the same extractor the demo
    // is fed by, and requires the verdicts to have turned over. A leftover
    // copy goes on refusing ftp:// and goes on demanding %s, and dies here.
    const src = readFileSync(REGISTRY, "utf8");
    const before = registryRule();
    expect(before.schemes, "the rule constrains schemes today").toContain(
      "http"
    );
    expect(before.must_contain, "and demands a placeholder today").toBe("%s");

    const mutated = src
      .replace('must_contain: Some("%s")', 'must_contain: Some("{query}")')
      .replace('schemes: Some(&["http", "https"])', 'schemes: Some(&["ftp"])');
    expect(mutated, "the edit changed something").not.toBe(src);
    const dir = mkdtempSync(join(tmpdir(), "tabverse-textrule-"));
    const copy = join(dir, "config.rs");
    writeFileSync(copy, mutated);

    const after = registryRule(copy);
    expect(after.schemes).toEqual(["ftp"]);
    expect(after.must_contain).toBe("{query}");

    // What the old copy said no to, the new rule says yes to …
    expect(validSearchTemplate("ftp://x.test/?q={query}", after)).toBe(true);
    // … and what it said yes to, the new rule says no to, on both clauses.
    expect(validSearchTemplate("https://x.test/?q={query}", after)).toBe(false);
    expect(validSearchTemplate("ftp://x.test/?q=%s", after)).toBe(false);

    // And the unedited registry still says what it said, so the change above
    // came from the file rather than from this test having broken something.
    expect(validSearchTemplate("https://x.test/?q=%s", registryRule())).toBe(
      true
    );
  });

  it("uses the same placeholder token the built-in engines are written with", () => {
    // The one coupling left between this module and the rule: a custom
    // template carries `must_contain` and searchUrlWith substitutes `%s`, so
    // if those two ever came apart a custom engine would be sent a template
    // nothing had filled in. Asserted rather than assumed.
    const rule = registryRule();
    expect(rule.must_contain).not.toBeNull();
    for (const [id, engine] of Object.entries(SEARCH_ENGINES)) {
      expect(engine.template, id).toContain(rule.must_contain as string);
    }
  });
});
