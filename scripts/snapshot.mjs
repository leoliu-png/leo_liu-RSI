import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises";
import { hasSnapshotEvidence } from "./snapshot-evidence.mjs";
import { statusReport, statusSummary } from "./snapshot-status.mjs";

const endpoint = process.env.RSI_SITE_URL || "https://rsi-evolution-lab.leoliu-dev.workers.dev";
const response = await fetch(new URL("/api/evolution", endpoint), {
  headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000)
});
if (!response.ok) throw new Error(`Evolution API returned HTTP ${response.status}`);
const data = await response.json();
if (data.modelProfile && !/^[a-z0-9-]+$/.test(data.modelProfile)) throw new Error("Invalid snapshot model profile");
const initial = statusReport(data);
const directory = new URL("../snapshots/", import.meta.url);
const suffix = `-v4-${data.modelProfile || "unknown"}`;
const statusTarget = new URL(`${initial.date}${suffix}-status.json`, directory);
let previous;
try { previous = JSON.parse(await readFile(statusTarget, "utf8")); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const report = statusReport(data, Date.now(), previous);
await mkdir(directory, { recursive: true });

if (data.latestRun?.date === report.date && data.latestRun.status === "completed") {
  if (!hasSnapshotEvidence(data)) throw new Error("Experiment response is missing evaluation evidence");
  await writeFile(new URL(`${report.date}${suffix}.json`, directory), `${JSON.stringify({ ...data, archive: report }, null, 2)}\n`);
}
// Always write a truthful health report, including pending and duplicate failures.
await writeFile(statusTarget, `${JSON.stringify({ ...data, archive: report }, null, 2)}\n`);
console.log(`RSI ${report.date}: experiment=${report.experimentStatus}; freshResult=${report.freshMeasurement}; duplicateAlert=${report.duplicateAlert}`);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, statusSummary(report, data));
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT,
  `experiment_status=${report.experimentStatus}\nfresh_result=${report.freshMeasurement}\nalert=${report.notify}\n`);
const annotation = String(report.error || report.experimentStatus).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
if (report.notify) { console.error(`::error::RSI daily task stopped: ${annotation}`); process.exitCode = 1; }
else if (report.finalFailure) console.warn(`::warning::RSI still failed (already reported): ${annotation}`);
else if (!report.freshMeasurement) console.log(`::notice::No completed fresh experiment: ${report.experimentStatus}`);
