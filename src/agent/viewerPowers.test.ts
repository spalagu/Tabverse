import { describe, expect, it } from "vitest";
import { describePowers, viewerPowers } from "./viewerPowers";

describe("what a viewer may do", () => {
  it("separates steering from approving", () => {
    // The distinction the whole three-level scheme exists for: somebody you
    // want talking to the agent is not thereby somebody who should authorise
    // what it does.
    expect(viewerPowers("steer")).toEqual({ canSteer: true, canApprove: false });
    expect(viewerPowers("approve")).toEqual({ canSteer: true, canApprove: true });
  });

  it("gives a watcher nothing", () => {
    expect(viewerPowers("view")).toEqual({ canSteer: false, canApprove: false });
  });

  it("treats an unknown or missing level as watching", () => {
    // A level from a newer build, or a Mode frame that never arrived. The
    // conservative direction: a viewer wrongly believing it may act is the
    // worse mistake, and the host would refuse the frame anyway.
    expect(viewerPowers(null)).toEqual({ canSteer: false, canApprove: false });
    expect(viewerPowers("admin" as never)).toEqual({ canSteer: false, canApprove: false });
  });

  it("says what is allowed in words a viewer can act on", () => {
    expect(describePowers(viewerPowers("view"))).toContain("watching");
    expect(describePowers(viewerPowers("steer"))).toContain("not approve");
    expect(describePowers(viewerPowers("approve"))).toContain("approve");
  });
});
