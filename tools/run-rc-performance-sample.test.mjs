import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("release-candidate performance sample runner", () => {
  it("parses runtime markers without ripgrep on PATH", () => {
    const directory = mkdtempSync(join(tmpdir(), "tabverse-rc-sample-"));
    temporaryDirectories.push(directory);
    const fakeApp = join(directory, "fake-tabverse");
    const outputDirectory = join(directory, "output");
    writeFileSync(
      fakeApp,
      `#!/bin/sh
tabs="\${TABVERSE_RUNTIME_PERFORMANCE_TABS:-1}"
printf '%s\n' 'TABVERSE_RUNTIME_PERFORMANCE_SETUP elapsed_ms=100'
index=1
while [ "$index" -le "$tabs" ]; do
  printf 'TABVERSE_RUNTIME_PERFORMANCE_CREATE index=%s elapsed_ms=%s\n' "$index" "$((100 + index * 10))"
  printf 'TABVERSE_RUNTIME_PERFORMANCE_READY index=%s elapsed_ms=%s\n' "$index" "$((200 + index * 10))"
  index=$((index + 1))
done
printf '%s\n' 'TABVERSE_RUNTIME_PERFORMANCE_ALL_READY elapsed_ms=300'
printf '%s\n' 'TABVERSE_RUNTIME_PERFORMANCE_REQUEST_EXIT elapsed_ms=400'
printf '%s\n' 'TABVERSE_RUNTIME_PERFORMANCE_EXIT elapsed_ms=500'
`,
    );
    chmodSync(fakeApp, 0o755);

    const output = execFileSync(
      "/bin/bash",
      [
        resolve("tools/run-rc-performance-sample.sh"),
        fakeApp,
        "2",
        "01",
        "0",
        outputDirectory,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        },
      },
    );

    const columns = output.trim().split("\t");
    expect(columns.slice(0, 5)).toEqual(["cef", "2", "01", "0", "0"]);
    expect(columns.slice(5, 13)).toEqual([
      "100",
      "110",
      "210",
      "120",
      "220",
      "300",
      "400",
      "500",
    ]);
    expect(readFileSync(join(outputDirectory, "cef-2-01.log"), "utf8")).toContain(
      "TABVERSE_RUNTIME_PERFORMANCE_READY index=2",
    );
  });
});
