import { describe, expect, it } from "vitest";
import {
  OpenIntentRouter,
  pathOpenIntent,
  urlOpenIntent,
} from "./openIntent";

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

describe("OpenIntentRouter", () => {
  const router = new OpenIntentRouter();

  it("routes known and unknown paths to useful content handlers", () => {
    expect(router.route(pathOpenIntent("/work/README.md"))).toMatchObject({
      kind: "content",
      handler: "markdown",
      contentType: { id: "markdown" },
    });
    expect(router.route(pathOpenIntent("/work/blob.custom"))).toMatchObject({
      kind: "content",
      handler: "binary",
    });
  });

  it.each([
    ["https://example.com/a", "browser"],
    ["http://localhost:8080", "browser"],
    ["ssh://user@host:2222", "terminal"],
    ["telnet://host:23", "terminal"],
    ["mailto:user@example.com", "external"],
  ])("routes %s to %s", (url, kind) => {
    expect(router.route(urlOpenIntent(url)).kind).toBe(kind);
  });

  it("routes file URLs through the same content registry", () => {
    expect(router.route(urlOpenIntent("file:///tmp/data%20set.csv"))).toMatchObject({
      kind: "content",
      path: "/tmp/data set.csv",
      handler: "table",
    });
    expect(router.route(urlOpenIntent("file:///C:/work/readme.md"))).toMatchObject({
      path: "C:/work/readme.md",
      handler: "markdown",
    });
    expect(router.route(urlOpenIntent("file://server/share/image.png"))).toMatchObject({
      path: "//server/share/image.png",
      handler: "image",
    });
  });

  it("rejects malformed URL intents", () => {
    expect(() => router.route(urlOpenIntent("not a URL"))).toThrow(
      "OpenIntent URL is invalid",
    );
  });
});
