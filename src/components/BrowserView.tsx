import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { onAppCommand } from "../appCommands";
import { coreLog } from "../errlog";
import { recordVisit } from "../history";
import { reapplyMute } from "../mediaControl";
import { rememberZoom, zoomFor } from "../zoomMemory";
import { toUrl } from "../search";
import {
  anyOverlayOpen,
  contentObstructionX,
  useStore,
  type Tab,
} from "../state/store";
import { NewTabView } from "./NewTabView";
import { BrowserDemoPane } from "@tabverse/workbench/browser-new-tab-pane";
import {
  BrowserNativePane,
  type BrowserFillableLogins,
  type BrowserFindResult,
  type BrowserNavigationError,
  type BrowserPasswordOffer,
} from "@tabverse/workbench/browser-native-pane";
import {
  forgetProgress,
  navSignal,
  playDemoNavigation,
  type NavSignal,
} from "@tabverse/workbench/browser-progress";
import { describeError, type ErrorDescription } from "../strings/errors";
import { STR } from "../strings";
import { formatKeys, HINT_KEYS } from "../strings/formatKeys";
import { keysFor } from "../shortcuts";
import { planeSupported } from "../uiPlane";
import type {
  BrowserSessionHandle,
  BrowserSessionPort,
} from "@tabverse/tab-browser";

const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface Props {
  tab: Tab;
  active: boolean;
  session?: BrowserSessionPort;
}

export function BrowserView({ tab, active, session }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState(tab.url ?? "");
  const [current, setCurrent] = useState(tab.url ?? "");
  const [error, setError] = useState<string | ErrorDescription | null>(null);
  const [barOpen, setBarOpen] = useState(false);
  const addressDraftRef = useRef<string | null>(null);
  useEffect(() => {
    if (!barOpen && addressDraftRef.current !== null && address === current) {
      addressDraftRef.current = null;
    }
  }, [barOpen, address, current]);
  const [findOpen, setFindOpen] = useState(false);
  const [findQ, setFindQ] = useState("");
  const [findResult, setFindResult] = useState<BrowserFindResult | null>(null);
  // Pending search-as-you-type debounce timer.
  const findTimerRef = useRef<number | null>(null);
  const reportNav = useCallback(
    (signal: NavSignal) => navSignal(tab.id, signal),
    [tab.id],
  );
  const [navError, setNavError] = useState<BrowserNavigationError | null>(null);
  // A captured login waiting for the user's save/dismiss decision. The
  // secret itself never reaches the UI — host and username are all it gets.
  const [pwOffer, setPwOffer] = useState<BrowserPasswordOffer | null>(null);
  const [fillable, setFillable] = useState<BrowserFillableLogins | null>(null);
  const zoomRef = useRef(1);
  const pendingFullLoad = useRef(false);
  const createdRef = useRef(false);
  const sessionRef = useRef<BrowserSessionHandle | null>(null);
  const slotRevisionRef = useRef(0n);
  // Whether the current navigation produced a real page title; only then may
  // the host-name fallback stay out of the way.
  const gotTitleRef = useRef(false);
  // Where the page actually is. The engine's title callback reports an empty
  // url, so the visit a late title belongs to has to be remembered here.
  const currentUrlRef = useRef(tab.url ?? "");
  // Pending "did the page ever respond" timer for user-initiated navigation.
  const navTimerRef = useRef<number | null>(null);
  const setTabTitle = useStore((s) => s.setTabTitle);
  const overlayOpen = useStore(
    (s) =>
      anyOverlayOpen(s) || (s.peekTabId !== null && s.peekTabId !== tab.id),
  );
  const isPeek = useStore((s) => s.peekTabId === tab.id);
  const splitShown = useStore((s) => {
    const sp = s.split;
    if (sp === null || s.activeTabId === null) return false;
    return sp.ids.includes(s.activeTabId) && sp.ids.includes(tab.id);
  });
  // While the split divider is dragged both panes park: the native views
  // would swallow the pointer mid-drag (see the store's splitDragging).
  const splitDragging = useStore((s) => s.splitDragging);
  // Everything about the split that changes where a pane IS. Read as one
  // string because it has to be an effect dependency: a ResizeObserver hears
  // a pane change SIZE and hears nothing at all when it merely changes PLACE,
  // so Move Left swapped two equal panes in the sidebar and left both pages
  // exactly where they were (2026-08-12 feedback 6). Order, ratios and axis
  // are all place.
  const splitShape = useStore((s) =>
    s.split === null
      ? ""
      : `${s.split.ids.join(",")}|${s.split.ratios.join(",")}|${s.split.vertical}`,
  );
  const contentDragging = useStore((s) => s.contentDrag !== null);
  const previewParksCompanion = useStore(
    (s) => !active && splitShown && s.folderPreviewGroupId !== null,
  );

  const rawInset = useStore(contentObstructionX);
  const peekInset = planeSupported ? 0 : rawInset;
  const frozen = useStore((s) =>
    s.pageFreeze !== null && s.pageFreeze.tabId === tab.id
      ? s.pageFreeze
      : null,
  );
  const [freezeInset, setFreezeInset] = useState(0);
  const [freezeReady, setFreezeReady] = useState(false);
  useLayoutEffect(() => {
    if (frozen === null) {
      setFreezeReady(false);
      return;
    }
    const r = hostRef.current?.getBoundingClientRect();
    setFreezeInset(Math.max(0, peekInset - (r?.left ?? 0)));
    let cancelled = false;
    const probe = new Image();
    probe.src = frozen.src;
    const ready = () => {
      if (!cancelled) setFreezeReady(true);
    };
    probe.decode().then(ready, ready);
    return () => {
      cancelled = true;
    };
    // peekInset is read at freeze time on purpose, not tracked.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [frozen]);
  const bounds = useCallback(() => {
    const el = hostRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const inset = Math.max(0, peekInset - r.left);
    // Reported in device pixels, not CSS pixels.
    //
    // The core places the child webview in the window's own coordinates, and
    // a CSS pixel is only the same length as one of those when nothing is
    // scaling the page. Windows' "Text size" accessibility setting does
    // exactly that — at 120% the viewport reports 1134 CSS px for a 1360-unit
    // window, and a page sized from those numbers came out a fifth too small
    // with the pane's background showing around it. devicePixelRatio is the
    // one number that already carries every factor in play (display scale ×
    // page zoom), so multiplying by it is exact rather than corrective.
    const dpr = window.devicePixelRatio || 1;
    return {
      x: (r.left + inset) * dpr,
      y: r.top * dpr,
      width: Math.max(0, r.width - inset) * dpr,
      height: r.height * dpr,
    };
  }, [peekInset]);

  // Create the child webview once the slot has a real size — and only once
  // the tab has somewhere to go. Until then the new-tab page is showing,
  // there is no slot, and creating a webview would mean loading a page the
  // user never asked for.
  useEffect(() => {
    if (!isTauri || session === undefined || createdRef.current) return;
    const url = tab.url;
    if (!url) return;
    const el = hostRef.current;
    if (!el) return;

    const tryCreate = async () => {
      const b = bounds();
      if (!b || b.width < 20 || b.height < 20 || createdRef.current) return;
      createdRef.current = true;
      coreLog(
        "info",
        `browser_create attempt tab=${tab.id} ${b.width}x${b.height}`,
      );
      try {
        const handle = await session.ensureSession({
          tabId: tab.id,
          profileId: "default",
          initialUrl: toUrl(url),
          network: { kind: "system" },
          privateMode: false,
        });
        sessionRef.current = handle;
        slotRevisionRef.current += 1n;
        await session.attachSurface(tab.id, {
          slotId: `browser-slot-${tab.id}`,
          slotRevision: slotRevisionRef.current,
          ownerWindowId: "main",
          visible: true,
          bounds: b,
        });
        // Ask the page who it is; the answer also proves it loaded.
        window.setTimeout(() => {
          void import("@tauri-apps/api/core").then(({ invoke }) =>
            invoke("browser_probe", { tabId: tab.id }).catch(() => {}),
          );
        }, 800);
      } catch (e) {
        createdRef.current = false;
        sessionRef.current = null;
        coreLog("error", `browser_create failed: ${e}`);
        setError(describeError(e, STR.errors.actions.showPage));
      }
    };

    void tryCreate();
    const ro = new ResizeObserver(() => void tryCreate());
    ro.observe(el);
    return () => ro.disconnect();
  }, [tab.id, tab.url, bounds, session]);

  useEffect(() => {
    if (session === undefined) return;
    const subscription = session.subscribe(tab.id, (envelope) => {
      if (sessionRef.current?.sessionGeneration !== envelope.sessionGeneration)
        return;
      if (envelope.event.type === "renderer-crashed") {
        setError({
          title: "The page process stopped",
          next: "Reload the tab to create a fresh browser process.",
          detail: "",
        });
      } else if (envelope.event.type === "session-closed") {
        sessionRef.current = null;
        createdRef.current = false;
      }
    });
    return () => {
      void subscription.dispose();
    };
  }, [session, tab.id]);

  const certBlocked = navError?.kind === "certificate";

  // Keep the floating webview aligned with our slot, and park it when hidden.
  useEffect(() => {
    if (!isTauri || session === undefined) return;
    let raf = 0;
    const sync = async () => {
      const b = bounds();
      // Nothing to place while the new-tab page is up: there is no slot to
      // measure and no webview to park, and asking the core to move one that
      // was never created would be an error per animation frame.
      if (!b || !createdRef.current) return;
      slotRevisionRef.current += 1n;
      const visible =
        (active || splitShown || isPeek) &&
        !certBlocked &&
        !overlayOpen &&
        !barOpen &&
        !(frozen !== null && freezeReady) &&
        !(splitShown && splitDragging) &&
        !contentDragging &&
        !previewParksCompanion;
      await session
        .attachSurface(tab.id, {
          slotId: `browser-slot-${tab.id}`,
          slotRevision: slotRevisionRef.current,
          ownerWindowId: "main",
          visible,
          bounds: b,
        })
        .catch(() => {});
    };
    let late = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(late);
      raf = requestAnimationFrame(() => void sync());
      // And a timer beside it, because an occluded window is handed no frames
      // at all: a split that changed shape while another app was in front
      // would keep its pages at the old rectangles until something else woke
      // the loop. The frame does the smooth case, the timer does the honest
      // one; both call the same idempotent sync.
      late = window.setTimeout(() => void sync(), 60);
    };
    void sync();
    window.addEventListener("resize", schedule);
    const el = hostRef.current;
    const ro = el ? new ResizeObserver(schedule) : null;
    if (el && ro) ro.observe(el);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(late);
      window.removeEventListener("resize", schedule);
      ro?.disconnect();
    };
  }, [
    tab.id,
    active,
    overlayOpen,
    barOpen,
    certBlocked,
    frozen,
    freezeReady,
    bounds,
    splitShown,
    isPeek,
    splitDragging,
    splitShape,
    contentDragging,
    previewParksCompanion,
    session,
  ]);

  useEffect(() => {
    if (!isTauri || !planeSupported || !isPeek) return;
    const t = window.setTimeout(() => {
      void import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("browser_plane_raise", { tabId: tab.id }).catch(() => {}),
      );
    }, 60);
    return () => window.clearTimeout(t);
  }, [isPeek, tab.id]);

  useEffect(() => {
    if (!isTauri) return;
    let host: string | null = null;
    if (tab.pinnedUrl !== undefined) {
      try {
        host = new URL(tab.pinnedUrl).hostname || null;
      } catch {
        host = null;
      }
    }
    void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("browser_set_peek_anchor", { tabId: tab.id, host }).catch(
        () => {},
      ),
    );
  }, [tab.id, tab.pinnedUrl]);

  // Close the child webview when the tab goes away.
  useEffect(() => {
    return () => {
      useStore.getState().clearScriptCommands(tab.id);
      void import("../favicons").then(({ forgetTabFavicon }) =>
        forgetTabFavicon(tab.id),
      );
      useStore.getState().setTabAudible(tab.id, false);
      useStore.getState().setTabMuted(tab.id, false);
      // The load bar belonged to this pane; a tab id can be reused by a
      // later tab, and inheriting a half-drawn bar would be a bar about
      // nobody's navigation.
      forgetProgress(tab.id);
      if (!isTauri || !createdRef.current || session === undefined) return;
      void session.closeSession(tab.id, "tab-close").catch(() => {});
    };
  }, [tab.id, session]);

  // Loading state from the engine's page-load phases.
  useEffect(() => {
    if (!isTauri) return;
    const unsubs: Array<() => void> = [];
    import("@tauri-apps/api/event").then(({ listen }) => {
      void listen<{
        tabId: string;
        kind: string;
        host: string;
        url: string;
        message: string;
      }>("browser-nav-error", (e) => {
        if (e.payload.tabId !== tab.id) return;
        // The engine said why. Nothing may be inferred from silence after
        // this, so the guess-timer is cancelled and its message never runs.
        if (navTimerRef.current !== null) {
          window.clearTimeout(navTimerRef.current);
          navTimerRef.current = null;
        }
        reportNav("fail");
        setError(null);
        setNavError(e.payload);
      }).then((fn) => unsubs.push(fn));
      void listen<{ tabId: string }>("browser-loading", (e) => {
        if (e.payload.tabId !== tab.id) return;
        reportNav("start");
        // A real load began: the page about to finish is a fresh document, so
        // per-host zoom is applied and any mute re-asserted when it lands.
        pendingFullLoad.current = true;
        useStore.getState().setTabAudible(tab.id, false);
        gotTitleRef.current = false;
        // A new page invalidates the old page's fill offer.
        setFillable(null);
        // The engine spoke — but only that a load began; whether it
        // succeeds is a separate question now answered by its own event.
        setError(null);
        setNavError(null);
        if (navTimerRef.current !== null) {
          window.clearTimeout(navTimerRef.current);
          navTimerRef.current = null;
        }
      }).then((fn) => unsubs.push(fn));
      void listen<{ tabId: string }>("browser-url", (e) => {
        if (e.payload.tabId !== tab.id) return;
        reportNav("complete");
        if (navTimerRef.current !== null) {
          window.clearTimeout(navTimerRef.current);
          navTimerRef.current = null;
        }
      }).then((fn) => unsubs.push(fn));
    });
    return () => unsubs.forEach((f) => f());
  }, [tab.id, reportNav]);

  // Real page titles arrive from the engine's own callback.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<{ tabId: string; url: string; title: string }>(
        "browser-title",
        (e) => {
          if (e.payload.tabId !== tab.id) return;
          reportNav("commit");
          if (e.payload.title.trim()) {
            gotTitleRef.current = true;
            setTabTitle(tab.id, e.payload.title);
            // The title arrives after the load event that recorded the visit,
            // and carries no url of its own — this names the visit that is
            // already in history rather than adding a second one.
            recordVisit(currentUrlRef.current, e.payload.title);
          }
        },
      ).then((fn) => {
        unlisten = fn;
      });
    });
    return () => unlisten?.();
  }, [tab.id, setTabTitle, reportNav]);

  useEffect(() => {
    if (!isTauri) return;
    const unsubs: Array<() => void> = [];
    import("@tauri-apps/api/event").then(({ listen }) => {
      void listen<{ tabId?: string; host: string; username: string }>(
        "browser-password-offer",
        (e) => {
          // Older cores sent no id; then, and only then, the front view takes
          // it — otherwise the tab that captured the login owns the offer.
          if (e.payload.tabId !== undefined) {
            if (e.payload.tabId !== tab.id) return;
          } else if (!active) {
            return;
          }
          setPwOffer(e.payload);
        },
      ).then((fn) => unsubs.push(fn));
      void listen<{ tabId: string; host: string; usernames: string[] }>(
        "browser-password-fillable",
        (e) => {
          if (e.payload.tabId !== tab.id) return;
          setFillable({ host: e.payload.host, usernames: e.payload.usernames });
        },
      ).then((fn) => unsubs.push(fn));
    });
    return () => unsubs.forEach((f) => f());
  }, [tab.id, active]);

  const answerOffer = async (saveIt: boolean, never = false) => {
    const offer = pwOffer;
    setPwOffer(null);
    if (!offer) return;
    const { invoke } = await import("@tauri-apps/api/core");
    if (saveIt) {
      await invoke("pw_offer_save", { host: offer.host }).catch((e) =>
        coreLog("error", `pw_offer_save failed: ${e}`),
      );
    } else {
      await invoke("pw_offer_dismiss", { host: offer.host, never }).catch(
        () => {},
      );
    }
  };

  const fillWith = async (username: string) => {
    const f = fillable;
    setFillable(null);
    if (!f) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("pw_fill", {
      tabId: tab.id,
      host: f.host,
      username,
    }).catch((e) => coreLog("error", `pw_fill failed: ${e}`));
  };

  // Match counts arrive from the page's finder as a cancelled navigation the
  // core re-emits.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<{
        tabId: string;
        total: number;
        current: number;
        frames?: number;
      }>("browser-find-result", (e) => {
        if (e.payload.tabId !== tab.id) return;
        setFindResult({
          total: e.payload.total,
          current: e.payload.current,
          frames: e.payload.frames ?? 1,
        });
      }).then((fn) => {
        unlisten = fn;
      });
    });
    return () => unlisten?.();
  }, [tab.id]);

  // The page reports its own url back through the core.
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | null = null;
    import("@tauri-apps/api/event").then(({ listen }) => {
      listen<{ tabId: string; url: string; title: string }>(
        "browser-url",
        (e) => {
          if (e.payload.tabId !== tab.id) return;
          if (e.payload.url) {
            setCurrent(e.payload.url);
            setAddress(e.payload.url);
            currentUrlRef.current = e.payload.url;
            // Remember where we ended up, not just where we started.
            useStore.getState().setTabUrl(tab.id, e.payload.url);
            // A load that finished is the only honest evidence of a visit —
            // what was typed may have redirected or failed. The title comes
            // later, from the engine's own callback above.
            recordVisit(e.payload.url, e.payload.title ?? "");
            // The host is only a fallback label: when the engine already
            // delivered the real title, overwriting it here turned every
            // sidebar row back into a bare domain.
            if (!gotTitleRef.current) {
              try {
                setTabTitle(tab.id, new URL(e.payload.url).host || "Browser");
              } catch {
                setTabTitle(tab.id, "Browser");
              }
            }
            if (pendingFullLoad.current) {
              pendingFullLoad.current = false;
              try {
                const host = new URL(e.payload.url).host;
                const remembered = zoomFor(host);
                if (remembered !== undefined) {
                  zoomRef.current = remembered;
                  void invokeZoom(remembered);
                }
              } catch {
                /* a url with no host carries no per-host zoom */
              }
              reapplyMute(tab.id);
            }
          }
        },
      ).then((fn) => {
        unlisten = fn;
      });
    });
    return () => unlisten?.();
  }, [tab.id, setTabTitle]);

  // Page navigation and zoom, from whichever route the shortcut survived: a
  // keydown never arrives while the page itself holds the keyboard, so on
  // macOS these reach us as menu commands instead.
  useEffect(() => {
    if (!active) return;
    return onAppCommand((cmd) => {
      switch (cmd) {
        case "location-bar": {
          const draft = addressDraftRef.current;
          setBarOpen((v) => {
            if (!v) setAddress(draft ?? current);
            return !v;
          });
          return;
        }
        case "find":
          setFindOpen(true);
          // ⌘F was pressed inside the page, so the keyboard is with the page;
          // the bar's input is useless until the UI gets it back.
          void import("@tauri-apps/api/core").then(({ invoke }) =>
            invoke("ui_focus").catch(() => {}),
          );
          return;
        case "reload":
          void nav("reload");
          return;
        case "back":
          void nav("back");
          return;
        case "forward":
          void nav("forward");
          return;
        case "open-external":
          // The escape hatch: whatever this embedded browser cannot do,
          // the system browser can — same page, user's default choice.
          void import("@tauri-apps/api/core").then(({ invoke }) =>
            invoke("browser_open_external", {
              url: currentUrlRef.current,
            }).catch(() => {}),
          );
          return;
        case "copy-url":
          void navigator.clipboard
            ?.writeText(currentUrlRef.current)
            .catch(() => {});
          return;
        case "go-pinned": {
          const pinned = useStore
            .getState()
            .tabs.find((t) => t.id === tab.id)?.pinnedUrl;
          if (pinned && pinned !== currentUrlRef.current)
            void nav("go", pinned);
          return;
        }
        case "zoom-in":
          zoomRef.current = Math.min(3, zoomRef.current + 0.1);
          void invokeZoom(zoomRef.current);
          rememberHostZoom(zoomRef.current);
          return;
        case "zoom-out":
          zoomRef.current = Math.max(0.3, zoomRef.current - 0.1);
          void invokeZoom(zoomRef.current);
          rememberHostZoom(zoomRef.current);
          return;
        case "zoom-reset":
          zoomRef.current = 1;
          void invokeZoom(1);
          rememberHostZoom(1);
          return;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // Coming back to an empty tab, the keyboard may still be held by the child
  // webview of the browser tab we left — and this page is nothing but an
  // input, so the UI has to take it back.
  useEffect(() => {
    if (!isTauri || !active || tab.url) return;
    void import("@tauri-apps/api/core").then(({ invoke }) =>
      invoke("ui_focus").catch(() => {}),
    );
  }, [active, tab.url]);

  // Demo channel only: a way to replay a navigation, and to step it one
  // signal at a time, without opening a fresh tab each time. The walkthrough
  // and any screenshot script go through the same `navSignal` the desktop
  // engine's callbacks go through — there is no second code path here, only
  // a second way to reach the first one. Named like the demo's other
  // carriers (state/config.ts) so it reads as demo scaffolding on sight.
  useEffect(() => {
    if (isTauri || !import.meta.env.DEV) return;
    const w = window as unknown as {
      __TABVERSE_DEMO_NAV__?: (signal?: NavSignal, tabId?: string) => void;
    };
    // The tab id is a parameter, not just this pane's closure: in a split
    // every pane overwrites this global, and the walkthrough has to be able
    // to load ONE pane and watch the other stay dark. Pane tab ids are on
    // `.pane.split-pane[data-pane-tab-id]` (TabContent.tsx).
    w.__TABVERSE_DEMO_NAV__ = (signal?: NavSignal, tabId = tab.id) => {
      if (signal) navSignal(tabId, signal);
      else playDemoNavigation(tabId);
    };
    return () => {
      delete w.__TABVERSE_DEMO_NAV__;
    };
  }, [tab.id]);

  /**
   * The new-tab page settled on an address. Setting the tab's url is what
   * creates the webview (the create effect watches it), so the first load is
   * the navigation — there is nothing yet to navigate.
   */
  const openFromNewTab = (input: string) => {
    const url = toUrl(input);
    setError(null);
    setAddress(url);
    setCurrent(url);
    currentUrlRef.current = url;
    useStore.getState().setTabUrl(tab.id, url);
    // No webview in the browser demo means no page-load callbacks, so the
    // demo's stand-in engine speaks for them (browserProgress.ts). Without
    // this the load bar would be invisible in the only channel this project
    // can photograph.
    if (!isTauri) playDemoNavigation(tab.id);
  };

  /**
   * The user chose to accept this host's certificate. Recording it before
   * reloading is what makes the retry succeed: the challenge handler reads
   * the same list when the connection is offered again.
   */
  const proceedPastCertificate = async () => {
    const err = navError;
    if (!err) return;
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("trust_certificate_host", { host: err.host }).catch((e) =>
      coreLog("error", `trust_certificate_host failed: ${e}`),
    );
    setNavError(null);
    await nav("go", err.url || current);
  };

  const invokeZoom = async (scale: number) => {
    await session?.command(tab.id, { type: "set-zoom", level: scale });
  };

  const rememberHostZoom = (scale: number) => {
    try {
      const host = new URL(currentUrlRef.current).host;
      if (host) rememberZoom(host, scale);
    } catch {
      /* nothing to key the zoom on */
    }
  };

  const cancelFindTimer = () => {
    if (findTimerRef.current !== null) {
      window.clearTimeout(findTimerRef.current);
      findTimerRef.current = null;
    }
  };

  // The query is passed explicitly because the debounce timer captures the
  // value it saw at the keystroke, which state may no longer match.
  const doFind = async (backwards: boolean, query = findQ) => {
    if (!query) return;
    await session?.command(tab.id, {
      type: "find",
      query,
      direction: backwards ? "previous" : "next",
    });
  };

  const clearFindOnPage = async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("browser_clear_find", { tabId: tab.id }).catch(() => {});
  };

  const closeFind = async () => {
    setFindOpen(false);
    setFindResult(null);
    cancelFindTimer();
    await clearFindOnPage();
  };

  const nav = async (action: string, url?: string) => {
    setError(null);
    const command =
      action === "go"
        ? {
            type: "navigate" as const,
            url: url ?? "",
            navigationId: crypto.randomUUID(),
          }
        : action === "reload"
          ? { type: "reload" as const }
          : action === "back"
            ? { type: "back" as const }
            : { type: "forward" as const };
    const result = await session?.command(tab.id, command);
    if (result?.ok === false) {
      setError(describeError(result.code, STR.errors.actions.openPage));
    }
    if (action === "go") {
      if (navTimerRef.current !== null)
        window.clearTimeout(navTimerRef.current);
      navTimerRef.current = window.setTimeout(() => {
        navTimerRef.current = null;
        setError({
          title: STR.browser.slowPageTitle,
          next: STR.browser.slowPageNext,
          detail: url ?? tab.url ?? "",
        });
      }, 10000);
    }
    window.setTimeout(() => {
      void import("@tauri-apps/api/core").then(({ invoke }) =>
        invoke("browser_probe", { tabId: tab.id }).catch(() => {}),
      );
    }, 900);
  };

  const commitAddress = (value: string) => {
    const url = toUrl(value);
    addressDraftRef.current = null;
    setAddress(url);
    setBarOpen(false);
    void nav("go", url);
  };

  const escapeAddress = (value: string) => {
    addressDraftRef.current = value;
    setBarOpen(false);
  };

  const changeFindQuery = (value: string) => {
    setFindQ(value);
    cancelFindTimer();
    findTimerRef.current = window.setTimeout(() => {
      findTimerRef.current = null;
      if (value) void doFind(false, value);
      else {
        setFindResult(null);
        void clearFindOnPage();
      }
    }, 250);
  };

  const runFind = (backwards: boolean) => {
    cancelFindTimer();
    void doFind(backwards);
  };

  // A tab that has never been anywhere: no page, no webview, no request — the
  // whole pane is the new-tab page until an address is committed. This comes
  // before the desktop-only check on purpose, so the browser demo shows the
  // same start (it explains its own limits once a page is asked for).
  if (!tab.url) {
    return <NewTabView active={active} onNavigate={openFromNewTab} />;
  }

  if (!isTauri) {
    return <BrowserDemoPane tabId={tab.id} />;
  }

  return (
    <BrowserNativePane
      tabId={tab.id}
      currentUrl={current}
      barOpen={barOpen}
      address={address}
      onDismissAddress={() => setBarOpen(false)}
      onAddressChange={setAddress}
      onCommitAddress={commitAddress}
      onEscapeAddress={escapeAddress}
      findOpen={findOpen}
      findQuery={findQ}
      findResult={findResult}
      onFindQueryChange={changeFindQuery}
      onFind={runFind}
      onCloseFind={() => void closeFind()}
      passwordOffer={pwOffer}
      onAnswerPasswordOffer={(save, never) => void answerOffer(save, never)}
      fillableLogins={fillable}
      onFillLogin={(username) => void fillWith(username)}
      onDismissFillableLogins={() => setFillable(null)}
      error={error}
      navigationError={navError}
      onRetryNavigation={() => void nav("go", navError?.url || current)}
      onProceedPastCertificate={() => void proceedPastCertificate()}
      hostRef={hostRef}
      frozenFrame={frozen}
      freezeInset={freezeInset}
      hints={{
        go: formatKeys(HINT_KEYS.enter),
        reload: formatKeys(keysFor("reload")),
        back: formatKeys(keysFor("back")),
        forward: formatKeys(keysFor("forward")),
        zoom: formatKeys(HINT_KEYS.zoom),
        findNext: formatKeys(HINT_KEYS.enter),
        findPrevious: formatKeys(HINT_KEYS.shiftEnter),
        close: formatKeys(HINT_KEYS.escape),
        location: formatKeys(keysFor("location-bar")),
      }}
    />
  );
}
