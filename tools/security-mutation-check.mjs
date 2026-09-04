import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const sourcePath = "src-tauri/src/remote_proxy.rs";
const mutations = [
  {
    id: "allow-prohibited-addresses",
    path: "src-tauri/src/network_broker/mod.rs",
    before: `        IpAddr::V4(ip) => {
            ip.is_link_local()
                || ip.is_broadcast()
                || ip == std::net::Ipv4Addr::new(169, 254, 169, 254)
                || ip == std::net::Ipv4Addr::new(100, 100, 100, 200)
        }`,
    after: "        IpAddr::V4(_ip) => false,",
    test: "remote_proxy::tests::network_grant_pins_dns_and_refuses_metadata_before_any_request",
  },
  {
    id: "allow-cross-viewer-grant",
    before: `        if expected_attachment.as_ref() != Some(&(attachment_id.clone(), attachment_generation)) {
            return Err("grant-owner-mismatch: attachment does not belong to viewer".into());
        }`,
    after: `        if false && expected_attachment.as_ref() != Some(&(attachment_id.clone(), attachment_generation)) {
            return Err("grant-owner-mismatch: attachment does not belong to viewer".into());
        }`,
    test: "remote_proxy::tests::network_grant_rejects_cross_viewer_old_generation_origin_port_and_viewer_writes",
  },
];

const results = [];
for (const mutation of mutations) {
  const worktree = mkdtempSync(resolve(tmpdir(), `tabverse-${mutation.id}-`));
  let added = false;
  try {
    execFileSync("git", ["worktree", "add", "--detach", worktree, "HEAD"], {
      cwd: root,
      stdio: "pipe",
    });
    added = true;
    const file = resolve(worktree, mutation.path ?? sourcePath);
    const source = readFileSync(file, "utf8");
    if (!source.includes(mutation.before)) {
      throw new Error(`${mutation.id}: mutation anchor not found`);
    }
    writeFileSync(file, source.replace(mutation.before, mutation.after));
    const run = spawnSync("cargo", [
      "test",
      "--offline",
      "--locked",
      "-p",
      "tabverse",
      mutation.test,
      "--",
      "--exact",
    ], {
      cwd: worktree,
      encoding: "utf8",
      env: { ...process.env, CARGO_TARGET_DIR: resolve(root, "target") },
      maxBuffer: 16 * 1024 * 1024,
    });
    const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    const killed =
      run.status !== 0 &&
      output.includes(mutation.test) &&
      output.includes("FAILED");
    results.push({
      id: mutation.id,
      test: mutation.test,
      mutationKilled: killed,
      exitCode: run.status,
      signal: run.signal,
    });
  } finally {
    if (added) {
      spawnSync("git", ["worktree", "remove", "--force", worktree], {
        cwd: root,
        stdio: "pipe",
      });
    }
  }
}

const result = {
  schema: "tabverse-security-mutation/v1",
  node: process.version,
  mutations: results,
};
process.stdout.write(`${JSON.stringify(result)}\n`);
if (
  results.length !== mutations.length ||
  results.some((entry) => !entry.mutationKilled)
) {
  process.exitCode = 1;
}
