import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryDirectories = [];
const header = "runtime\ttabs\tsample\texit_code\tforced\tsetup_ms\tfirst_create_ms\tfirst_ready_ms\tsecond_create_ms\tsecond_ready_ms\tall_ready_ms\trequest_exit_ms\texit_ms\twall_ms\tsecond_rss_delta_kb\tpeak_rss_kb\tidle_cpu_percent";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), "tabverse-rc-performance-"));
  temporaryDirectories.push(directory);
  const rows = [header];
  for (const tabs of [1, 2, 20]) {
    for (let sample = 1; sample <= 10; sample += 1) {
      const setup = overrides.setup ?? 300;
      const firstCreate = 310;
      const firstReady = firstCreate + (overrides.firstTab ?? 300);
      const secondCreate = tabs === 2 ? 3000 : "";
      const secondReady = tabs === 2 ? secondCreate + (overrides.secondTab ?? 300) : "";
      const allReady = firstCreate + (tabs === 20 ? (overrides.twentyTabs ?? 2400) : 350);
      const requestExit = allReady + 1500;
      const exit = requestExit + (overrides.exit ?? 500);
      rows.push([
        "cef", tabs, String(sample).padStart(2, "0"), 0, 0, setup,
        firstCreate, firstReady, secondCreate, secondReady, allReady,
        requestExit, exit, exit + 20,
        tabs === 2 ? (overrides.secondRssDelta ?? 100_000) : "",
        tabs === 20 ? (overrides.peakRss ?? 2_500_000) : 500_000,
        tabs === 20 ? (overrides.idleCpu ?? 4.5) : 0,
      ].join("\t"));
    }
  }
  const input = join(directory, "samples.tsv");
  const output = join(directory, "result.json");
  writeFileSync(input, `${rows.join("\n")}\n`);
  return { input, output };
}

function run({ input, output }) {
  return execFileSync(process.execPath, [
    resolve("tools/check-rc-performance.mjs"),
    "--input", input, "--output", output,
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

describe("CEF release-candidate performance budget", () => {
  it("accepts three fixed groups of 10 samples within the frozen budget", () => {
    const files = fixture();
    expect(run(files)).toContain('"status":"passed"');
    expect(JSON.parse(readFileSync(files.output, "utf8"))).toMatchObject({
      status: "passed",
      samples: 30,
    });
  });

  it("blocks release when any frozen metric exceeds its budget", () => {
    const files = fixture({ twentyTabs: 3001 });
    expect(() => run(files)).toThrow();
    expect(JSON.parse(readFileSync(files.output, "utf8"))).toMatchObject({
      status: "failed",
    });
  });

  it("blocks release when the second-tab RSS delta exceeds its budget", () => {
    const files = fixture({ secondRssDelta: 132_000 });
    expect(() => run(files)).toThrow();
    expect(JSON.parse(readFileSync(files.output, "utf8"))).toMatchObject({
      status: "failed",
    });
  });
});
