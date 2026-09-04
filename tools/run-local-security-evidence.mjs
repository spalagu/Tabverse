import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const output = process.argv[2];
if (!output) throw new Error("usage: node tools/run-local-security-evidence.mjs <output.json>");
if (process.version !== "v22.23.2") {
  throw new Error(`security evidence requires CI Node v22.23.2, got ${process.version}`);
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const input = (path) => ({ path, sha256: sha256(readFileSync(resolve(root, path))) });
const specs = [
  {
    id: "remote-viewer-ui",
    argv: [resolve(root, "node_modules/.bin/vitest"), "run",
      "src/share/framework/remoteBoundary.test.ts",
      "src/share/framework/actions.test.ts",
      "src/share/framework/capability.test.ts",
      "src/share/framework/contributionBridge.test.ts",
      "packages/plugin-composition/src/integration.test.ts",
      "packages/remote-protocol/src/index.test.ts",
      "src/state/mirrorStore.test.ts",
      "apps/join/src/joinDispatch.test.tsx",
      "src/pluginComposition.test.ts"],
    inputs: ["src/state/mirrorStore.test.ts", "apps/join/src/joinDispatch.test.tsx", "src/pluginComposition.test.ts"],
    tests: true,
  },
  {
    id: "native-private-boundary",
    argv: ["cargo", "test", "--offline", "--locked", "-p", "tabverse", "share_commands::tests::"],
    inputs: ["src-tauri/src/share_commands.rs"],
    tests: true,
  },
  {
    id: "browser-two-viewer-and-grants",
    argv: ["cargo", "test", "--offline", "--locked", "-p", "tabverse", "remote_proxy::tests::network_grant_"],
    inputs: ["src-tauri/src/remote_proxy.rs"],
    tests: true,
  },
  {
    id: "browser-audit",
    argv: ["cargo", "test", "--offline", "--locked", "-p", "tabverse", "remote_proxy::tests::network_audit_"],
    inputs: ["src-tauri/src/remote_proxy.rs"],
    tests: true,
  },
  {
    id: "agent-state-migration",
    argv: ["cargo", "test", "--offline", "--locked", "-p", "tabverse-fs", "session_migration::tests::"],
    inputs: ["crates/tabverse-fs/src/session_migration.rs"],
    tests: true,
  },
  {
    id: "agent-proto-decode-only",
    argv: ["cargo", "test", "--offline", "--locked", "-p", "tabverse-proto", "retired_v2_requests_decode_into_unsupported_only_variants"],
    inputs: ["crates/tabverse-proto/src/lib.rs"],
    tests: true,
  },
  {
    id: "agent-remote-unsupported",
    argv: ["cargo", "test", "--offline", "--locked", "-p", "tabverse-remote", "retired_v2_request_receives_a_structured_unsupported_end"],
    inputs: ["crates/tabverse-remote/src/lib.rs"],
    tests: true,
  },
  {
    id: "attachment-generation-real-transport",
    argv: ["cargo", "test", "--offline", "--locked", "-p", "tabverse-remote", "v4_contribution_streams_and_attachment_identity_cross_the_real_transport"],
    inputs: ["crates/tabverse-remote/src/lib.rs"],
    tests: true,
  },
  {
    id: "offline-web-build-and-secret-scan",
    argv: ["bash", "tools/build-web.sh"],
    inputs: [
      "tools/build-web.sh",
      "tools/build-join-page.mjs",
      "tools/build-join-pages.mjs",
      "tools/check-secrets.mjs",
      "vite.pages.config.ts",
      "vite.web.config.ts",
      "Cargo.lock",
      "package-lock.json",
    ],
    outputs: ["dist-web/tabverse-remote.html"],
  },
  {
    id: "secret-scan",
    argv: [
      process.execPath,
      "tools/check-secrets.mjs",
      "--require-artifact",
      "dist",
      "--require-artifact",
      "dist-web",
    ],
    inputs: ["tools/check-secrets.mjs"],
  },
  {
    id: "security-mutations",
    argv: [process.execPath, "tools/security-mutation-check.mjs"],
    inputs: ["tools/security-mutation-check.mjs", "src-tauri/src/remote_proxy.rs"],
  },
];

const commands = specs.map((spec) => {
  const started = Date.now();
  const run = spawnSync(spec.argv[0], spec.argv.slice(1), {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CI: "1", NO_COLOR: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const stdout = run.stdout ?? "";
  const stderr = run.stderr ?? "";
  const testCount = spec.tests
    ? [...`${stdout}\n${stderr}`.matchAll(/running (\d+) tests?|Tests\s+(\d+) passed/g)]
        .reduce((sum, match) => sum + Number(match[1] ?? match[2]), 0)
    : null;
  const passed = run.status === 0 && (!spec.tests || testCount > 0);
  return {
    id: spec.id,
    argv: spec.argv,
    inputs: spec.inputs.map(input),
    outputs: (spec.outputs ?? []).map(input),
    exitCode: run.status,
    signal: run.signal,
    durationMs: Date.now() - started,
    testCount,
    passed,
    stdout,
    stderr,
  };
});

const base = {
  schema: "tabverse-local-security-evidence/v1",
  node: process.version,
  head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  worktreeClean: execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim() === "",
  guiLaunched: false,
  residentServiceActivated: false,
  commands,
  passed: commands.every((command) => command.passed),
};
const report = { ...base, payloadSha256: sha256(JSON.stringify(base)) };
writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  schema: report.schema,
  node: report.node,
  head: report.head,
  commands: report.commands.length,
  tests: report.commands.reduce((sum, command) => sum + (command.testCount ?? 0), 0),
  payloadSha256: report.payloadSha256,
  passed: report.passed,
})}\n`);
if (!report.passed || !report.worktreeClean) process.exitCode = 1;
