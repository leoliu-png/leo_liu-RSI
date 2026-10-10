import test from "node:test";
import assert from "node:assert/strict";
import { openJournal } from "../src/journal.js";
import { createEvaluationContext, judgeSummary } from "../src/evaluator.js";
import { developmentCorpus } from "../src/corpus.js";
import { judgmentFor } from "../test-support/judgment.js";

const sample = developmentCorpus[0], summary = sample.reference;
const name = `judge:${sample.id}\n${summary}`;
const malformed = '{"type":"object"}\n{"units":[]}';

async function harness(calls = 0, limit = 64) {
  const values = new Map();
  const kv = {
    async get(key) { return values.has(key) ? JSON.parse(values.get(key)) : null; },
    async put(key, value) { values.set(key, value); }
  };
  const journal = await openJournal(kv, "2026-10-10", {});
  journal.checkpoint.usage = { calls, byModel: { judge: calls } };
  let physicalCalls = 0, invalid = false;
  const inputs = [];
  const context = () => {
    const result = createEvaluationContext({ async run(_model, input) {
      physicalCalls++;
      inputs.push(input);
      return invalid ? { response: malformed } : { response: judgmentFor(sample, summary) };
    } }, "judge", limit, { initialUsage: journal.checkpoint.usage,
      async onUsage(usage) { journal.checkpoint.usage = usage; await journal.save(); } });
    result.journal = journal;
    return result;
  };
  return { journal, context, inputs, physicalCalls: () => physicalCalls, invalid: value => { invalid = value; } };
}

test("legacy malformed HTTP-success caches are rejected before replay and only the failed judge is called", async () => {
  const mock = await harness(7), cp = mock.journal.checkpoint;
  cp.tasks[`${name}:response:1`] = { status: "completed", value: { response: malformed } };
  cp.tasks["calibration:already-passed"] = { status: "completed", value: { passed: true } };
  cp.tasks["summary:baseline:dev:already-saved"] = { status: "completed", value: summary };
  const savedTasks = structuredClone(cp.tasks);
  const result = await judgeSummary(mock.context(), sample, summary);
  assert.ok(result.eligible);
  assert.equal(mock.physicalCalls(), 1);
  assert.equal(cp.usage.calls, 8, "recovery does not reset the seven earlier calls");
  assert.equal(cp.rejectedResponses.length, 1);
  assert.equal(cp.rejectedResponses[0].response.response, malformed);
  assert.deepEqual(cp.tasks["calibration:already-passed"], savedTasks["calibration:already-passed"]);
  assert.deepEqual(cp.tasks["summary:baseline:dev:already-saved"], savedTasks["summary:baseline:dev:already-saved"]);
  await judgeSummary(mock.context(), sample, summary);
  assert.equal(mock.physicalCalls(), 1, "a structurally valid judgment is still reusable");
});

test("fresh invalid judge responses retain evidence but cannot trap the next recovery in a replay loop", async () => {
  const mock = await harness();
  mock.invalid(true);
  await assert.rejects(judgeSummary(mock.context(), sample, summary), error => error.code === "judge_structure");
  assert.equal(mock.physicalCalls(), 2, "one judgment has only two bounded attempts");
  assert.equal(mock.journal.checkpoint.tasks[`${name}:response:1`].status, "rejected");
  assert.equal(mock.journal.checkpoint.tasks[`${name}:response:2`].status, "rejected");
  assert.equal(mock.journal.checkpoint.rejectedResponses.length, 2);
  assert.equal(mock.inputs[1].messages[2].content, malformed, "repair sees the actual invalid response, not a schema or an invented result");
  assert.match(mock.inputs[1].messages[3].content, /结构校验失败/);
  mock.invalid(false);
  await judgeSummary(mock.context(), sample, summary);
  assert.equal(mock.physicalCalls(), 3);
  assert.equal(mock.journal.checkpoint.usage.calls, 3);
  assert.equal(mock.journal.checkpoint.rejectedResponses.length, 2);
});

test("cached JSON with invented source IDs is rejected without relaxing the evidence rules", async () => {
  const mock = await harness(), bad = judgmentFor(sample, summary);
  bad.units[0].sourceIds = ["S99999"];
  mock.journal.checkpoint.tasks[`${name}:response:1`] = { status: "completed", value: { response: bad } };
  await judgeSummary(mock.context(), sample, summary);
  assert.equal(mock.physicalCalls(), 1);
  assert.deepEqual(mock.journal.checkpoint.rejectedResponses[0].response.response.units[0].sourceIds, ["S99999"]);
});

test("invalid-cache recovery cannot exceed or reset the cumulative daily call budget", async () => {
  const mock = await harness(64);
  mock.journal.checkpoint.tasks[`${name}:response:1`] = { status: "completed", value: { response: malformed } };
  await assert.rejects(judgeSummary(mock.context(), sample, summary), error => error.code === "daily_budget");
  assert.equal(mock.physicalCalls(), 0);
  assert.equal(mock.journal.checkpoint.usage.calls, 64);
  assert.equal(mock.journal.checkpoint.rejectedResponses[0].response.response, malformed);
});
