import { beforeEach, describe, expect, it } from "vitest";
import {
  applyContributionState,
  configureRemoteTabContributions,
  resetRemoteMirror,
  useRemoteMirrorStore,
} from "./appMirror";
import { createRemoteTestContributions } from "@tabverse/test-runtime";

describe("Single Tab contribution mirror", () => {
  beforeEach(() => {
    configureRemoteTabContributions(createRemoteTestContributions());
    resetRemoteMirror();
  });

  it("creates and activates remote tabs from the contribution snapshot alone", () => {
    expect(applyContributionState("browser-1", "browser", {
      title: "Intranet",
      url: "http://intranet/",
    })).toBe(true);
    expect(useRemoteMirrorStore.getState()).toMatchObject({
      activeTabId: "browser-1",
      tabs: [
        {
          id: "browser-1",
          type: "browser",
          title: "Intranet",
          url: "http://intranet/",
        },
      ],
    });
  });
});
