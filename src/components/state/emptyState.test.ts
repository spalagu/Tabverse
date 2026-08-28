import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptyState } from "./EmptyState";
import { FolderIcon } from "../icons";

describe("EmptyState", () => {
  it("renders icon, title, hint, action and key badge when all given", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, {
        icon: FolderIcon,
        title: "Empty folder",
        hint: "Files you create here will show up in the tree.",
        action: { label: "New file", run: () => {} },
        kbd: "⌘N",
      })
    );
    expect(html).toContain("empty-state");
    expect(html).toContain("empty-state-icon");
    expect(html).toContain("Empty folder");
    expect(html).toContain("Files you create here");
    expect(html).toContain(">New file</button>");
    expect(html).toContain(">⌘N</kbd>");
  });

  it("title alone renders no icon, no button, no badge, no hint", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, { title: "Nothing here" })
    );
    expect(html).toContain("Nothing here");
    expect(html).not.toContain("empty-state-icon");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("<kbd");
    expect(html).not.toContain("empty-state-hint");
  });

  it("an empty kbd string renders no badge (keysShownFor empty)", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, { title: "Nothing here", kbd: "" })
    );
    expect(html).not.toContain("<kbd");
  });
});
