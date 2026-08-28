import {
  CONFIG_KEYS,
  knownTextRule,
  textRefusal,
  type TextRule,
} from "./state/config";
import { useStore, type SearchEngineId } from "./state/store";


/** The built-in engines. "custom" is the user's own template. */
export const SEARCH_ENGINES: Record<
  Exclude<SearchEngineId, "custom">,
  { label: string; template: string }
> = {
  duckduckgo: { label: "DuckDuckGo", template: "https://duckduckgo.com/?q=%s" },
  google: { label: "Google", template: "https://www.google.com/search?q=%s" },
  bing: { label: "Bing", template: "https://www.bing.com/search?q=%s" },
};

/**
 * Where a search goes when the chosen engine cannot answer: a custom
 * template that does not validate, or a setting the configuration file has
 * not yielded yet.
 *
 * Read off the table above rather than named a second time. It used to be
 * `DEFAULT_ENGINE = "duckduckgo"`, one of the three copies of that default
 * the survey found — and the one that would have gone on saying
 * "duckduckgo" after the registry started saying something else. What this
 * expresses now is only "the first engine offered", which is a property of
 * the table and drifts from nothing, because it no longer claims to be the
 * default. The engine the user actually chose lives in the configuration
 * file and reaches the store over config_get.
 */
const FALLBACK_TEMPLATE: string =
  SEARCH_ENGINES[
    Object.keys(SEARCH_ENGINES)[0] as keyof typeof SEARCH_ENGINES
  ].template;

export function homeUrlWith(
  engine: SearchEngineId | null,
  customTemplate: string | null | undefined,
  rule: TextRule | null
): string {
  const template = templateFor(engine, customTemplate, rule);
  // The engine's home is its site root — for a custom template, the origin
  // of wherever the query goes. The %s probe mirrors validSearchTemplate,
  // so anything that validated there parses here.
  return `${new URL(template.replace(/%s/g, "probe")).origin}/`;
}

/** The empty-address destination under the user's current setting. */
export function homeUrl(): string {
  const s = useStore.getState();
  return homeUrlWith(s.searchEngine, s.customSearchTemplate, currentRule());
}

/**
 * The rule the registry gives `browser.custom_search_template`, as of the
 * last schema the core (or the demo's injected registry) answered with.
 *
 * Null before one has arrived, and a null rule is answered below by falling
 * back to a built-in engine rather than by guessing: for the few hundred
 * milliseconds between the values arriving and the schema arriving, a search
 * runs on DuckDuckGo instead of on the user's own engine. That is the same
 * trade the sidebar's drag makes while `sidebarWidthRange` is null, and the
 * alternative — a rule remembered in this module — is the second home this
 * change exists to remove.
 */
function currentRule(): TextRule | null {
  return knownTextRule(CONFIG_KEYS.customSearchTemplate);
}

/**
 * Whether a custom template can be used at all.
 *
 * Two questions, and only the first of them is this module's.
 *
 * The FILE'S rule — empty or not, which schemes, what substring it has to
 * carry — is not asked here and is not written here: it is `Kind::Text`'s
 * [`TextRule`] in src-tauri/src/config.rs, it arrives on the schema, and
 * `textRefusal` applies it. This function used to carry a second copy of
 * that rule (`includes("%s")` and an `^https?://` test), the two copies
 * drifted over whether a scheme is case-sensitive, and a user who held shift
 * got a template the settings page accepted and the file refused.
 *
 * What this adds is "usable", which is a different question from
 * "acceptable" and belongs to the caller rather than to the file: the empty
 * template is a perfectly acceptable value — it is what "no custom engine
 * configured" is written as — and there is still nothing to search with, and
 * a template that no URL can be built from cannot be navigated to whatever
 * the file thinks of it.
 */
export function validSearchTemplate(
  template: string,
  rule: TextRule | null
): boolean {
  // Nothing to judge by is not "everything passes": a template accepted here
  // is navigated to, and guessing at a rule that has not arrived is how a
  // javascript: template would get its chance.
  if (rule === null) return false;
  const t = template.trim();
  if (t === "") return false;
  if (textRefusal(rule, t) !== null) return false;
  try {
    new URL(t.replace(/%s/g, "probe"));
    return true;
  } catch {
    return false;
  }
}

/**
 * The search URL for a query under an explicit engine choice — the pure
 * half, so it is testable without the store. A "custom" choice whose
 * template does not validate falls back to the first built-in engine: a
 * broken setting must degrade to a working search, never to a dead bar.
 */
export function searchUrlWith(
  engine: SearchEngineId | null,
  customTemplate: string | null | undefined,
  query: string,
  rule: TextRule | null
): string {
  // `%s` here is the placeholder the templates in SEARCH_ENGINES above are
  // written with, not a restatement of the registry's `must_contain` — but
  // the two have to be the same token or a custom template would carry a
  // placeholder nothing substitutes, and search.test.ts asserts they are.
  return templateFor(engine, customTemplate, rule).replace(
    /%s/g,
    encodeURIComponent(query)
  );
}

/** The search URL for a query under the user's current setting. */
export function searchUrl(query: string): string {
  const s = useStore.getState();
  return searchUrlWith(
    s.searchEngine,
    s.customSearchTemplate,
    query,
    currentRule()
  );
}

/**
 * The template a search runs on, given the setting and the user's own
 * address. One place decides it, so the empty bar and a typed query can
 * never disagree about which engine is in force.
 *
 * A null engine is the configuration file not having been read yet. It is
 * answered like an unusable custom template — the first built-in engine —
 * rather than by guessing which engine the file will name: a search that
 * happens in that moment must work, and claiming to know the setting would
 * be exactly the copy the registry abolished.
 */
function templateFor(
  engine: SearchEngineId | null,
  customTemplate: string | null | undefined,
  rule: TextRule | null
): string {
  if (engine === null) return FALLBACK_TEMPLATE;
  if (engine !== "custom") return SEARCH_ENGINES[engine].template;
  return customTemplate !== null &&
    customTemplate !== undefined &&
    validSearchTemplate(customTemplate, rule)
    ? customTemplate.trim()
    : FALLBACK_TEMPLATE;
}

export function directUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  const looksLikeHost = /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(raw);
  if (looksLikeHost) return `https://${raw}`;
  if (raw.startsWith("localhost")) return `http://${raw}`;
  return null;
}

/** Turn what the user typed into a URL: a query becomes a search. */
export function toUrl(input: string): string {
  const raw = input.trim();
  if (!raw) return homeUrl();
  return directUrl(raw) ?? searchUrl(raw);
}
