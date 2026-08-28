
import snapshotJson from "../../assets/completions/spec.json";
import {
  parseSpec,
  type CompletionSpec,
} from "@tabverse/workbench/terminal/completion";

export * from "@tabverse/workbench/terminal/completion";

// ------------------------------------------------------------- the layers

/**
 * The snapshot layer as the bundle carries it — parsed once at module
 * load, from the same asset pipeline the fonts ride (build-time, hashed,
 * shipped inside the app).
 */
export const SNAPSHOT_SPEC: CompletionSpec | null = parseSpec(snapshotJson);

/** The snapshot's version — what the settings page shows beside "current". */
export function snapshotVersion(): string | null {
  return SNAPSHOT_SPEC === null ? null : SNAPSHOT_SPEC.version;
}

const isTauri = () =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/**
 * The state-directory layer, or null when there is nothing to read:
 * no core to ask (the browser demo has none), no copy written yet, or a
 * copy that does not parse — all three fall through to the snapshot.
 */
async function readStateSpec(): Promise<CompletionSpec | null> {
  if (!isTauri()) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const text = await invoke<string | null>("completions_get");
    return text === null ? null : parseSpec(JSON.parse(text));
  } catch {
    return null;
  }
}

/** Which layer the loaded spec came from — the settings page's wording. */
export type SpecSource = "state" | "snapshot" | "none";

interface Cache {
  spec: CompletionSpec | null;
  source: SpecSource;
}

/**
 * The module-level cache: one load in flight, one answer kept.
 *
 * The version comparison that guards re-adoption: a state copy whose
 * version EQUALS the one already cached does not replace it (same data,
 * no work), and one that DIFFERS does — which is the whole of "the state
 * directory wins when it says something new" (the directory is what
 * "Update now" wrote, so it is the newer cut by construction).
 */
let cache: Cache | null = null;
let loading: Promise<Cache> | null = null;

/** Start one load, comparing its answer against the cache before adopting. */
function runLoad(): Promise<Cache> {
  loading = (async () => {
    const state = await readStateSpec();
    const next: Cache =
      state !== null
        ? { spec: state, source: "state" }
        : SNAPSHOT_SPEC !== null
          ? { spec: SNAPSHOT_SPEC, source: "snapshot" }
          : { spec: null, source: "none" };
    // The version comparison: a re-read that found the same layer holding
    // the same version changes nothing worth re-adopting — the cached
    // object stands (identity is the observable) — and anything else is
    // the update the re-read was for.
    if (
      cache !== null &&
      cache.source === next.source &&
      (cache.spec?.version ?? null) === (next.spec?.version ?? null)
    ) {
      return cache;
    }
    cache = next;
    return next;
  })();
  return loading;
}

/**
 * The spec to complete against, loading it if this is the first ask.
 *
 * `force` re-reads both layers — what the settings page does after an
 * update, since the fetch wrote a file this module has already cached an
 * answer about.
 */
export async function loadCompletionSpec(
  force = false
): Promise<CompletionSpec | null> {
  if (force) return (await runLoad()).spec;
  if (loading !== null) return (await loading).spec;
  if (cache !== null) return cache.spec;
  return (await runLoad()).spec;
}

/** The layer the loaded spec came from, once one has been asked for. */
export function completionSpecSource(): SpecSource | null {
  return cache === null ? null : cache.source;
}

/** The loaded spec's version, once one has been asked for. */
export function completionSpecVersion(): string | null {
  return cache === null || cache.spec === null ? null : cache.spec.version;
}

/** Test seam: back to "nothing has been asked for". */
export function resetCompletionSpecForTest(): void {
  cache = null;
  loading = null;
}

/** Test seam: a spec handed over as though both layers had been read. */
export function setCompletionSpecForTest(
  spec: CompletionSpec | null,
  source: SpecSource = "state"
): void {
  cache = { spec, source };
  loading = Promise.resolve(cache);
}
