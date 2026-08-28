import { describe, expect, it, vi } from "vitest";
import type { Terminal } from "@xterm/xterm";
import { createTerminalPathLinkProvider } from "./pathLinks";

function terminalLine(text: string): Terminal {
  return {
    buffer: {
      active: {
        getLine: () => ({ translateToString: () => text }),
      },
    },
  } as unknown as Terminal;
}

describe("terminal path link provider", () => {
  it("resolves paths through ports, caches results, and preserves gestures", async () => {
    const exists = vi.fn(async (path: string) => path === "/work/./src/main.ts");
    const open = vi.fn();
    const hover = vi.fn();
    const provide = createTerminalPathLinkProvider({ exists, open });
    const terminal = terminalLine("open ./src/main.ts:7 and ./src/main.ts:7");

    const first = await provide(terminal, 3, "/work", hover);
    const second = await provide(terminal, 3, "/work", hover);

    expect(exists).toHaveBeenCalledTimes(1);
    expect(exists).toHaveBeenCalledWith("/work/./src/main.ts");
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    first?.[0]?.hover?.({} as MouseEvent, "");
    expect(hover).toHaveBeenCalledWith("./src/main.ts:7", {
      kind: "path",
      path: "./src/main.ts",
      line: 7,
    });
    first?.[0]?.activate({ metaKey: true, shiftKey: false } as MouseEvent, "");
    expect(open).toHaveBeenCalledWith(
      { kind: "path", path: "./src/main.ts", line: 7 },
      true,
      false
    );
  });

  it("omits relative links when no working directory is available", async () => {
    const provide = createTerminalPathLinkProvider({
      exists: vi.fn(async () => true),
      open: vi.fn(),
    });
    await expect(
      provide(terminalLine("./missing-context"), 1, null, vi.fn())
    ).resolves.toBeUndefined();
  });
});
