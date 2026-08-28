import { describe, expect, it } from "vitest";
import { footerMenuPosition } from "./sidebarLayout";

describe("footer menu geometry", () => {
  it("opens above the trigger instead of below the footer", () => {
    expect(footerMenuPosition({ left: 12, top: 820 }, 800, 860)).toEqual({
      left: 12,
      bottom: 48,
    });
  });

  it("keeps the menu inside a narrow viewport", () => {
    expect(footerMenuPosition({ left: 740, top: 480 }, 800, 520)).toEqual({
      left: 582,
      bottom: 48,
    });
  });
});
