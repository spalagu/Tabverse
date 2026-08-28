import { useEffect, useRef } from "react";
import { useStore } from "../state/store";
import { confirmChoose } from "./Confirm";
import { STR } from "../strings";

export function GroupMenu() {
  const menu = useStore((s) => s.groupMenu);
  const group = useStore((s) =>
    s.groups.find((g) => g.id === s.groupMenu?.groupId)
  );
  const close = useStore((s) => s.closeGroupMenu);
  const createEmptyGroup = useStore((s) => s.createEmptyGroup);
  const deleteGroup = useStore((s) => s.deleteGroup);
  const dissolveGroup = useStore((s) => s.dissolveGroup);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown, true);
    };
  }, [menu, close]);

  if (!menu || !group) return null;
  return (
    <div className="ctx-menu" style={{ left: menu.x, top: menu.y }} ref={ref}>
      <div className="ctx-title">{group.name}</div>
      <button
        className="ctx-item"
        onClick={() => {
          createEmptyGroup(group.id);
          close();
        }}
      >
        {STR.common.sidebarMenu.newNestedFolder}
      </button>
      {group.preset === undefined && (
        <>
          <div className="ctx-sep" />
          <button
            className="ctx-item danger"
            onClick={() => {
              const { id, name } = group;
              close();
              void confirmChoose(STR.dialogs.deleteFolderQuestion({ name }), [
                { label: STR.dialogs.deleteFolderLift, value: "lift" },
                {
                  label: STR.dialogs.deleteFolderClose,
                  value: "close",
                  danger: true,
                },
              ]).then((choice) => {
                if (choice === "close") deleteGroup(id);
                else if (choice === "lift") dissolveGroup(id);
              });
            }}
          >
            {STR.common.sidebarMenu.deleteFolder}
          </button>
        </>
      )}
    </div>
  );
}
