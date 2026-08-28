import { invoke } from "@tauri-apps/api/core";
import { STR } from "../strings";
import { useStore } from "../state/store";

export function BackgroundTasksSection({ hidden = false }: { hidden?: boolean }) {
  const tasks = useStore((state) => state.backgroundTasks);
  const attach = useStore((state) => state.attachBackgroundTask);
  const setTasks = useStore((state) => state.setBackgroundTasks);

  const terminate = async (id: string) => {
    await invoke("term_kill", { id });
    setTasks(useStore.getState().backgroundTasks.filter((task) => task.id !== id));
  };

  return (
    <section id="background-tasks" className="settings-section" hidden={hidden}>
      <h3>{STR.settings.backgroundTasks.heading}</h3>
      <p className="settings-blurb">{STR.settings.backgroundTasks.blurb}</p>
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
