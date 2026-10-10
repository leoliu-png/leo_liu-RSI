import { MODEL_PROFILE } from "./model.js";
import { DATASET_VERSION } from "./corpus.js";
import { EVALUATOR_VERSION } from "./evaluator.js";

export const CHECKPOINT_PREFIX = `rsi:v4:${MODEL_PROFILE}:checkpoint:`;
export const DAILY_CALL_LIMIT = 64;

export function runError(message, code, retryable = false, extra = {}) {
  return Object.assign(new Error(message), { code, retryable, ...extra });
}

export async function openJournal(kv, date, state) {
  const key = `${CHECKPOINT_PREFIX}${date}`;
  let checkpoint = await kv.get(key, "json");
  if (checkpoint && (checkpoint.evaluatorVersion !== EVALUATOR_VERSION || checkpoint.datasetVersion !== DATASET_VERSION)) {
    throw runError("Checkpoint evaluator/dataset changed; refusing to mix evidence", "checkpoint_mismatch");
  }
  if (!checkpoint) {
    checkpoint = { id: crypto.randomUUID(), date, startedAt: new Date().toISOString(),
      modelProfile: MODEL_PROFILE, evaluatorVersion: EVALUATOR_VERSION, datasetVersion: DATASET_VERSION,
      baseState: { ...state, latestRun: null }, tasks: {}, attempts: [], usage: null, stage: "calibration" };
  }
  let writes = Promise.resolve();
  const save = () => {
    checkpoint.updatedAt = new Date().toISOString();
    const snapshot = JSON.stringify(checkpoint);
    const write = writes.then(() => kv.put(key, snapshot));
    writes = write.catch(() => {});
    return write;
  };
  const rejectResponse = async (name, error) => {
    const cached = checkpoint.tasks[name];
    if (cached?.status !== "completed") return;
    const rejectedAt = new Date().toISOString();
    checkpoint.rejectedResponses ||= [];
    checkpoint.rejectedResponses.push({ step: name, response: structuredClone(cached.value),
      rejectedAt, error: String(error.message), code: "judge_structure" });
    checkpoint.tasks[name] = { ...cached, status: "rejected", rejectedAt,
      error: String(error.message), code: "judge_structure" };
    await save();
  };
  const journal = { checkpoint, save, async task(name, work) {
    const cached = checkpoint.tasks[name];
    if (cached?.status === "completed") return structuredClone(cached.value);
    checkpoint.tasks[name] = { ...cached, status: "running", startedAt: new Date().toISOString() };
    await save();
    try {
      const value = await work();
      checkpoint.tasks[name] = { status: "completed", completedAt: new Date().toISOString(), value };
      await save();
      return structuredClone(value);
    } catch (error) {
      checkpoint.tasks[name] = { ...checkpoint.tasks[name], status: "failed", error: String(error.message),
        code: error.code || "execution_error", retryable: error.retryable !== false };
      await save();
      throw error;
    }
  }, ai(name, ai, options = {}) {
    let index = 0, lastResponse;
    return {
      async run(model, input) {
        const key = lastResponse = `${name}:response:${++index}`;
        const cached = checkpoint.tasks[key];
        // HTTP success is not proof of a usable judgment. Validate legacy cached
        // responses before replaying them, without discarding the original evidence.
        if (cached?.status === "completed" && options.validateCached) {
          try { await options.validateCached(structuredClone(cached.value)); }
          catch (error) { await rejectResponse(key, error); }
        }
        return journal.task(key, () => ai.run(model, input));
      },
      reject: error => rejectResponse(lastResponse, error)
    };
  }, async stage(name) { checkpoint.stage = name; await save(); } };
  return journal;
}
