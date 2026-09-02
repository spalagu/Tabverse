import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const input = value("--input");
const output = value("--output");
const rows = readFileSync(resolve(input), "utf8")
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => {
    const [runtime, tabs, sample, exitCode, forced, setup, firstCreate, firstReady, secondCreate, secondReady, allReady, requestExit, exit, wall, secondRssDelta, peakRss, idleCpu] = line.split("\t");
    return {
      runtime,
      tabs: Number(tabs),
      sample,
      exitCode: Number(exitCode),
      forced: Number(forced),
      setup: Number(setup),
      firstTab: Number(firstReady) - Number(firstCreate),
      secondTab: secondCreate ? Number(secondReady) - Number(secondCreate) : null,
      secondRssDeltaMiB: secondRssDelta ? Number(secondRssDelta) / 1024 : null,
      allReady: Number(allReady) - Number(firstCreate),
      exit: Number(exit) - Number(requestExit),
      wall: Number(wall),
      peakRssMiB: Number(peakRss) / 1024,
      idleCpu: Number(idleCpu),
    };
  });

for (const tabs of [1, 2, 20]) {
  const count = rows.filter((row) => row.tabs === tabs).length;
  if (count !== 10) throw new Error(`tabs=${tabs} requires 10 samples, got ${count}`);
}
if (rows.some((row) => row.runtime !== "cef" || row.exitCode !== 0 || row.forced !== 0)) {
  throw new Error("found a failed, forced, or non-CEF sample");
}

const hot = rows.filter((row) => row.sample !== "01");
const limits = {
  setupP95Ms: [p95(hot.map((row) => row.setup)), 550],
  firstTabP95Ms: [p95(hot.map((row) => row.firstTab)), 500],
  firstUseFirstTabMaxMs: [Math.max(...rows.map((row) => row.firstTab)), 15000],
  secondTabP95Ms: [p95(rows.filter((row) => row.tabs === 2).map((row) => row.secondTab)), 500],
  secondTabRssDeltaP95MiB: [p95(rows.filter((row) => row.tabs === 2).map((row) => row.secondRssDeltaMiB)), 128],
  twentyTabsP95Ms: [p95(rows.filter((row) => row.tabs === 20 && row.sample !== "01").map((row) => row.allReady)), 3000],
  firstUseTwentyTabsMaxMs: [Math.max(...rows.filter((row) => row.tabs === 20).map((row) => row.allReady)), 60000],
  twentyTabsPeakRssP95MiB: [p95(rows.filter((row) => row.tabs === 20).map((row) => row.peakRssMiB)), 3072],
  twentyTabsIdleCpuP95Percent: [p95(rows.filter((row) => row.tabs === 20).map((row) => row.idleCpu)), 6],
  exitP95Ms: [p95(rows.map((row) => row.exit)), 1500],
};
const failed = Object.entries(limits).filter(([, [actual, limit]]) => !Number.isFinite(actual) || actual > limit);
const report = {
  schema: "tabverse-rc-performance/v1",
  status: failed.length === 0 ? "passed" : "failed",
  samples: rows.length,
  samplePolicy: "10 fixed samples for each 1/2/20-tab group; warm p95 excludes sample 01 while first-use diagnostics retain every sample",
  metrics: Object.fromEntries(Object.entries(limits).map(([name, [actual, limit]]) => [name, { actual: round(actual), limit }])),
};
writeFileSync(resolve(output), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
if (failed.length > 0) throw new Error(`RC performance budget exceeded: ${failed.map(([name]) => name).join(", ")}`);

function p95(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return Number.NaN;
  const index = (sorted.length - 1) * 0.95;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function round(number) {
  return Math.round(number * 100) / 100;
}

function value(flag) {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing ${flag}`);
  return process.argv[index + 1];
}
