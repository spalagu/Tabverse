import { useCallback, useEffect, useState } from "react";
import {
  bootConfig,
  configGet,
  profiles,
  type ConfigProfile,
} from "../state/config";

export function useProfiles(active = true): {
  list: ConfigProfile[];
  /** Re-read the file — for a surface that has just written to it. */
  reload: () => void;
} {
  const [list, setList] = useState<ConfigProfile[]>(() =>
    profiles(bootConfig())
  );
  // Bumped to ask for a fresh read; the effect below is keyed on it.
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((n) => n + 1), []);

  useEffect(() => {
    if (!active) return;
    let live = true;
    configGet()
      .then((snap) => {
        if (live) setList(profiles(snap.values));
      })
      // A configuration that cannot be read leaves the list as it was: the
      // boot copy is what this app has been drawing all along, and emptying
      // it would be this hook deciding the user has no profiles.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [active, generation]);

  return { list, reload };
}
