/**
 * vite-demo-config.mjs — the configuration registry, handed to the browser
 * demo the same way the desktop core hands it to the real window.
 *
 * WHY THIS EXISTS. `npm run dev` in a plain browser has no desktop core
 * behind it, so `config_get` and `config_schema` have nobody to answer them.
 * Until this plugin the settings page there had six null values and an empty
 * schema: the theme segment, the search-engine select and the auto-archive
 * select all rendered `disabled`, the search index carried only section
 * titles, and the changed-only view drew nothing. That matters beyond the
 * demo's own comfort — browser automation uses this surface for DOM and
 * screenshot checks, so a settings page that cannot work here cannot be
 * covered by that layer.
 *
 * WHERE THE VALUES COME FROM. src-tauri/src/config.rs, mechanically, via
 * `tools/config-registry-extractor.py --emit-json`. That script parses
 * `impl Default for Config`, the `token_enum!` invocations and the `SETTINGS`
 * table. Asking the extractor is the one way to get these values without
 * becoming that second copy. Nothing here knows what any default is; change
 * `Config::default()` and the next dev-server start says the new thing.
 *
 * SHAPE. `window.__TABVERSE_BOOT_CONFIG__` is set to exactly what
 * src-tauri/src/lib.rs injects into the real window (config_get's `values`),
 * so the demo goes through `bootConfig()` — the desktop path — rather than a
 * reading route of its own. The schema, which the desktop answers over a
 * command rather than injecting, rides beside it under a name that says it
 * is the demo's.
 *
 * WHERE IT DOES NOT APPLY. `apply: "serve"` keeps it out of `vite build`,
 * whose output is what Tauri bundles and where the core does the injecting;
 * an inline script in that HTML would run after the core's initialization
 * script and overwrite real values with defaults. The guard inside the
 * injected script is the second lock on the same door: under `tauri dev` the
 * dev server is the desktop's too, and there the core has already spoken.
 */

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const EXTRACTOR = join(REPO, "tools", "config-registry-extractor.py");
const REGISTRY = join(REPO, "src-tauri", "src", "config.rs");

/** The name the core injects the loaded configuration under (config.ts). */
const BOOT_CONFIG_KEY = "__TABVERSE_BOOT_CONFIG__";
/** The registry rows, which on the desktop arrive over `config_schema`. */
const DEMO_SCHEMA_KEY = "__TABVERSE_DEMO_CONFIG_SCHEMA__";
/**
 * The demo's write-failure switch (state/config.ts).
 *
 * Declared here and set to `false`, so that it exists to be found: the
 * failed-save banner is a standing condition nothing in a working demo
 * produces, and this is the one way to see it in the only channel this
 * project can photograph. Turn it over from the console —
 * `__TABVERSE_DEMO_WRITE_FAILS__ = true` — change any setting, and the page
 * says which one did not save; set it back to `false` and the next change
 * lands with the banner staying gone. Both halves are the demonstration:
 * a demo that always refused could not tell "it appears when a write fails"
 * apart from "it is always there".
 */
const DEMO_WRITE_FAILS_KEY = "__TABVERSE_DEMO_WRITE_FAILS__";

/**
 * Read the registry. Throws with the extractor's own stderr attached: a
 * registry this cannot parse is a build that must stop, not a demo that
 * quietly falls back to no settings — the whole point of deriving these is
 * that nobody notices they went stale otherwise.
 */
function derive() {
  let out;
  try {
    out = execFileSync("python3", [EXTRACTOR, "--emit-json", "-"], {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const detail = e.stderr?.toString().trim() || e.message;
    throw new Error(
      `cannot derive the demo configuration from ${REGISTRY}: ${detail}`
    );
  }
  const payload = JSON.parse(out);
  if (!payload.values?.appearance || !Array.isArray(payload.schema)) {
    throw new Error(
      `the registry export from ${EXTRACTOR} has no values or no schema`
    );
  }
  if (payload.schema.length === 0) {
    throw new Error(`the registry export from ${EXTRACTOR} carries no settings`);
  }
  return payload;
}

/**
 * `</script>` inside a JSON string would end the tag it is embedded in. The
 * values are tokens and templates rather than markup, but the escape costs
 * nothing and the failure it prevents is silent.
 */
function embed(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function script(payload) {
  return `(function () {
  // The desktop core has already injected the real configuration by the time
  // any page script runs, and a demo default written over it would be a lie
  // about a file that exists.
  if ("__TAURI_INTERNALS__" in window) return;
  window.${BOOT_CONFIG_KEY} = ${embed(payload.values)};
  window.${DEMO_SCHEMA_KEY} = ${embed(payload.schema)};
  // Off, and named: writes work until somebody turns this over by hand.
  window.${DEMO_WRITE_FAILS_KEY} = false;
})();`;
}

export function demoConfig() {
  let payload = null;
  return {
    name: "tabverse-demo-config",
    // Serve only: see the header. The built bundle is the desktop's.
    apply: "serve",
    buildStart() {
      payload = derive();
    },
    configureServer(server) {
      // Editing a default in config.rs is a thing somebody does mid-session,
      // and a demo still showing the old one would be indistinguishable from
      // a demo that had made the value up.
      server.watcher.add(REGISTRY);
      server.watcher.on("change", (file) => {
        if (resolve(file) !== REGISTRY) return;
        try {
          payload = derive();
          server.config.logger.info(
            "[tabverse-demo-config] registry changed; reloading the demo"
          );
          server.ws.send({ type: "full-reload" });
        } catch (e) {
          server.config.logger.error(`[tabverse-demo-config] ${e.message}`);
        }
      });
    },
    transformIndexHtml() {
      if (payload === null) return;
      return [
        {
          tag: "script",
          // Before the module script that boots the app: the store is built
          // synchronously from these values, so arriving afterwards would be
          // arriving too late.
          injectTo: "head-prepend",
          children: script(payload),
        },
      ];
    },
  };
}
