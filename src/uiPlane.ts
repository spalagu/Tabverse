import { coreLog } from "./errlog";
import { IS_MAC } from "./platform";
import { useStore } from "./state/store";


const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export const planeSupported = isTauri && IS_MAC;

/** In-tree floating pieces that are not children of `.app`. */
const FLOATERS = [
  ".folder-preview",
  ".peek-scrim",
  ".peek-actions",
  ".pane-actions",
  ".split-dropzone",
  ".cert-block",
  // The address bar a page summons with cmd+L: drawn inside the pane it
  // belongs to, over the page it is about.
  ".browser-pane > .overlay",
  // The pane's option menu hangs BELOW its buttons and can reach past the
  // cell the buttons live in, so it is named in its own right rather than
  // trusted to fall inside .pane-actions' rectangle (2026-08-12 review).
  ".split-menu",
  // The load rail floats over the page's top edge while it loads
  // (round eleven): it participates in no layout, so the pane never
  // shifts when a navigation starts or ends.
  ".browser-pane > .browser-progress",
];

/**
 * Children of `.app` that are NOT overlays: the pane container (it IS where
 * the pages live) and the invisible strip that summons the sidebar (it must
 * never cost the pages the pointer).
 */
function isOverlayChild(el: Element): boolean {
  if (el.tagName === "MAIN") return false;
  if (el.classList.contains("sidebar-peek-zone")) return false;
  return true;
}

function rects(els: Iterable<Element>): DOMRect[] {
  const out: DOMRect[] = [];
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width > 1 && r.height > 1 && r.right > 0 && r.bottom > 0) out.push(r);
  }
  return out;
}

/** Where pages actually are: the slots this document reserves for them. */
export function pageRects(): DOMRect[] {
  return rects(document.querySelectorAll(".browser-slot"));
}

/** Every piece of interface that could land on top of a page. */
export function overlayRects(): DOMRect[] {
  const app = document.querySelector(".app");
  const kids = app ? Array.from(app.children).filter(isOverlayChild) : [];
  return [...rects(kids), ...rects(document.querySelectorAll(FLOATERS.join(",")))];
}

export function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

/** Does any interface piece currently cover part of any page? */
export function planeShouldBeOnTop(): boolean {
  const pages = pageRects();
  if (pages.length === 0) return false;
  // Two moments have nothing to do with covering pixels and everything to do
  // with the pointer: dragging a split divider, and dragging a tab over the
  // content to make a split. Both need this document to keep hearing the
  // pointer while it travels ACROSS a page, and a native view under the
  // cursor would swallow every move. Being on top is what keeps the drag
  // alive — pointer capture cannot cross a sibling view.
  const s = useStore.getState();
  if (s.splitDragging || s.contentDrag !== null) return true;
  // The floating sidebar is authoritative once its Browser page has been
  // photographed. Until that snapshot lands, keep the two native webviews in
  // their old order; raising the app layer during the hand-off would leave a
  // live Browser child and the host webview competing for the cursor again.
  if (s.sidebarPeeking) {
    const active = s.tabs.find((tab) => tab.id === s.activeTabId);
    if (active?.type === "browser" && active.url !== undefined && s.pageFreeze === null) {
      return false;
    }
    return true;
  }
  return overlayRects().some((o) => pages.some((p) => overlaps(o, p)));
}

let current = false;
let inFlight: Promise<unknown> = Promise.resolve();

/**
 * Send the answer to the core, and only when it changes.
 *
 * Serialised: two orderings sent from different frames can otherwise land out
 * of order, and the loser would leave the interface behind the pages with a
 * menu open — the exact bug this whole mechanism exists to remove.
 */
function apply(onTop: boolean, force = false): void {
  if (!force && onTop === current) return;
  current = onTop;
  if (!isTauri) return;
  inFlight = inFlight
    .then(() => import("@tauri-apps/api/core"))
    .then(async ({ invoke }) => {
      await invoke("ui_plane_set", { onTop });
      // Taking the pointer away is not something a page can notice: its view
      // simply stops being sent events, so whatever it was hovering stays
      // hovered and its tooltip stays on screen. Say what is true — the
      // pointer left — the moment the layer takes it.
      if (onTop) {
        await invoke("browser_release_hover").catch(() => {});
      }
      // One page is allowed above this document: the peek overlay's. The
      // scrim has to dim what is behind it without dimming the peek itself,
      // and the peeked page has to stay clickable — so it goes back on top
      // every time this layer moves.
      const peek = useStore.getState().peekTabId;
      if (onTop && peek !== null) {
        await invoke("browser_plane_raise", { tabId: peek }).catch(() => {});
      }
    })
    .catch((e) => coreLog("error", `ui_plane_set failed: ${e}`));
}

let pumpUntil = 0;
let pumping = false;
let lastOverlaySignature = "";

function overlaySignature(): string {
  return overlayRects()
    .map((r) =>
      [r.left, r.top, r.right, r.bottom]
        .map((n) => Math.round(n * 10) / 10)
        .join(","),
    )
    .join(";");
}

function evaluate(): void {
  const shouldBeOnTop = planeShouldBeOnTop();
  const signature = overlaySignature();
  const geometryChanged = signature !== lastOverlaySignature;
  lastOverlaySignature = signature;
  // If another Browser overlay already owns the app plane, opening or
  // animating a second floating layer must still refresh the cursor. The old
  // sidebar-only reassertion missed Folder Preview in exactly this state.
  if (shouldBeOnTop && current && geometryChanged) {
    apply(true, true);
  } else {
    apply(shouldBeOnTop);
  }
}

function pump(): void {
  evaluate();
  pumpUntil = performance.now() + 600;
  if (pumping) return;
  pumping = true;
  const tick = () => {
    evaluate();
    if (performance.now() < pumpUntil) {
      window.setTimeout(tick, 40);
    } else {
      pumping = false;
    }
  };
  window.setTimeout(tick, 40);
}

/** Watch this document for anything that changes what covers what. */
export function startUiPlane(): () => void {
  if (!planeSupported) return () => {};
  const app = document.querySelector(".app");
  if (!app) return () => {};
  const observer = new MutationObserver(() => pump());
  observer.observe(app, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "style"],
  });
  window.addEventListener("resize", pump);
  pump();
  return () => {
    observer.disconnect();
    window.removeEventListener("resize", pump);
  };
}
