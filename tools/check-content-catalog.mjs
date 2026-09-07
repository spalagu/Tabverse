import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const catalog = JSON.parse(
  readFileSync(join(ROOT, "resources", "content-types.json"), "utf8"),
);
const tauri = JSON.parse(
  readFileSync(join(ROOT, "src-tauri", "tauri.conf.json"), "utf8"),
);

const violations = [];

if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.types)) {
  violations.push("resources/content-types.json must use schemaVersion 1 with a types array");
}

const ids = new Set();
const extensions = new Map();
for (const type of catalog.types ?? []) {
  if (typeof type.id !== "string" || type.id.length === 0) {
    violations.push("every content type must have a non-empty id");
    continue;
  }
  if (ids.has(type.id)) violations.push(`duplicate content type id ${JSON.stringify(type.id)}`);
  ids.add(type.id);

  if (typeof type.handler !== "string" || type.handler.length === 0) {
    violations.push(`${type.id} has no handler`);
  }
  if (type.view !== true) {
    violations.push(`${type.id} is associated but does not declare a useful view capability`);
  }
  if (!Array.isArray(type.extensions) || type.extensions.length === 0) {
    violations.push(`${type.id} has no extensions`);
    continue;
  }

  for (const raw of type.extensions) {
    const ext = String(raw).toLowerCase();
    const previous = extensions.get(ext);
    if (previous !== undefined) {
      violations.push(`extension .${ext} is owned by both ${previous} and ${type.id}`);
    } else {
      extensions.set(ext, type.id);
    }
  }
}

const declared = new Set(
  (tauri.bundle?.fileAssociations ?? [])
    .flatMap((association) => association.ext ?? [])
    .map((ext) => String(ext).toLowerCase()),
);
const catalogExtensions = new Set(extensions.keys());

for (const ext of declared) {
  if (!catalogExtensions.has(ext)) {
    violations.push(`Tauri association .${ext} is missing from resources/content-types.json`);
  }
}
for (const ext of catalogExtensions) {
  if (!declared.has(ext)) {
    violations.push(`content catalog extension .${ext} is not declared by the current Tauri bundle`);
  }
}

if (violations.length > 0) {
  console.error("V3 content catalog check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(
  `V3 content catalog check passed (${catalog.types.length} content types, ${catalogExtensions.size} extensions)`,
);
