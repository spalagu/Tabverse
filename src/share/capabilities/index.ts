// The single registration point: one line per tab type, imported once at
// desktop bootstrap (apps/desktop/src/main.tsx). A new kind of tab is a new file here plus
// its line below — no framework file changes.
import "./terminal";
import "./agent";
import "./browser";
import "./files";
import "./settings";
import "./remote";
