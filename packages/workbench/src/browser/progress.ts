import tokens from "@tabverse/workbench/theme/tokens.json";

/** What the engine just said about a navigation in one pane. */
export type NavSignal = "start" | "commit" | "complete" | "fail";

/** Which of the three stops the bar is standing on. */
export type NavPhase = "idle" | "started" | "committed" | "finishing";

export interface NavProgress {
  phase: NavPhase;
  /** How far the band is drawn across the pane, 0–100. */
  extent: number;
  /** The finished band is on its way out (opacity, not width). */
  fading: boolean;
}

/** Nothing is loading. A shared constant so repeated reads are identity-
 *  stable, which is what `useSyncExternalStore` requires of its snapshot. */
export const PROGRESS_IDLE: NavProgress = Object.freeze({
  phase: "idle",
  extent: 0,
  fading: false,
});

/**
 * The three stops. They are not a guess at how much of the page has
 * arrived — nothing in the engine reports that — they are how much of the
 * bar each ANSWERED question is worth. A load that has begun is visibly
 * under way; a document that exists is most of the way there; finished is
 * finished.
 */
export const PROGRESS_EXTENT: Record<Exclude<NavPhase, "idle">, number> = {
  started: 15,
  committed: 70,
  finishing: 100,
};

/** How long the completed band holds at 100% before it starts to fade.
 *  The same token the CSS width transition uses, so the sprint is over by
 *  the time the fade begins. */
export const PROGRESS_SPRINT_MS = tokens.shared.motion.durSlow;

/** How long the fade itself takes; the CSS opacity transition uses the
 *  same token, so the band is invisible exactly when it is unmounted. */
export const PROGRESS_FADE_MS = tokens.shared.motion.durSlow;

/**
 * The state machine. Pure: same state + same signal, same answer, no clock
 * read anywhere in it.
 *
 * Two of these rules are about NOT drawing a bar. A `commit` or `complete`
 * that arrives while nothing is loading belongs to a page that is already
 * on screen — an in-page address change, a late title — and lighting up a
 * progress bar for it would be a bar that reports nothing.
 */
export function advance(state: NavProgress, signal: NavSignal): NavProgress {
  switch (signal) {
    case "start":
      // Always, including out of `finishing`: a second navigation started
      // before the first one's bar faded is a new load, not a continuation.
      return { phase: "started", extent: PROGRESS_EXTENT.started, fading: false };
    case "commit":
      if (state.phase !== "started") return state;
      return { phase: "committed", extent: PROGRESS_EXTENT.committed, fading: false };
    case "complete":
      if (state.phase !== "started" && state.phase !== "committed") return state;
      return { phase: "finishing", extent: PROGRESS_EXTENT.finishing, fading: false };
    case "fail":
      // The failure has its own full-pane surface (certificate block) or its
      // own strip of text. A bar sprinting to 100% next to either would be
      // announcing a success that did not happen.
      return PROGRESS_IDLE;
  }
}

/**
 * The class list the band wears, derived rather than written at the call
 * site so the reduced-motion rule is one decision in one place.
 *
 * `glow` carries the halo AND the flowing texture; `plain` is the flat
 * single-color bar reduced-motion asks for. They are mutually exclusive on
 * purpose: a stylesheet that only removed the animation would leave the
 * glow, and the requirement is that the glow goes too.
 */
export function bandClasses(
  state: NavProgress,
  opts: { reducedMotion: boolean }
): string[] {
  const out = ["browser-progress-band", `phase-${state.phase}`];
  out.push(opts.reducedMotion ? "plain" : "glow");
  if (state.fading) out.push("fading");
  return out;
}

/** The user's motion preference, or `false` where nothing can be asked. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/* ------------------------------------------------------------------ store */

const states = new Map<string, NavProgress>();
const watchers = new Map<string, Set<() => void>>();
const timers = new Map<string, number[]>();

function notify(tabId: string): void {
  watchers.get(tabId)?.forEach((fn) => fn());
}

function cancelTimers(tabId: string): void {
  timers.get(tabId)?.forEach((t) => clearTimeout(t));
  timers.delete(tabId);
}

function later(tabId: string, ms: number, fn: () => void): void {
  const handle = setTimeout(fn, ms) as unknown as number;
  const list = timers.get(tabId);
  if (list) list.push(handle);
  else timers.set(tabId, [handle]);
}

function put(tabId: string, next: NavProgress): void {
  states.set(tabId, next);
  notify(tabId);
}

/** This pane's current progress. */
export function progressFor(tabId: string): NavProgress {
  return states.get(tabId) ?? PROGRESS_IDLE;
}

/** Watch one pane. Returns the unsubscribe. */
export function subscribeProgress(tabId: string, fn: () => void): () => void {
  let set = watchers.get(tabId);
  if (!set) {
    set = new Set();
    watchers.set(tabId, set);
  }
  set.add(fn);
  return () => {
    set.delete(fn);
    if (set.size === 0) watchers.delete(tabId);
  };
}

/**
 * Feed one pane what the engine said. The only way progress ever changes.
 *
 * The two timers here belong to the EXIT of a finished load — hold at 100%,
 * then fade — and they run only after `complete` arrived. Nothing schedules
 * anything on `start` or `commit`, which is why an unanswered load leaves a
 * bar that does not creep.
 */
export function navSignal(tabId: string, signal: NavSignal): void {
  const before = progressFor(tabId);
  const after = advance(before, signal);
  if (after === before) return;
  cancelTimers(tabId);
  put(tabId, after);
  if (after.phase !== "finishing") return;
  later(tabId, PROGRESS_SPRINT_MS, () => {
    // Re-read: a new navigation may have started inside the sprint, and it
    // owns the bar now.
    const held = progressFor(tabId);
    if (held.phase !== "finishing") return;
    put(tabId, { ...held, fading: true });
    later(tabId, PROGRESS_FADE_MS, () => {
      if (progressFor(tabId).phase !== "finishing") return;
      cancelTimers(tabId);
      states.delete(tabId);
      notify(tabId);
    });
  });
}

/** A pane went away: drop its state and any timer still owed to it. */
export function forgetProgress(tabId: string): void {
  cancelTimers(tabId);
  states.delete(tabId);
  notify(tabId);
}

/** Test-only: back to a world where nothing has ever navigated. */
export function resetAllProgress(): void {
  for (const tabId of [...timers.keys()]) cancelTimers(tabId);
  states.clear();
  watchers.clear();
}

/* ------------------------------------------------------------- demo channel */

/**
 * The browser demo's stand-in engine.
 *
 * `npm run dev` in a plain browser has no webview and therefore no page-load
 * callbacks, so the one channel this project can photograph would otherwise
 * be the one channel where this bar cannot be seen. These timers stand in
 * for the engine exactly the way src/backend/mock.ts stands in for the PTY:
 * they produce the same four signals from the same entry point, and they
 * exist only on the path where `isTauri` is false. They are not the bar's
 * clock — feed the same signals from a real engine and the bar behaves
 * identically.
 *
 * The intervals are deliberately slower than a real page so each of the
 * three stops is legible in a screenshot.
 */
export const DEMO_COMMIT_MS = 900;
export const DEMO_COMPLETE_MS = 2600;

export function playDemoNavigation(tabId: string): void {
  navSignal(tabId, "start");
  setTimeout(() => navSignal(tabId, "commit"), DEMO_COMMIT_MS);
  setTimeout(() => navSignal(tabId, "complete"), DEMO_COMPLETE_MS);
}
