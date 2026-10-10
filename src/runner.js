import { experimentDate, getState, publicState, runEvolution } from "./evolution.js";
import { createModelClient, redactError } from "./openrouter.js";
import { MODEL_NAME, MODEL_PROFILE } from "./model.js";

export const RETRY_DELAYS = [5, 15, 60, 180].map(minutes => minutes * 60000);
export const MAX_FAILURES = 5;
export const MAX_EXECUTIONS = 16;
const JOB_KEY = "daily-job";
const terminal = new Set(["completed", "completed_with_audit_warning", "blocked", "exhausted", "missed"]);

// SQLite is authoritative. KV is a backwards-compatible mirror, not a distributed lock.
export function durableRecords(storage, backup) {
  storage.sql.exec("CREATE TABLE IF NOT EXISTS rsi_records (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER)");
  const write = (key, value, options = {}) => {
    const expires = options.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null;
    const insert = (recordKey, content) => storage.sql.exec("INSERT INTO rsi_records (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at", recordKey, content, expires);
    if (value.length > 200000) {
      const count = Math.ceil(value.length / 200000);
      for (let index = 0; index < count; index++) insert(`${key}:chunk:${index}`, value.slice(index * 200000, (index + 1) * 200000));
      insert(key, `RSI_CHUNKS:${count}`);
    } else insert(key, value);
  };
  const mirror = async (key, value, options = {}) => {
    if (!key.includes(":checkpoint:")) {
      try { await backup.put(key, value, options); }
      catch { console.warn(JSON.stringify({ message: "kv_mirror_pending", key })); }
    }
  };
  return {
    async get(key, type = "json") {
      const row = storage.sql.exec("SELECT value, expires_at FROM rsi_records WHERE key = ?", key).toArray()[0];
      if (row) {
        if (row.expires_at && row.expires_at < Date.now()) return null;
        let value = row.value;
        if (value.startsWith("RSI_CHUNKS:")) {
          const count = Number(value.slice(11));
          value = Array.from({ length: count }, (_, index) => {
            const chunk = storage.sql.exec("SELECT value FROM rsi_records WHERE key = ?", `${key}:chunk:${index}`).toArray()[0];
            if (!chunk) throw new Error("Durable record is missing a checkpoint chunk");
            return chunk.value;
          }).join("");
        }
        return type === "json" ? JSON.parse(value) : value;
      }
      return backup.get(key, type);
    },
    async put(key, value, options = {}) {
      storage.transactionSync(() => write(key, value, options));
      await mirror(key, value, options);
    },
    async commit(entries) {
      storage.transactionSync(() => { for (const [key, value] of entries) write(key, value); });
      for (const [key, value] of entries) await mirror(key, value);
    }
  };
}

export class EvolutionRunner {
  constructor(ctx, env, options = {}) {
    this.ctx = ctx;
    this.env = env;
    this.now = options.now || Date.now;
    this.execute = options.execute || runEvolution;
    this.records = options.records || durableRecords(ctx.storage, env.EVOLUTION);
    this.runEnv = { ...env, EVOLUTION: this.records };
    this.busy = false;
  }

  async saveJob(job, alarmAt = null) {
    job.updatedAt = new Date(this.now()).toISOString();
    await this.ctx.storage.transaction(async transaction => {
      await transaction.put(JOB_KEY, job);
      if (alarmAt !== null) await transaction.setAlarm(alarmAt);
    });
    await this.records.put(`rsi:v4:${MODEL_PROFILE}:automation:${job.date}`, JSON.stringify(job));
  }

  async schedule(timestamp = this.now()) {
    return this.ctx.blockConcurrencyWhile(async () => {
      const date = experimentDate(timestamp);
      if (date !== experimentDate(this.now())) return { queued: false, reason: "expired_schedule" };
      const existing = await this.ctx.storage.get(JOB_KEY);
      if (existing?.date === date) {
        if (terminal.has(existing.status) || this.busy) return { queued: false, job: existing };
        const alarm = await this.ctx.storage.getAlarm();
        if (alarm !== null) return { queued: true, job: existing };
        // A watchdog restores a missing alarm without resetting retry or billing counters.
        await this.saveJob(existing, Math.max(this.now() + 1000, Date.parse(existing.nextRetryAt) || 0));
        return { queued: true, job: existing };
      }
      if (this.busy) return { queued: false, reason: "previous_job_running", job: existing };
      const job = { date, timestamp, status: "queued", executions: 0, failures: 0,
        deadlineAt: `${date}T23:50:00+08:00`,
        maxFailures: MAX_FAILURES, maxExecutions: MAX_EXECUTIONS, nextRetryAt: null,
        startedAt: new Date(this.now()).toISOString() };
      await this.saveJob(job, this.now() + 1000);
      return { queued: true, job };
    });
  }

  async alarm() {
    if (this.busy) return;
    this.busy = true;
    try {
      const job = await this.ctx.storage.get(JOB_KEY);
      if (!job || terminal.has(job.status)) return;
      if (job.date !== experimentDate(this.now()) || this.now() >= Date.parse(job.deadlineAt)) {
        await this.saveJob({ ...job, status: "missed", nextRetryAt: null, error: "Daily deadline expired; evidence retained" });
        await this.ctx.storage.deleteAlarm();
        return;
      }
      if (job.executions >= MAX_EXECUTIONS || job.failures >= MAX_FAILURES) {
        await this.saveJob({ ...job, status: "exhausted", nextRetryAt: null });
        return;
      }
      if (job.nextRetryAt && Date.parse(job.nextRetryAt) > this.now()) {
        await this.ctx.storage.setAlarm(Date.parse(job.nextRetryAt));
        return;
      }
      job.executions++;
      job.status = "running";
      job.nextRetryAt = null;
      // Persist a recovery alarm before inference, so process termination does not lose the job.
      await this.saveJob(job, this.now() + 12 * 60000);
      let problem;
      try {
        const result = await this.execute(this.runEnv, job.timestamp);
        const audit = result.state.latestRun?.audit;
        if (!audit || audit.status === "completed" || !audit.status) {
          job.status = "completed";
        } else if (audit.retryable === false) {
          job.status = "completed_with_audit_warning";
          job.error = audit.error;
        } else {
          problem = { code: audit.code, retryable: true, message: audit.error || "Audit pending", retryAfterMs: audit.retryAfterMs || 0 };
        }
      } catch (error) { problem = error; }
      if (!problem) {
        job.nextRetryAt = null;
        job.completedAt = new Date(this.now()).toISOString();
        await this.saveJob(job);
        await this.ctx.storage.deleteAlarm();
        return;
      }
      job.error = redactError(problem.message, this.env.MODEL_API_KEY);
      job.code = problem.code || "execution_error";
      const paused = problem.code === "execution_slice";
      if (!paused) job.failures++;
      if (problem.retryable === false || job.failures >= MAX_FAILURES || job.executions >= MAX_EXECUTIONS) {
        job.status = problem.retryable === false ? "blocked" : "exhausted";
        job.nextRetryAt = null;
        await this.saveJob(job);
        await this.ctx.storage.deleteAlarm();
        return;
      }
      const delay = paused ? 30000 : Math.max(RETRY_DELAYS[job.failures - 1] || RETRY_DELAYS.at(-1), problem.retryAfterMs || 0);
      const retryAt = this.now() + delay;
      if (experimentDate(retryAt) !== job.date || retryAt >= Date.parse(job.deadlineAt)) {
        await this.saveJob({ ...job, status: "exhausted", nextRetryAt: null });
        await this.ctx.storage.deleteAlarm();
        return;
      }
      job.status = paused ? "paused" : "waiting_retry";
      job.nextRetryAt = new Date(retryAt).toISOString();
      await this.saveJob(job, retryAt);
    } finally { this.busy = false; }
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/schedule" && request.method === "POST") {
      const { timestamp } = await request.json();
      return Response.json(await this.schedule(timestamp));
    }
    if (path === "/state") {
      return Response.json({ ...publicState(await getState(this.runEnv)),
        automation: await this.ctx.storage.get(JOB_KEY) || null });
    }
    if (path === "/probe" && request.method === "POST") {
      if (this.busy) return Response.json({ error: "Daily experiment is running" }, { status: 409 });
      try {
        const client = createModelClient(this.env, { maxAttempts: 1, timeoutMs: 90000 });
        const result = await client.run(MODEL_NAME, { messages: [{ role: "user", content: "Reply only OK." }], max_tokens: 256, temperature: 0 });
        return Response.json({ ok: true, model: result.model || MODEL_NAME, text: result.choices[0].message.content, usage: client.stats });
      } catch (error) {
        return Response.json({ ok: false, code: error.code, error: redactError(error.message, this.env.MODEL_API_KEY) }, { status: 502 });
      }
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }
}
