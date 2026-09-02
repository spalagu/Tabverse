import type { PluginManifest } from "@tabverse/tab-contracts";
import { PluginKernelError } from "./errors";

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

function parseVersion(version: string): readonly [number, number, number] | undefined {
  const match = VERSION.exec(version);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function versionSatisfies(version: string, range: string): boolean {
  if (range === "*" || range === "latest") return true;
  if (range === version) return true;
  const actual = parseVersion(version);
  if (!actual) return false;
  if (range.startsWith("^")) {
    const wanted = parseVersion(range.slice(1));
    return wanted !== undefined && actual[0] === wanted[0] && (
      actual[1] > wanted[1] || (actual[1] === wanted[1] && actual[2] >= wanted[2])
    );
  }
  if (range.startsWith("~")) {
    const wanted = parseVersion(range.slice(1));
    return wanted !== undefined && actual[0] === wanted[0] && actual[1] === wanted[1] && actual[2] >= wanted[2];
  }
  return false;
}

export function validateManifest(manifest: PluginManifest, apiVersion: number): void {
  if (!manifest.id.trim() || !manifest.version.trim() || !parseVersion(manifest.version)) {
    throw new PluginKernelError("INVALID_MANIFEST", `invalid plugin manifest: ${manifest.id || "<empty>"}`);
  }
  if (manifest.apiVersion !== apiVersion) {
    throw new PluginKernelError("INVALID_MANIFEST", `unsupported API version for ${manifest.id}`, {
      expected: apiVersion,
      actual: manifest.apiVersion,
    });
  }
  if (new Set(manifest.tabs).size !== manifest.tabs.length || manifest.tabs.some((kind) => !kind.trim())) {
    throw new PluginKernelError("INVALID_MANIFEST", `invalid or duplicate tab kind in ${manifest.id}`);
  }
  const dependencyIds = manifest.dependencies.map(({ id }) => id);
  if (new Set(dependencyIds).size !== dependencyIds.length || dependencyIds.includes(manifest.id)) {
    throw new PluginKernelError("INVALID_MANIFEST", `invalid dependencies in ${manifest.id}`);
  }
}

export function topologicalOrder(manifests: ReadonlyMap<string, PluginManifest>): readonly string[] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const ordered: string[] = [];
  const visit = (id: string, trail: readonly string[]): void => {
    const manifest = manifests.get(id);
    if (!manifest) {
      throw new PluginKernelError("MISSING_DEPENDENCY", `missing dependency: ${[...trail, id].join(" -> ")}`);
    }
    if (visiting.has(id)) {
      throw new PluginKernelError("DEPENDENCY_CYCLE", `dependency cycle: ${[...trail, id].join(" -> ")}`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of [...manifest.dependencies].sort((a, b) => a.id.localeCompare(b.id))) {
      const installed = manifests.get(dependency.id);
      if (!installed) {
        throw new PluginKernelError("MISSING_DEPENDENCY", `missing dependency: ${[...trail, id, dependency.id].join(" -> ")}`);
      }
      if (!versionSatisfies(installed.version, dependency.range)) {
        throw new PluginKernelError("DEPENDENCY_VERSION", `dependency version mismatch: ${id} -> ${dependency.id}`, {
          required: dependency.range,
          actual: installed.version,
        });
      }
      visit(dependency.id, [...trail, id]);
    }
    visiting.delete(id);
    visited.add(id);
    ordered.push(id);
  };
  for (const id of [...manifests.keys()].sort()) visit(id, []);
  return ordered;
}
