import { readFileSync, writeFileSync } from "node:fs";

const catalogPath = new URL("../resources/content-types.json", import.meta.url);
const tauriPath = new URL("../src-tauri/tauri.conf.json", import.meta.url);
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const tauri = JSON.parse(readFileSync(tauriPath, "utf8"));

const grouped = new Map();
for (const type of catalog.types) {
  const metadata = type.association;
  if (!metadata) throw new Error(`${type.id} has no association metadata`);
  const key = JSON.stringify(metadata);
  const association = grouped.get(key) ?? { ext: [], ...metadata };
  for (const extension of type.associationExtensions ?? type.extensions) {
    if (!association.ext.includes(extension)) association.ext.push(extension);
  }
  grouped.set(key, association);
}
const generated = [...grouped.values()];

if (process.argv.includes("--write")) {
  tauri.bundle.fileAssociations = generated;
  writeFileSync(tauriPath, `${JSON.stringify(tauri, null, 2)}\n`);
} else if (JSON.stringify(tauri.bundle.fileAssociations) !== JSON.stringify(generated)) {
  console.error("Tauri fileAssociations are stale; run npm run generate:associations");
  process.exit(1);
} else {
  console.log(`V3 association generation check passed (${generated.length} groups)`);
}
