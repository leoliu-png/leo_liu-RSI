import test from "node:test";
import assert from "node:assert/strict";
import { statusReport, statusSummary } from "../scripts/snapshot-status.mjs";

const now = Date.parse("2026-10-22T06:49:00Z");
const failed = () => ({ modelProfile: "litellm-minimax-m3", latestRun: { id: "today", date: "2026-10-22",
  status: "failed", code: "output_truncated", progress: { stage: "evaluate-C2-development" } },
  automation: { date: "2026-10-22", status: "exhausted", code: "output_truncated", error: "cut off" } });

test("the same failed run is reported once but every report remains explicitly failed", () => {
  const data = failed(), first = statusReport(data, now), next = statusReport(data, now + 3600000, first);
  assert.equal(first.notify, true);
  assert.equal(next.notify, false);
  assert.equal(next.duplicateAlert, true);
  assert.equal(next.experimentStatus, "failed");
  assert.equal(next.finalFailure, true);
  assert.equal(next.freshMeasurement, false);
  assert.equal(next.notifiedFailures.length, 1);
  assert.match(statusSummary(next, data), /实验失败（未恢复）/);
  assert.match(statusSummary(next, data), /不将实验标为成功/);
});

test("changed failure codes, stages, and new days are not silently suppressed", () => {
  const data = failed(), first = statusReport(data, now);
  data.automation.code = "http_524";
  assert.equal(statusReport(data, now, first).notify, true);
  data.latestRun.progress.stage = "audit";
  assert.equal(statusReport(data, now, first).notify, true);
  data.latestRun.date = data.automation.date = "2026-10-23";
  assert.equal(statusReport(data, now + 86400000, first).notify, true);
});

test("legacy failure snapshots migrate their already-sent alert without another email", () => {
  const data = failed(), previous = { ...structuredClone(data), archive: { date: "2026-10-22", finalFailure: true,
    checkedAt: "2026-10-22T06:49:00Z" } };
  const report = statusReport(data, now, previous);
  assert.equal(report.duplicateAlert, true);
  assert.equal(report.notify, false);
  assert.equal(report.notifiedFailures[0].migratedLegacyAlert, true);
});

test("a green pre-start check cannot claim that yesterday's experiment completed today", () => {
  const data = failed();
  data.latestRun.date = data.automation.date = "2026-10-21";
  const report = statusReport(data, Date.parse("2026-10-21T19:40:00Z"));
  assert.equal(report.date, "2026-10-22");
  assert.equal(report.experimentStatus, "not_started");
  assert.equal(report.freshMeasurement, false);
  assert.equal(report.notify, false);
  assert.match(statusSummary(report, data), /今日尚未开始/);
});

test("missing daily startup alerts after grace while an active long-running task is not a missing run", () => {
  const stale = failed(); stale.latestRun.date = stale.automation.date = "2026-10-21";
  assert.equal(statusReport(stale, now).experimentStatus, "missing");
  assert.equal(statusReport(stale, now).notify, true);
  stale.automation = { date: "2026-10-22", status: "running" };
  assert.equal(statusReport(stale, now).experimentStatus, "pending");
});

test("independent audit must complete before the health report claims a full fresh result", () => {
  const data = failed(); data.latestRun.status = "completed";
  data.latestRun.audit = { status: "pending" }; data.automation.status = "running";
  assert.equal(statusReport(data, now).experimentStatus, "audit_pending");
  assert.equal(statusReport(data, now).freshMeasurement, false);
  data.latestRun.audit.status = "completed"; data.automation.status = "completed";
  assert.equal(statusReport(data, now).experimentStatus, "completed");
  assert.equal(statusReport(data, now).freshMeasurement, true);
});
