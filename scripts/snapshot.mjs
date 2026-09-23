import { mkdir, writeFile } from "node:fs/promises";

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
if (!Array.isArray(data.latestRun.candidates) || !data.latestRun.baseline?.outputs) {
  throw new Error("Experiment response is missing evaluation evidence");
}
await mkdir(new URL("../snapshots/", import.meta.url), { recursive: true });
const target = new URL(`../snapshots/${today}.json`, import.meta.url);
await writeFile(target, `${JSON.stringify(data, null, 2)}\n`);
console.log(`Saved evidence for ${today}: ${data.latestRun.reason}`);
