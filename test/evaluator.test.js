import test from "node:test";
import assert from "node:assert/strict";
import { developmentCorpus, validationCorpus, auditCorpus, calibrationCases, validationForDate } from "../src/corpus.js";
import { createEvaluationContext, materializeQuotes, scoreJudgment, summaryUnits, validateJudgment } from "../src/evaluator.js";
import { judgmentFor } from "../test-support/judgment.js";

test("every fact and constraint has a literal source and sets remain disjoint", () => {
  const all = [...developmentCorpus, ...validationCorpus, ...auditCorpus];
  assert.equal(new Set(all.map(item => item.id)).size, 18);
  for (const item of all) {
    assert.ok(item.facts.every(fact => fact.evidenceIds.length && fact.weight > 0));
    assert.ok(item.constraints.every(condition => condition.evidenceIds.length &&
      condition.evidenceIds.every(id => item.sources.find(source => source.id === id).text.includes(condition.text))), item.id);
  }
  assert.deepEqual(validationForDate("2026-10-06").map(item => item.article),
    validationForDate("2026-10-09").map(item => item.article), "fixed corpus rotation is not fresh collection");
});

test("keyword-packed false summary is vetoed rather than rewarded", () => {
  const item = calibrationCases.find(row => row.id === "wrong-cache-97");
  const result = scoreJudgment(item.summary, item.sample, judgmentFor(item.sample, item.summary, true));
  assert.equal(result.eligible, false);
  assert.equal(result.hardFailure, true);
  assert.ok(result.score <= 49);
  assert.ok(result.errors[0].evidence.length);
});

test("missing IDs, invented sources and nonliteral quotes fail closed", () => {
  const sample = developmentCorpus[0], summary = sample.reference;
  for (const corrupt of [
    value => value.units.pop(),
    value => { value.units[0].sourceIds = ["nonexistent"]; },
    value => { value.facts[0].quote = "评委自己改写而非逐字摘录"; },
    value => { value.constraints[0].quote = ""; }
  ]) {
    const value = judgmentFor(sample, summary); corrupt(value);
    assert.throws(() => validateJudgment(value, sample, summary));
  }
});

test("shortening has no score bonus and unsupported assertions veto promotion", () => {
  const sample = developmentCorpus[0], summary = sample.reference;
  const base = scoreJudgment(summary, sample, judgmentFor(sample, summary));
  const longer = summary + "\n" + sample.sources[0].text;
  assert.equal(scoreJudgment(longer, sample, judgmentFor(sample, longer)).score, base.score);
  const value = judgmentFor(sample, summary);
  value.units[0].verdict = "unsupported"; value.units[0].sourceIds = [];
  assert.equal(scoreJudgment(summary, sample, value).eligible, false);
});

test("all model calls share a hard budget and usage is recorded", async () => {
  const context = createEvaluationContext({ async run() { return { usage: { prompt_tokens: 7, completion_tokens: 3 } }; } }, "judge", 1);
  await context.ai.run("generator", {});
  await assert.rejects(context.ai.run("judge", {}), /budget exhausted/);
  assert.equal(context.usage.calls, 1);
  assert.equal(context.usage.inputTokens, 7);
  assert.equal(context.usage.outputTokens, 3);
});

test("summary evidence IDs resolve to literal text and invented IDs are rejected", () => {
  const sample = developmentCorpus[0], summary = sample.reference;
  const value = judgmentFor(sample, summary);
  value.facts[0].quote = "不要让模型自己编引文";
  assert.ok(summary.includes(materializeQuotes(value, summary).facts[0].quote));
  value.constraints[0].unitIds = ["T99999"];
  assert.throws(() => materializeQuotes(value, summary), /invalid summary evidence IDs/);
});

test("Markdown headings alone are not evaluated as factual assertions", () => {
  const units = summaryUnits("**结论：** 准确结论。\n**要点：**\n第一条事实。\n**风险**：\n风险事实。\n### 术语：\n术语事实。");
  assert.deepEqual(units.map(item => item.text), ["准确结论", "第一条事实", "风险事实", "术语事实"]);
});
