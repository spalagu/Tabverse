import { beforeEach, describe, expect, it } from "vitest";
import { sessionSnapshot, useStore, withPresetGroups } from "./store";


const reset = () => {
  useStore.setState({
    tabs: [],
    groups: withPresetGroups([]),
    activeTabId: null,
    split: null,
  });
};

describe("a tab opened under a profile", () => {
  beforeEach(reset);

  it("carries the profile's name", () => {
    const id = useStore.getState().addTab({
      type: "terminal",
      profile: "deploy",
    });
    const tab = useStore.getState().tabs.find((t) => t.id === id);
    expect(tab?.profile).toBe("deploy");
  });

  it("carries none when it was opened without one", () => {
    // Absent, never an invented default: a plain terminal is what nearly
    // every caller asks for, and a name here would send it down the profile
    // path in the core.
    const id = useStore.getState().addTab({ type: "terminal" });
    expect(useStore.getState().tabs.find((t) => t.id === id)?.profile).toBeUndefined();
  });

  it("does not put one on tabs of other kinds unasked", () => {
    const id = useStore.getState().addTab({ type: "files" });
    expect(useStore.getState().tabs.find((t) => t.id === id)?.profile).toBeUndefined();
  });
});

describe("what a restart brings back", () => {
  beforeEach(reset);

  it("leaves the profile out of the session, so no start command re-runs", () => {
    useStore.getState().addTab({ type: "terminal", profile: "deploy", cwd: "/srv" });
    const [saved] = sessionSnapshot(useStore.getState()).tabs;
    expect(saved.cwd, "the directory is remembered").toBe("/srv");
    expect(
      (saved as { profile?: string }).profile,
      "the profile must not ride the session"
    ).toBeUndefined();
  });
});
