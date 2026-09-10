/**
 * The settings pane's observable contract: the host's registry and values
 * arrive over config_schema + config_get and render grouped rows; Steer
 * changes ride config_set and the pane re-reads (the file is the
 * authority); view level disables every control.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsPane } from "@tabverse/workbench/settings-pane";
import type { HostRpc } from "@tabverse/workbench/host-rpc";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const flush = () => act(async () => {});

const SCHEMA = [
  {
    key: "appearance.theme",
    kind: { choice: { options: ["system", "light", "dark"] } },
    section: "appearance",
    default: "system",
  },
  {
    key: "terminal.font_size",
    kind: { number: { min: 10, max: 24 } },
    section: "terminal",
    default: 13,
  },
  {
    key: "browser.autoplay",
    kind: "toggle",
    section: "browser",
    default: false,
  },
];

function mountRpc(readOnly: boolean) {
  const calls: Array<{ cmd: string; args: unknown }> = [];
  const rpc: HostRpc = async (cmd, args) => {
    calls.push({ cmd, args });
    if (cmd === "config_schema") return SCHEMA;
    if (cmd === "config_get")
      return {
        values: { appearance: { theme: "dark" }, terminal: { font_size: 13 } },
      };
    return null;
  };
  act(() => {
    root.render(<SettingsPane rpc={rpc} readOnly={readOnly} />);
  });
  return { calls, rpc };
}

describe("SettingsPane", () => {
  it("renders the host's registry rows grouped by section with current values", async () => {
    mountRpc(false);
    await flush();
    const sections = [...host.querySelectorAll(".settings-pane-section h3")].map(
      (h) => h.textContent,
    );
    expect(sections).toEqual(["appearance", "terminal", "browser"]);
    // The choice row reads the host's actual value, not the default.
    const select = host.querySelector<HTMLSelectElement>(
      'select',
    )!;
    expect(select.value).toBe("dark");
    expect(host.querySelectorAll(".settings-pane-row")).toHaveLength(3);
  });

  it("a read failure surfaces the error line", async () => {
    act(() => {
      root.render(
        <SettingsPane
          rpc={async () => {
            throw new Error("config unreadable");
          }}
          readOnly={false}
        />,
      );
    });
    await flush();
    expect(host.textContent).toContain("config unreadable");
  });

  it("Steer toggles a row through config_set; view level disables every control", async () => {
    const { calls } = mountRpc(false);
    await flush();
    const box = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    act(() => {
      box.click();
    });
    await flush();
    expect(calls).toContainEqual({
      cmd: "config_set",
      args: { key: "browser.autoplay", value: true },
    });

    // View level: same rows, choice rows disabled and text rows readOnly.
    mountRpc(true);
    await flush();
    for (const input of host.querySelectorAll("input, select")) {
      const el = input as HTMLInputElement;
      expect(el.disabled || el.readOnly).toBe(true);
    }
  });
});
