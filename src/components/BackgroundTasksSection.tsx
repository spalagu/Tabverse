import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { STR } from "../strings";
import {
  RESIDENT_KEYS,
  configGet,
  configSetSoon,
  residentDefaultOf,
} from "../state/config";
import { recordConfigWrite, useStore } from "../state/store";

export function BackgroundTasksSection({ hidden = false }: { hidden?: boolean }) {
  const tasks = useStore((state) => state.backgroundTasks);
  const attach = useStore((state) => state.attachBackgroundTask);
  const setTasks = useStore((state) => state.setBackgroundTasks);
  const [residentDefault, setResidentDefault] = useState<boolean | null>(null);

  useEffect(() => {
    let live = true;
    configGet()
      .then((snapshot) => {
        if (live) setResidentDefault(residentDefaultOf(snapshot.values));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const writeResidentDefault = (next: boolean) => {
    const previous = residentDefault;
    if (previous === null) return;
    setResidentDefault(next);
    configSetSoon(RESIDENT_KEYS.default, next, (outcome) => {
      if (outcome.ok) {
        recordConfigWrite(RESIDENT_KEYS.default, null);
        window.dispatchEvent(new Event("tabverse-resident-policy-changed"));
        return;
      }
      setResidentDefault(previous);
      recordConfigWrite(RESIDENT_KEYS.default, outcome.error);
    });
  };

  const terminate = async (id: string) => {
    await invoke("term_kill", { id });
    setTasks(useStore.getState().backgroundTasks.filter((task) => task.id !== id));
  };

  return (
    <section id="background-tasks" className="settings-section" hidden={hidden}>
      <h3>{STR.settings.backgroundTasks.heading}</h3>
      <p className="settings-blurb">{STR.settings.backgroundTasks.blurb}</p>
      <label htmlFor="resident-default">
        {STR.settings.backgroundTasks.residentDefault}
      </label>
      <div className="btn-row">
        <button
          id="resident-default"
          className={`btn${residentDefault === true ? " active" : ""}`}
          data-setting-key={RESIDENT_KEYS.default}
          role="switch"
          aria-checked={residentDefault === true}
          disabled={residentDefault === null}
          onClick={() => writeResidentDefault(residentDefault !== true)}
        >
          {residentDefault === true
            ? STR.settings.appearance.on
            : STR.settings.appearance.off}
        </button>
      </div>
      <p className="pw-empty">
        {residentDefault === null
          ? STR.settings.backgroundTasks.residentDefaultUnread
          : STR.settings.backgroundTasks.residentDefaultNote}
      </p>
      {tasks.length === 0 ? (
        <p className="pw-empty">{STR.settings.backgroundTasks.empty}</p>
      ) : (
        <div className="settings-stack">
          {tasks.map((task) => (
            <article className="settings-card" data-background-task={task.id} key={task.id}>
              <div>
                <strong>{task.id.slice(0, 8)}</strong>
                <p>
                  {task.cwd
                    ? STR.settings.backgroundTasks.cwd({ cwd: task.cwd })
                    : STR.settings.backgroundTasks.unknownCwd}
                </p>
                <p>
                  {typeof task.exited === "number"
                    ? STR.settings.backgroundTasks.exited({ code: task.exited })
                    : STR.settings.backgroundTasks.running}
                </p>
              </div>
              <div className="settings-row-actions">
                <button className="btn" onClick={() => attach(task)}>
                  {STR.settings.backgroundTasks.attach}
                </button>
                <button className="btn danger" onClick={() => void terminate(task.id)}>
                  {STR.settings.backgroundTasks.terminate}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
