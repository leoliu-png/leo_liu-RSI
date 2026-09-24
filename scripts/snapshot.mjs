import { mkdir, readFile, writeFile } from "node:fs/promises";

const endpoint = process.env.RSI_SITE_URL || "https://rsi-evolution-lab.leoliu-dev.workers.dev";
const response = await fetch(new URL("/api/evolution", endpoint), {
  headers: { accept: "application/json" },
  signal: AbortSignal.timeout(20_000)
});
if (!response.ok) throw new Error(`Evolution API returned HTTP ${response.status}`);
const data = await response.json();
const today = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
}).format(new Date());
if (data.latestRun?.status !== "completed" || data.latestRun.date !== today) {
  throw new Error(`No completed experiment for ${today}; snapshot was not created`);
}
const target = new URL(`../snapshots/${today}.json`, import.meta.url);
const hasFullEvidence = data.schemaVersion === 3 && Array.isArray(data.latestRun.candidates) &&
  Array.isArray(data.latestRun.baseline?.outputs) && Array.isArray(data.latestRun.holdoutBaseline?.outputs) &&
  Array.isArray(data.latestRun.validationSamples) && data.latestRun.strategyTrial &&
  data.latestRun.candidates.every(item => Array.isArray(item.holdout?.outputs));
if (!hasFullEvidence) {
  let archived;
  try {
    archived = JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (data.schemaVersion === 3 && archived?.schemaVersion === 2 &&
      archived.latestRun?.id === data.latestRun.id && archived.latestRun?.date === today &&
      archived.latestRun?.status === "completed") {
    console.log(`Legacy experiment for ${today} is already archived; waiting for the next scheduled v3 run`);
  } else {
    throw new Error("Experiment response is missing evaluation evidence");
  }
} else {
  await mkdir(new URL("../snapshots/", import.meta.url), { recursive: true });
  await writeFile(target, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`Saved evidence for ${today}: ${data.latestRun.reason}`);
}
