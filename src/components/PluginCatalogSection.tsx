import { useEffect, useState } from "react";
import type { PluginCatalogItem, PluginComposition } from "@tabverse/plugin-composition";
import { PluginKernelError } from "@tabverse/plugin-kernel";
import { desktopPluginComposition } from "../pluginComposition";
import { STR } from "../strings";

type CatalogAction =
  | "install"
  | "enable"
  | "disable"
  | "uninstall"
  | "repair"
  | "retry"
  | "controlledUninstall";

const CONTROL_PLANE = new Set([
  "tabverse.tab.settings",
  "tabverse.runtime.settings",
]);

function blockerMessage(error: unknown): string {
  if (!(error instanceof PluginKernelError)) {
    return error instanceof Error ? error.message : String(error);
  }
  const blockers = Array.isArray(error.details.blockers)
    ? error.details.blockers as Array<{ type?: unknown; id?: unknown; detail?: unknown }>
    : [];
  if (blockers.length === 0) return error.message;
  return `${error.message}: ${blockers.map((blocker) =>
    [blocker.type, blocker.id, blocker.detail].filter((part) => typeof part === "string").join(" / ")
  ).join(", ")}`;
}
export function PluginCatalogSection({
  hidden = false,
  composition = desktopPluginComposition(),
}: {
  readonly hidden?: boolean;
  readonly composition?: PluginComposition;
}) {
  const [items, setItems] = useState<readonly PluginCatalogItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = () => {
    void composition.catalog().then(setItems, (error: unknown) => setNote(blockerMessage(error)));
  };

  useEffect(() => {
    refresh();
    return composition.subscribe(() => refresh());
  }, [composition]);

  const run = async (pluginId: string, action: CatalogAction) => {
    setBusy(pluginId);
    setNote(null);
    try {
      await composition[action](pluginId);
      await composition.catalog().then(setItems);
      window.dispatchEvent(new Event("tabverse-plugin-catalog-changed"));
    } catch (error) {
      setNote(blockerMessage(error));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section id="plugins" hidden={hidden}>
      <h3>{STR.settings.plugins.heading}</h3>
      <p>{STR.settings.plugins.blurb}</p>
      <p className="pw-empty">{STR.settings.plugins.trustBoundary}</p>
      <div className="scroll">
        <table className="kv plugin-catalog-table">
          <tbody>
            {items.map((item) => {
              const locked = CONTROL_PLANE.has(item.manifest.id);
              const working = busy === item.manifest.id;
              return (
                <tr key={item.manifest.id} data-plugin-id={item.manifest.id}>
                  <td>
                    <strong>{item.manifest.tabs.join(", ") || STR.settings.plugins.runtime}</strong>
                    <div className="pw-empty">{item.manifest.id} · {item.manifest.version}</div>
                  </td>
                  <td>
                    {STR.settings.plugins.state[item.state]}
                    {item.retainedState && (
                      <div className="pw-empty">{STR.settings.plugins.stateRetained}</div>
                    )}
                    {item.failure && (
                      <div className="pw-empty">{item.failure.operation}: {item.failure.message}</div>
                    )}
                  </td>
                  <td>
                    {locked ? (
                      <span className="pw-empty">{STR.settings.plugins.required}</span>
                    ) : (
                      <div className="btn-row">
                        {item.state === "not-installed" && (
                          <button className="btn" disabled={working} onClick={() => void run(item.manifest.id, "install")}>{STR.settings.plugins.install}</button>
                        )}
                        {(item.state === "installed" || item.state === "disabled") && (
                          <>
                            <button className="btn" disabled={working} onClick={() => void run(item.manifest.id, "enable")}>{STR.settings.plugins.enable}</button>
                            <button className="btn" disabled={working} onClick={() => void run(item.manifest.id, "uninstall")}>{STR.settings.plugins.uninstall}</button>
                          </>
                        )}
                        {item.state === "enabled" && (
                          <button className="btn" disabled={working} onClick={() => void run(item.manifest.id, "disable")}>{STR.settings.plugins.disable}</button>
                        )}
                        {item.state === "failed" && (
                          <>
                            <button className="btn" disabled={working} onClick={() => void run(item.manifest.id, "repair")}>{STR.settings.plugins.repair}</button>
                            <button className="btn" disabled={working} onClick={() => void run(item.manifest.id, "retry")}>{STR.settings.plugins.retry}</button>
                            <button className="btn" disabled={working} onClick={() => void run(item.manifest.id, "controlledUninstall")}>{STR.settings.plugins.uninstall}</button>
                          </>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {note !== null && <p className="settings-plugin-note" role="status">{note}</p>}
    </section>
  );
}
