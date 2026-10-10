import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { EvolutionRunner, MAX_FAILURES, MAX_MANUAL_RECOVERIES, RETRY_DELAYS, durableRecords } from "../src/runner.js";
import { MODEL_PROFILE } from "../src/model.js";
import { CHECKPOINT_PREFIX } from "../src/journal.js";
import { STATE_KEY, initialState } from "../src/evolution.js";

function harness(execute) {
  let now = Date.parse("2026-10-10T01:00:00Z"), alarm = null;
  const values = new Map(), records = new Map();
  const storage = {
    async get(key) { return structuredClone(values.get(key)); },
    async put(key, value) { values.set(key, structuredClone(value)); },
    async setAlarm(time) { alarm = time; },
    async getAlarm() { return alarm; },
    async deleteAlarm() { alarm = null; },
    async transaction(work) { return work(storage); }
  };
  let gate = Promise.resolve();
  const ctx = { storage, blockConcurrencyWhile(work) {
    const result = gate.then(work); gate = result.catch(() => {}); return result;
  } };
  const runner = new EvolutionRunner(ctx, {}, { execute, now: () => now, records: {
    async get(key) { return records.has(key) ? JSON.parse(records.get(key)) : null; },
    async put(key, value) { records.set(key, value); }
  } });
  return { runner, storage, values, records, now: () => now, advance: time => { now = time; }, alarm: () => alarm };
}

test("daily schedules are idempotent and successful alarms do not run inference twice", async () => {
  let calls = 0;
  const mock = harness(async () => { calls++; return { state: { latestRun: { audit: { status: "completed" } } } }; });
  await Promise.all([mock.runner.schedule(), mock.runner.schedule(), mock.runner.schedule()]);
  await mock.runner.alarm();
  await mock.runner.alarm();
  assert.equal(calls, 1);
  assert.equal((await mock.storage.get("daily-job")).status, "completed");
  assert.equal(mock.alarm(), null);
  assert.equal((await mock.runner.schedule()).queued, false);
});

test("transient errors back off and stop at the daily failure limit without resetting counters", async () => {
  let calls = 0;
  const mock = harness(async () => { calls++; throw Object.assign(new Error("upstream 503"), { code: "http_503", retryable: true }); });
  await mock.runner.schedule();
  for (let i = 0; i < MAX_FAILURES; i++) {
    const start = mock.now();
    await mock.runner.alarm();
    const job = await mock.storage.get("daily-job");
    assert.equal(job.failures, i + 1);
    if (i < MAX_FAILURES - 1) {
      assert.equal(mock.alarm() - start, RETRY_DELAYS[i]);
      await mock.runner.schedule();
      assert.equal((await mock.storage.get("daily-job")).failures, i + 1);
      mock.advance(mock.alarm());
    }
  }
  assert.equal(calls, MAX_FAILURES);
  assert.equal((await mock.storage.get("daily-job")).status, "exhausted");
  assert.equal(mock.alarm(), null);
  await mock.runner.schedule();
  await mock.runner.alarm();
  assert.equal(calls, MAX_FAILURES);
  mock.advance(Date.parse("2026-10-11T01:00:00Z"));
  await mock.runner.schedule();
  assert.equal((await mock.storage.get("daily-job")).failures, 0);
});

test("auth and calibration failures are blocked immediately, not retried indefinitely", async () => {
  const mock = harness(async () => { throw Object.assign(new Error("invalid credential"), { code: "http_401", retryable: false }); });
  await mock.runner.schedule();
  await mock.runner.alarm();
  const job = await mock.storage.get("daily-job");
  assert.equal(job.status, "blocked");
  assert.equal(job.executions, 1);
  assert.equal(mock.alarm(), null);
});

test("an active alarm has a persisted recovery timer and cannot be started in parallel", async () => {
  let release, calls = 0;
  const mock = harness(async () => {
    calls++;
    await new Promise(resolve => { release = resolve; });
    return { state: { latestRun: { audit: { status: "completed" } } } };
  });
  await mock.runner.schedule();
  const active = mock.runner.alarm();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal(mock.alarm(), mock.now() + 12 * 60000);
  await mock.runner.alarm();
  assert.equal((await mock.runner.schedule()).queued, false);
  assert.equal(calls, 1);
  release(); await active;
});

test("watchdogs restore a missing alarm but do not restart terminal jobs", async () => {
  const mock = harness(async () => {});
  await mock.runner.schedule();
  await mock.storage.deleteAlarm();
  const previous = await mock.storage.get("daily-job");
  previous.executions = 2; previous.failures = 1; previous.status = "waiting_retry";
  await mock.storage.put("daily-job", previous);
  await mock.runner.schedule();
  assert.ok(mock.alarm());
  assert.equal((await mock.storage.get("daily-job")).executions, 2);
});

test("execution slices resume without counting a provider failure and expired days do not promote", async () => {
  let calls = 0;
  const mock = harness(async () => { calls++; throw Object.assign(new Error("slice"), { code: "execution_slice", retryable: true }); });
  await mock.runner.schedule();
  await mock.runner.alarm();
  assert.equal((await mock.storage.get("daily-job")).status, "paused");
  assert.equal((await mock.storage.get("daily-job")).failures, 0);
  assert.equal(mock.alarm() - mock.now(), 30000);
  mock.advance(Date.parse("2026-10-11T00:00:00+08:00"));
  await mock.runner.alarm();
  assert.equal((await mock.storage.get("daily-job")).status, "missed");
  assert.equal(calls, 1);
});

test("irreparable report-only audit is labelled a warning, not a failed core experiment", async () => {
  const mock = harness(async () => ({ state: { latestRun: {
    audit: { status: "failed", retryable: false, error: "invalid evidence" }
  } } }));
  await mock.runner.schedule();
  await mock.runner.alarm();
  assert.equal((await mock.storage.get("daily-job")).status, "completed_with_audit_warning");
  assert.equal(mock.alarm(), null);
});

test("SQLite authority survives a KV mirror failure and supports large checkpoints", async () => {
  const db = new DatabaseSync(":memory:");
  const storage = { transactionSync(work) {
    db.exec("BEGIN");
    try { const result = work(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }, sql: { exec(sql, ...bindings) {
    const stmt = db.prepare(sql);
    if (/^SELECT/i.test(sql)) return { toArray: () => stmt.all(...bindings) };
    stmt.run(...bindings);
    return { toArray: () => [] };
  } } };
  let writes = 0;
  const records = durableRecords(storage, { async get() { return null; }, async put() { writes++; throw new Error("KV unavailable"); } });
  const stateKey = `rsi:v4:${MODEL_PROFILE}:state`;
  await records.put(stateKey, JSON.stringify({ generation: 3 }));
  assert.deepEqual(await records.get(stateKey), { generation: 3 });
  const checkpointKey = `rsi:v4:${MODEL_PROFILE}:checkpoint:2026-10-10`;
  const value = { proof: "证".repeat(800000) };
  await records.put(checkpointKey, JSON.stringify(value));
  assert.deepEqual(await records.get(checkpointKey), value);
  assert.equal(writes, 1, "frequent checkpoint writes are not limited by KV per-key rate limits");
  db.close();
});

test("operator recovery resumes a blocked day without resetting budgets or rerunning completed jobs", async () => {
  let fixed = false, calls = 0;
  const mock = harness(async () => {
    calls++;
    if (!fixed) throw Object.assign(new Error("quota exhausted"), { retryable: false, code: "quota_exhausted" });
    return { state: { latestRun: { audit: { status: "completed" } } } };
  });
  await mock.runner.schedule();
  await mock.runner.alarm();
  assert.equal((await mock.storage.get("daily-job")).failures, 1);
  assert.equal((await mock.runner.schedule()).queued, false);
  fixed = true;
  assert.equal((await mock.runner.schedule(mock.now(), true)).resumed, true);
  assert.equal((await mock.storage.get("daily-job")).failures, 1);
  assert.equal((await mock.storage.get("daily-job")).executions, 1);
  await mock.runner.alarm();
  assert.equal(calls, 2);
  assert.equal((await mock.storage.get("daily-job")).status, "completed");
  assert.equal((await mock.runner.schedule(mock.now(), true)).queued, false);
});

test("post-fix operator recovery preserves total failures, execution and billing counters while rearming bounded retries", async () => {
  let fixed = false;
  const mock = harness(async () => {
    if (!fixed) throw Object.assign(new Error("temporary failure"), { code: "http_503", retryable: true });
    return { state: { latestRun: { audit: { status: "completed" } } } };
  });
  await mock.runner.schedule();
  for (let index = 0; index < MAX_FAILURES; index++) {
    await mock.runner.alarm();
    if (mock.alarm()) mock.advance(mock.alarm());
  }
  const stopped = await mock.storage.get("daily-job");
  assert.equal(stopped.status, "exhausted");
  const key = `${CHECKPOINT_PREFIX}${stopped.date}`;
  mock.records.set(key, JSON.stringify({ usage: { calls: 14, transport: { attempts: 15 } } }));
  fixed = true;
  const resumed = await mock.runner.schedule(mock.now(), true);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.job.failures, MAX_FAILURES);
  assert.equal(resumed.job.executions, MAX_FAILURES);
  assert.equal(resumed.job.retryFailures, 0);
  assert.equal(resumed.job.manualRecoveries, 1);
  assert.equal(resumed.job.error, null);
  assert.deepEqual(JSON.parse(mock.records.get(key)).usage, { calls: 14, transport: { attempts: 15 } });
  await mock.runner.alarm();
  assert.equal((await mock.storage.get("daily-job")).status, "completed");
  assert.equal((await mock.storage.get("daily-job")).error, null);
});

test("manual recovery cannot bypass daily billing limits, the deadline, or its own finite attempt count", async () => {
  for (const usage of [{ calls: 64 }, { calls: 12, transport: { attempts: 64 } }]) {
    const mock = harness(async () => { throw Object.assign(new Error("quota"), { code: "quota_exhausted", retryable: false }); });
    await mock.runner.schedule(); await mock.runner.alarm();
    mock.records.set(`${CHECKPOINT_PREFIX}2026-10-10`, JSON.stringify({ usage }));
    assert.equal((await mock.runner.schedule(mock.now(), true)).reason, "daily_budget_exhausted");
    assert.equal((await mock.storage.get("daily-job")).executions, 1);
  }
  const mock = harness(async () => { throw Object.assign(new Error("auth"), { retryable: false }); });
  await mock.runner.schedule(); await mock.runner.alarm();
  for (let index = 0; index < MAX_MANUAL_RECOVERIES; index++) {
    assert.equal((await mock.runner.schedule(mock.now(), true)).resumed, true);
    await mock.runner.alarm();
  }
  assert.equal((await mock.runner.schedule(mock.now(), true)).queued, false);
  const job = await mock.storage.get("daily-job");
  job.manualRecoveries = 0;
  await mock.storage.put("daily-job", job);
  mock.advance(Date.parse(job.deadlineAt) + 1);
  assert.equal((await mock.runner.schedule(mock.now(), true)).queued, false);
});

test("live status reads authoritative checkpoint progress without advertising an incomplete run as completed", async () => {
  const mock = harness(async () => {});
  await mock.runner.schedule();
  const job = await mock.storage.get("daily-job");
  job.status = "running";
  await mock.storage.put("daily-job", job);
  const state = initialState();
  state.latestRun = { id: "test-run", date: job.date, status: "running", usage: { calls: 7 } };
  mock.records.set(STATE_KEY, JSON.stringify(state));
  mock.records.set(`${CHECKPOINT_PREFIX}${job.date}`, JSON.stringify({ id: "test-run", stage: "baseline-development",
    tasks: { one: { status: "completed" }, two: { status: "running" } }, usage: { calls: 14, transport: { attempts: 15 } } }));
  const response = await mock.runner.fetch(new Request("https://runner/state"));
  const result = await response.json();
  assert.equal(result.latestRun.status, "running");
  assert.equal(result.latestRun.usage.calls, 14);
  assert.equal(result.latestRun.progress.completedTasks, 1);
  assert.equal(result.latestRun.progress.stage, "baseline-development");
  assert.equal(result.latestRun.usage.transport.attempts, 15);
});
