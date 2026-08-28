import { useCallback, useEffect, useState } from "react";
import {
  bootConfig,
  configGet,
  templates,
  type ConfigTemplate,
} from "../state/config";

export function useTemplates(active = true): {
  list: ConfigTemplate[];
  /** Re-read the file — for the dialog that has just written to it. */
  reload: () => void;
} {
  const [list, setList] = useState<ConfigTemplate[]>(() =>
    templates(bootConfig())
  );
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((n) => n + 1), []);

  useEffect(() => {
    if (!active) return;
    let live = true;
    configGet()
      .then((snap) => {
        if (live) setList(templates(snap.values));
      })
      // An unreadable configuration leaves the list as it was, for the same
      // reason the profile list's does: emptying it would be this hook
      // deciding the user has no layouts.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [active, generation]);

  return { list, reload };
}
