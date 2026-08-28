import { beforeEach, describe, expect, it, vi } from "vitest";
import { useStore, markFreshRun, withPresetGroups } from "./store";
import { flushAll } from "../persist";

/**
 * The layout floor (v0.0.6 field fix): a configuration file that will not
 * parse must still leave the sidebar working. The file is refused loudly —
 * the banner stays — but the two sidebar fields get working values instead
 * of the nulls that collapse the grid and kill the pinned toggle.
 *
 * configGet is mocked at the module seam (the store imports it statically;
 * vi.mock is the one place dynamic replacement is the sanctioned pattern).
 */

vi.mock("./config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config")>();
  return {
    ...actual,
    configGet: () =>
      Promise.reject(
        new Error(
          "/Users/x/Library/Application Support/dev.tabverse.app/config.toml:3:5: key with no value, expected `=`"
        )
      ),
    configSchema: () => Promise.resolve([]),
  };
});

// The store under test, importing the mocked config by its own seam. The
// action is read off the store (it is a store method, not a module export);
// reading it per call keeps the reset's setState from stranding a stale
// reference.
const store = await import("./store");

const reset = async () => {
  await flushAll();
  localStorage.clear();
  useStore.setState({
    tabs: [],
    groups: withPresetGroups([]),
    activeTabId: null,
    sidebarPinned: null,
    sidebarWidth: null,
    configError: null,
    configWriteErrors: [],
  });
};

describe("the sidebar layout floor under a broken config file", () => {
  beforeEach(async () => {
    await reset();
    markFreshRun();
  });

  it("initConfig failure leaves the sidebar pinned at a working width, banner intact", async () => {
    await store.useStore.getState().initConfig();
    const s = useStore.getState();
    // The floor: working values, not nulls. Without it the grid falls back
    // to its stylesheet column (the black strip) and the pinned toggle
    // cannot survive a write that must fail.
    expect(s.sidebarPinned).toBe(true);
    expect(s.sidebarWidth).toBe(248);
    // The refusal is still loud — the floor is usability, not silence.
    expect(s.configError).toBeTruthy();
    expect(s.configError).toContain("config.toml");
  });

  it("values already read are not overwritten by the floor", async () => {
    useStore.setState({ sidebarPinned: false, sidebarWidth: 320 });
    await store.useStore.getState().initConfig();
    const s = useStore.getState();
    expect(s.sidebarPinned).toBe(false);
    expect(s.sidebarWidth).toBe(320);
  });
});
