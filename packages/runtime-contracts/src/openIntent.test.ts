import { describe, expect, it } from "vitest";
import { pathOpenIntent, urlOpenIntent } from "./openIntent";

describe("OpenIntent", () => {
  it("keeps platform ingress semantic and transport-free", () => {
    expect(pathOpenIntent("/tmp/readme.md")).toEqual({
      kind: "path",
      path: "/tmp/readme.md",
    });
    expect(urlOpenIntent("ssh://host")).toEqual({
      kind: "url",
      url: "ssh://host",
    });
  });

  it("rejects empty targets without imposing scheme policy", () => {
    expect(() => pathOpenIntent("")).toThrow("OpenIntent path must not be empty");
    expect(() => urlOpenIntent("")).toThrow("OpenIntent URL must not be empty");
    expect(urlOpenIntent("custom-scheme://resource")).toEqual({
      kind: "url",
      url: "custom-scheme://resource",
    });
  });
});
