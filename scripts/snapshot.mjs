import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hasSnapshotEvidence } from "./snapshot-evidence.mjs";

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
if (data.modelProfile && !/^[a-z0-9-]+$/.test(data.modelProfile)) throw new Error("Invalid snapshot model profile");
if (data.latestRun?.status !== "completed" || data.latestRun.date !== today) {
  await mkdir(new URL("../snapshots/", import.meta.url), { recursive: true });
  const statusTarget = new URL(`../snapshots/${today}-v4-${data.modelProfile || "unknown"}-status.json`, import.meta.url);
  const currentRun = data.latestRun?.date === today ? data.latestRun : null;
  const job = data.automation?.date === today ? data.automation : null;
  const finalFailure = ["blocked", "exhausted", "missed"].includes(job?.status) ||
    (currentRun?.status === "failed" && currentRun.retryable === false) ||
    (!currentRun && Date.now() >= Date.parse(`${today}T23:50:00+08:00`));
  const status = { ...data, archive: { date: today, kind: "operational-status-not-successful-experiment",
    checkedAt: new Date().toISOString(), finalFailure } };
  await writeFile(statusTarget, `${JSON.stringify(status, null, 2)}\n`);
  console.log(`Saved operational evidence for ${today}; state=${job?.status || currentRun?.status || "not_started"}`);
  if (finalFailure) { console.error(`::error::RSI daily task stopped: ${job?.error || currentRun?.error || "No daily execution"}`); process.exitCode = 1; }
} else {
const target = new URL(`../snapshots/${today}${data.schemaVersion === 4 ? "-v4" : ""}${data.modelProfile ? `-${data.modelProfile}` : ""}.json`, import.meta.url);
if (!hasSnapshotEvidence(data)) {
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
  if (["pending", "failed"].includes(data.latestRun.audit?.status)) {
    console.warn(`::warning::Core experiment completed; independent audit is ${data.latestRun.audit.status}: ${data.latestRun.audit.error || "pending"}`);
  }
}
}
