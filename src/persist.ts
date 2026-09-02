import { coreLog } from "./errlog";


const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const DEBOUNCE_MS = 300;

/** The whole tab/group session lives under this scope. */
export const SESSION_SCOPE = "session";

export const THEME_SCOPE = "theme";

export const tabScope = (module: string, tabId: string) =>
  `${module}:${tabId}`;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The tab owning a scope, or null for tab-independent scopes. Tab ids are
 * UUIDs, so a ":<uuid>" tail is the ownership mark — a tail like ":global"
 * is nobody's tab and stays untouched by tab cleanup.
 */
export function scopeTabId(scope: string): string | null {
  const tail = scope.slice(scope.lastIndexOf(":") + 1);
  return UUID_RE.test(tail) ? tail : null;
}

/**
 * The Rust side accepts exactly this shape as a scope name and rejects
 * everything else — no paths, dots, spaces, or non-ASCII. Enforced on the
 * fallback carrier too, so the browser demo cannot mask a name the desktop
 * would refuse. Derive scopes from ids, never from raw paths or user input.
 */
const SCOPE_RE = /^[A-Za-z0-9:_-]{1,120}$/;

function validScope(scope: string): boolean {
  if (SCOPE_RE.test(scope)) return true;
  logFailure("scope-check", scope, "invalid scope name");
  return false;
}

/** localStorage keys of the browser-demo fallback carrier. */
const LS_PREFIX = "tabverse.state.";

interface StateOps {
  save(scope: string, json: string): Promise<void>;
  load(scope: string): Promise<string | null>;
  remove(scope: string): Promise<void>;
  list(): Promise<string[]>;
}

/** The reason a state scope did not yield a usable value. */
export type StateLoadResult<T> =
  | { kind: "value"; value: T }
  | { kind: "missing" }
  | { kind: "read-failed" }
  | { kind: "invalid-json" };

export interface SessionMigrationReport {
  status: "missing" | "already-current" | "migrated" | "not-applicable";
  backupSha256: string | null;
  removedAgentTabs: number;
  survivingTabs: number;
}

/**
 * Run the desktop's crash-safe v1 -> v2 session transaction before startup
 * reads the session. Browser-only demos have no filesystem transaction and
 * instead rely on the restore reader's v1 compatibility.
 */
export async function migrateSessionStateV2(): Promise<SessionMigrationReport> {
  if (!isTauri) {
    return {
      status: "not-applicable",
      backupSha256: null,
      removedAgentTabs: 0,
      survivingTabs: 0,
    };
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return await invoke<SessionMigrationReport>("state_migrate_session_v2");
}

const tauriOps: StateOps = {
  async save(scope, json) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("state_save", { scope, json });
  },
  async load(scope) {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string | null>("state_load", { scope });
  },
  async remove(scope) {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("state_delete", { scope });
  },
  async list() {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke<string[]>("state_list");
  },
};

const localOps: StateOps = {
  save(scope, json) {
    localStorage.setItem(LS_PREFIX + scope, json);
    return Promise.resolve();
  },
  load(scope) {
    return Promise.resolve(localStorage.getItem(LS_PREFIX + scope));
  },
  remove(scope) {
    localStorage.removeItem(LS_PREFIX + scope);
    return Promise.resolve();
  },
  list() {
    const scopes: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith(LS_PREFIX)) scopes.push(key.slice(LS_PREFIX.length));
    }
    return Promise.resolve(scopes);
  },
};

const ops: StateOps = isTauri ? tauriOps : localOps;

/** Serialized, not-yet-written payloads, one slot per scope (last one wins). */
const pending = new Map<string, string>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Per-scope operation chain. A save that is already in flight when a delete
 * for the same scope arrives must land before it, or the delete would be
 * undone and the file resurrected as an orphan. Chaining every backend call
 * on its scope keeps them in call order; ops never reject (they log), so a
 * failed link never stalls the chain.
 */
const chains = new Map<string, Promise<void>>();

function enqueue(scope: string, op: () => Promise<void>): Promise<void> {
  const next = (chains.get(scope) ?? Promise.resolve()).then(op);
  chains.set(scope, next);
  return next;
}

function logFailure(what: string, scope: string, err: unknown) {
  coreLog("error", `state ${what} failed for scope "${scope}": ${String(err)}`);
}

/** Write a scope's buffered payload now instead of waiting for the timer. */
function flushScope(scope: string): Promise<void> {
  const timer = timers.get(scope);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(scope);
  }
  const json = pending.get(scope);
  if (json === undefined) return Promise.resolve();
  pending.delete(scope);
  return enqueue(scope, () =>
    ops.save(scope, json).catch((e) => logFailure("save", scope, e))
  );
}

/**
 * Save `data` under `scope`, debounced (~300ms) and fire-and-forget. The
 * value is serialized here and now, so callers may mutate it afterwards.
 */
export function saveState(scope: string, data: unknown): void {
  if (!validScope(scope)) return;
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch (e) {
    // A value that cannot serialize cannot be saved; never throw at callers.
    logFailure("serialize", scope, e);
    return;
  }
  pending.set(scope, json);
  const timer = timers.get(scope);
  if (timer !== undefined) clearTimeout(timer);
  timers.set(
    scope,
    setTimeout(() => void flushScope(scope), DEBOUNCE_MS)
  );
}

/**
 * Load a scope without erasing the distinction between first launch and a
 * damaged or unavailable existing file.
 *
 * `missing` is the only normal first-launch outcome. Callers that would
 * replace state must not treat the other outcomes as permission to do so.
 */
export async function loadStateResult<T>(scope: string): Promise<StateLoadResult<T>> {
  if (!validScope(scope)) return { kind: "read-failed" };
  // A payload still buffered (or being written) is fresher than the disk.
  const buffered = pending.get(scope);
  let raw: string | null;
  if (buffered !== undefined) {
    raw = buffered;
  } else {
    await chains.get(scope); // let an in-flight write for this scope land
    try {
      raw = await ops.load(scope);
    } catch (e) {
      logFailure("load", scope, e);
      return { kind: "read-failed" };
    }
  }
  if (raw === null) return { kind: "missing" };
  try {
    return { kind: "value", value: JSON.parse(raw) as T };
  } catch {
    return { kind: "invalid-json" };
  }
}

/**
 * Load and parse a scope for callers that do not need recovery diagnostics.
 *
 * Existing non-destructive consumers retain their `null` fallback. Startup
 * recovery uses `loadStateResult` so it cannot overwrite a broken file as if
 * it had never existed.
 */
export async function loadState<T>(scope: string): Promise<T | null> {
  const result = await loadStateResult<T>(scope);
  return result.kind === "value" ? result.value : null;
}


export function loadStateSync<T>(scope: string): T | null {
  if (isTauri || !validScope(scope)) return null;
  const raw = pending.get(scope) ?? localStorage.getItem(LS_PREFIX + scope);
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Delete a scope's stored state, cancelling any buffered save for it first —
 * a tab closed mid-debounce must not have its file written back afterwards.
 */
export function deleteState(scope: string): void {
  if (!validScope(scope)) return;
  const timer = timers.get(scope);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(scope);
  }
  pending.delete(scope);
  void enqueue(scope, () =>
    ops.remove(scope).catch((e) => logFailure("delete", scope, e))
  );
}

export async function listScopes(): Promise<string[]> {
  const stored = await ops.list().catch((e) => {
    logFailure("list", "*", e);
    return [] as string[];
  });
  // A buffered save is already real to callers (loadState serves it), so its
  // scope is listed too — cleanup must see a save that has not landed yet.
  return [...new Set([...stored, ...pending.keys()])];
}

export function flushAll(): Promise<void> {
  const writes = [...pending.keys()].map((scope) => flushScope(scope));
  return Promise.all([...writes, ...chains.values()]).then(() => undefined);
}
