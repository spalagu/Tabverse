import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorState } from "./ErrorState";

const sample = {
  title: "Couldn't save the file.",
  next: "The disk is full. Free up some space and try again.",
  detail: "ENOSPC: no space left on device, write",
};

describe("ErrorState inline form", () => {
  it("renders title + next in the strip, raw string inside Details", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorState, { error: sample, inline: true })
    );
    expect(html).toContain("error-state-inline");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Couldn&#x27;t save the file.");
    expect(html).toContain("The disk is full.");
    expect(html).toContain("<summary>Details</summary>");
    expect(html).toContain("ENOSPC: no space left on device, write");
    // Collapsed by default: no open attribute on the fold.
    expect(html).not.toContain("<details open");
    // The raw string appears after the title, never as the headline.
    expect(html.indexOf("Couldn&#x27;t save")).toBeLessThan(
      html.indexOf("ENOSPC")
    );
  });

  it("omits the Details fold when there is no detail text", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorState, {
        error: { title: "Couldn't read the notebook.", detail: "" },
        inline: true,
      })
    );
    expect(html).not.toContain("<details");
  });
});

describe("ErrorState block form", () => {
  it("adds the icon and a Try again button when onRetry exists", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorState, { error: sample, onRetry: () => {} })
    );
    expect(html).toContain("error-state-block");
    expect(html).toContain("error-state-icon");
    expect(html).toContain(">Try again</button>");
  });

  it("has no button without onRetry", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorState, { error: sample })
    );
    expect(html).not.toContain("<button");
  });
});
