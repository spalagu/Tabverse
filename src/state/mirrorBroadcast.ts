import { invoke } from "@tauri-apps/api/core";
import { coreLog } from "../errlog";
import { MIRROR_ACTIONS, type MirrorStoreApi } from "./mirrorActions";
import type { AppStore } from "./store";

/** The Rust half of the pipe: forwards to the bound app share's
 * broadcast_action, a no-op when no share is live. */
const BROADCAST_COMMAND = "app_share_broadcast_action";

/** Where a wrapped action's host-generated values come from when the store
 * itself did not produce one to read back. Injectable so the determinism
 * tests can pin the clock and the ids — the property the wire needs,
 * observed rather than trusted. */
export interface ProvenanceGen {
  id(): string;
  now(): number;
}

const hostGen: ProvenanceGen = {
  id: () => crypto.randomUUID(),
  now: () => Date.now(),
};

/** How one broadcast leaves: the name and its wire args. */
export type ActionSender = (name: string, args: unknown) => void;

const tauriSend: ActionSender = (name, args) => {
  void invoke(BROADCAST_COMMAND, { name, args }).catch((e) =>
    coreLog("error", `app share action broadcast failed: ${String(e)}`)
  );
};

/** Everything wireArgsFor may look at: the call as it was made, the
 * generator for values nobody else supplied, the store AFTER the action
 * ran (the created row's own fields are the provenance), and whatever the
 * action returned. */
export interface WireContext {
  args: readonly unknown[];
  gen: ProvenanceGen;
  after?: AppStore;
  ret?: unknown;
}

/** The fields of a created tab that may travel — everything else is
 * host-local runtime state a mirror has no business hearing. */
const TAB_WIRE_FIELDS = ["title", "cwd", "url", "groupId"] as const;

/**
 * The wire args for one whitelisted call, provenance embedded. Undefined
 * means "do not broadcast": a call whose shape is not one the mirror
 * accepts is dropped, never guessed at. The addTab and activateTab arms
 * prefer the READ-BACK row (`after`): the host's own id, title and stamp,
 * which is exactly what the joiner must reuse instead of generating its
 * own; the generator only covers the degraded path where no row exists.
 */
export function wireArgsFor(name: string, ctx: WireContext): unknown {
  switch (name) {
    case "addTab": {
      if (typeof ctx.ret === "string" && ctx.after !== undefined) {
        const row = ctx.after.tabs.find((t) => t.id === ctx.ret);
        if (row === undefined) return undefined;
        const out: Record<string, unknown> = {
          type: row.type,
          id: row.id,
          lastActiveAt: row.lastActiveAt,
        };
        for (const field of TAB_WIRE_FIELDS) {
          const v = row[field];
          if (v !== undefined) out[field] = v;
        }
        return out;
      }
      // Degraded (no read-back): the caller's partial plus generated
      // provenance, so the frame still carries host-chosen values.
      const partial = ctx.args[0];
      if (partial === null || typeof partial !== "object") return undefined;
      const src = partial as Record<string, unknown>;
      const out: Record<string, unknown> = { type: src.type };
      for (const field of TAB_WIRE_FIELDS) {
        const v = src[field];
        if (v !== undefined) out[field] = v;
      }
      out.id = typeof src.id === "string" ? src.id : ctx.gen.id();
      out.lastActiveAt =
        typeof src.lastActiveAt === "number" ? src.lastActiveAt : ctx.gen.now();
      return out;
    }
    case "activateTab": {
      const id = ctx.args[0];
      if (typeof id !== "string") return undefined;
      const row =
        ctx.after !== undefined
          ? ctx.after.tabs.find((t) => t.id === id)
          : undefined;
      const passed = ctx.args[1];
      return {
        id,
        now:
          row?.lastActiveAt ??
          (typeof passed === "number" ? passed : ctx.gen.now()),
      };
    }
    case "closeTab":
    case "splitWith":
      return typeof ctx.args[0] === "string" ? ctx.args[0] : undefined;
    case "setSidebarPeeking":
      return typeof ctx.args[0] === "boolean" ? ctx.args[0] : undefined;
    case "toggleSidebar":
    case "unsplit":
    case "closeMenu":
      // Zero-arg by contract: a null payload (not undefined, which would
      // mean "drop the frame").
      return ctx.args[0] === undefined ? null : undefined;
    case "openMenu": {
      const [tabId, x, y] = ctx.args;
      if (
        typeof tabId !== "string" ||
        typeof x !== "number" ||
        typeof y !== "number"
      ) {
        return undefined;
      }
      return { tabId, x, y };
    }
    case "renameTab": {
      const [id, title] = ctx.args;
      if (typeof id !== "string" || typeof title !== "string") return undefined;
      return { id, title };
    }
    case "toggleGroupCollapsed":
      return typeof ctx.args[0] === "string" ? ctx.args[0] : undefined;
    case "setFilesOpenPath": {
      const [tabId, path] = ctx.args;
      if (typeof tabId !== "string") return undefined;
      if (path === null) return { tabId, path: null };
      return typeof path === "string" ? { tabId, path } : undefined;
    }
    case "setFilesOpenDir": {
      const [tabId, dir] = ctx.args;
      if (typeof tabId !== "string") return undefined;
      if (dir === null) return { tabId, dir: null };
      return typeof dir === "string" ? { tabId, dir } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * The store read as its action surface: name → callable. One structural
 * view over the live instance (zustand keeps the same action functions on
 * the state object across writes) — the wrappers delegate to the very
 * methods this finds and never reimplement a branch, which is what keeps
 * host execution and mirror replay on one code path.
 */
type ActionSurface = Record<string, (...callArgs: unknown[]) => unknown>;

const surfaceOf = (state: AppStore): ActionSurface =>
  state as unknown as ActionSurface;

/** The names both ends agree on — the mirror's own table, nothing local. */
export const BROADCASTABLE_ACTIONS: ReadonlySet<string> = new Set(
  Object.keys(MIRROR_ACTIONS)
);

/**
 * Wrap the whitelisted actions of `api`'s store so each broadcasts what it
 * just executed, provenance read back from the state the action produced.
 * Returns the restore function; not restoring leaves the wrappers in place
 * for a store that outlives the test that wrapped it.
 */
export function installMirrorBroadcast(
  api: Pick<MirrorStoreApi, "getState" | "setState">,
  gen: ProvenanceGen = hostGen,
  send: ActionSender = tauriSend
): () => void {
  const surface = surfaceOf(api.getState());
  // The wrappers are INSTALLED by a state write, not by mutating a
  // snapshot object: zustand copies the state on every set, so a
  // mutation of one snapshot is left behind by the first commit after
  // it, while a merged patch travels into every future state.
  const patch: Record<string, unknown> = {};
  const originals: Record<string, (...callArgs: unknown[]) => unknown> = {};
  for (const name of BROADCASTABLE_ACTIONS) {
    const orig = surface[name];
    if (typeof orig !== "function") continue;
    originals[name] = orig;
    patch[name] = (...callArgs: unknown[]) => {
      const ret = orig.apply(api.getState(), callArgs);
      const wire = wireArgsFor(name, {
        args: callArgs,
        gen,
        after: api.getState(),
        ret,
      });
      if (wire !== undefined) send(name, wire);
      return ret;
    };
  }
  api.setState(patch as Partial<AppStore>);
  return () => {
    const back: Record<string, unknown> = { ...originals };
    api.setState(back as Partial<AppStore>);
  };
}

/**
 * The app's own wiring: desktop only, installed once at boot. The joiner
 * runs this module's receiving half (mirrorActions) instead and must never
 * install the sender — a joiner broadcasting "host" actions would be a
 * second writer.
 */
export function bootMirrorBroadcast(
  api: Pick<MirrorStoreApi, "getState" | "setState">
): () => void {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) {
    return () => {};
  }
  return installMirrorBroadcast(api);
}
