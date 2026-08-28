import { useEffect, useState } from "react";
import { coreLog } from "../errlog";
import { STR } from "../strings";
import {
  NO_CONFIG_BACKEND,
  configReset,
  configSchema,
  type Setting,
} from "../state/config";
import { modifiedSettings, settingTitle } from "../state/modifiedSettings";
import { useStore } from "../state/store";

export interface SettingsChangedProps {
  /** Whether the page is currently filtered down to the changed settings. */
  onlyChanged: boolean;
  onOnlyChangedChange: (next: boolean) => void;
}

export function SettingsChanged({
  onlyChanged,
  onOnlyChangedChange,
}: SettingsChangedProps) {
  /**
   * The registry, asked for here rather than read off the store: the store
   * keeps only the one bound it needs for the sidebar drag, and this view
   * needs every row's default. A failure costs the view and nothing else,
   * which is why it is not fetched beside the values.
   */
  const [schema, setSchema] = useState<readonly Setting[]>([]);
  useEffect(() => {
    let live = true;
    void configSchema().then(
      (rows) => {
        if (live) setSchema(rows);
      },
      (e: unknown) => {
        // No desktop core to ask is the browser demo, which has no
        // configuration file and so nothing this view could be about.
        if (e !== NO_CONFIG_BACKEND) {
          coreLog("error", `config_schema failed: ${String(e)}`);
        }
      }
    );
    return () => {
      live = false;
    };
  }, []);

  // The live values, straight from the store: flipping a control has to make
  // its row appear at once, and re-reading the file would lag the debounced
  // write behind it.
  const slice = {
    themePreference: useStore((s) => s.themePreference),
    sidebarWidth: useStore((s) => s.sidebarWidth),
    sidebarPinned: useStore((s) => s.sidebarPinned),
    searchEngine: useStore((s) => s.searchEngine),
    customSearchTemplate: useStore((s) => s.customSearchTemplate),
    archiveThreshold: useStore((s) => s.archiveThreshold),
  };
  const initConfig = useStore((s) => s.initConfig);
  const changed = modifiedSettings(schema, slice);

  const [resetting, setResetting] = useState<string | null>(null);
  const reset = async (key: string) => {
    setResetting(key);
    try {
      await configReset(key);
      await initConfig();
    } catch (e) {
      coreLog("error", `config_reset(${key}) failed: ${String(e)}`);
    } finally {
      setResetting(null);
    }
  };

  // Nothing to say without a registry: the browser demo has no configuration
  // file, so a switch offering to filter by it would be a control over
  // nothing.
  if (schema.length === 0) return null;

  return (
    <div className="settings-changed">
      <label className="settings-changed-toggle">
        <input
          type="checkbox"
          checked={onlyChanged}
          onChange={(e) => onOnlyChangedChange(e.target.checked)}
        />
        <span>{STR.settings.changed.onlyChanged}</span>
      </label>

      {onlyChanged &&
        (changed.length === 0 ? (
          <p className="settings-changed-empty">{STR.settings.changed.none}</p>
        ) : (
          <>
            <p className="settings-changed-blurb">
              {STR.settings.changed.blurb}
            </p>
            <ul className="settings-changed-list">
              {changed.map((setting) => {
                const title = settingTitle(setting) ?? setting.key;
                return (
                  <li
                    key={setting.key}
                    className="settings-changed-row"
                    data-setting={setting.key}
                  >
                    <span className="settings-changed-name">{title}</span>
                    {/* The dotted path as the file spells it, so the row also
                        answers "which line is this?" for somebody who would
                        rather edit the file. */}
                    <code className="settings-changed-key">{setting.key}</code>
                    <button
                      type="button"
                      className="btn"
                      disabled={resetting === setting.key}
                      aria-label={STR.settings.changed.resetOne({
                        setting: title,
                      })}
                      onClick={() => void reset(setting.key)}
                    >
                      {STR.settings.changed.reset}
                    </button>
                  </li>
                );
              })}
            </ul>
          </>
        ))}
    </div>
  );
}
