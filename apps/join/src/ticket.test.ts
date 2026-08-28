import { describe, expect, it } from "vitest";
import { ticketFromHash } from "./ticket";

describe("ticketFromHash", () => {
  it("returns empty for no fragment", () => {
    expect(ticketFromHash("")).toBe("");
    expect(ticketFromHash("#")).toBe("");
  });

  it("strips the # and surrounding whitespace", () => {
    expect(ticketFromHash("#tabv123")).toBe("tabv123");
    expect(ticketFromHash("#%20tabv123%20")).toBe("tabv123");
  });

  it("percent-decodes a share link's encoding", () => {
    expect(ticketFromHash("#tabv%2Babc%3D")).toBe("tabv+abc=");
  });

  it("survives a fragment that is not valid percent-encoding", () => {
    // A hand-pasted ticket with a stray % must not throw before render.
    expect(ticketFromHash("#tabv%GG")).toBe("tabv%GG");
  });
});
