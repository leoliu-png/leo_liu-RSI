import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { initialState, publicState } from "../src/evolution.js";
import { developmentCorpus, validationForDate, auditCorpus } from "../src/corpus.js";
import { scoreJudgment } from "../src/evaluator.js";
import { judgmentFor } from "../test-support/judgment.js";
import { MODEL_PROFILE, MODEL_NAME } from "../src/model.js";

function output(sample) {
  return { sampleId: sample.id, title: sample.title, summary: sample.reference, sources: sample.sources,
    ...scoreJudgment(sample.reference, sample, judgmentFor(sample, sample.reference)) };
}
function metrics(samples) {
  const outputs = samples.map(output);
  return { score: 90, coverage: 1, format: 1, characters: 160, dimensions: outputs[0].dimensions, errors: [], outputs };
}
function render(state) {
  class Element {
    constructor() { this.children = []; this.classList = { add() {} }; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute() {}
  }
  const elements = new Map();
  const document = { querySelector(selector) {
    if (!elements.has(selector)) elements.set(selector, new Element());
    return elements.get(selector);
  }, createElement() { return new Element(); }, createElementNS() { return new Element(); } };
  const script = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8").split("<script>")[1].split("</script>")[0];
  const context = vm.createContext({ document, fetch: () => new Promise(() => {}), suppliedState: state });
  new vm.Script(script + "\nrender(suppliedState);").runInContext(context);
  return elements;
}
test("dashboard renders initial and failed states without inventing results", () => {
  const state = publicState(initialState());
  assert.equal(render(state).get("#score").textContent, "—");
  state.latestRun = { status: "failed", error: "Calibration failure" };
  assert.match(render(state).get("#notice").textContent, /Calibration failure/);
});
test("dashboard renders V4 dimensions, calibration and evidence; excludes V3 from chart", () => {
  const date = "2026-10-06", dev = developmentCorpus.slice(0, 3), validation = validationForDate(date);
  const baseline = metrics(dev), holdoutBaseline = metrics(validation);
  const state = publicState({ ...initialState(), champion: { ...initialState().champion, score: 90 },
    history: [{ date: "2026-10-05", scorerVersion: 3, score: 97, generation: 1 },
      { date, scorerVersion: 4, score: 99, generation: 1, modelProfile: "legacy-workers-ai" },
      { date, scorerVersion: 4, score: 90, generation: 1, modelProfile: MODEL_PROFILE }],
    latestRun: { schemaVersion: 4, status: "completed", date, reason: "保留冠军", accepted: false, baseline, holdoutBaseline,
      developmentSamples: dev, validationSamples: validation, candidates: [],
      audit: { championVersion: "v0", samples: auditCorpus, metrics: metrics(auditCorpus) },
      calibration: { passed: true, results: [{ id: "correct-test", sample: dev[0], summary: dev[0].reference,
        expected: "pass", passed: true, metrics: output(dev[0]) }] } } });
  const elements = render(state);
  assert.equal(elements.get("#dimension-table").children.length, 2);
  assert.equal(elements.get("#calibration-table").children.length, 1);
  assert.equal(elements.get("#audit-outputs").children.length, 3);
  assert.match(elements.get("#chart-note").textContent, /1 次真实实验/);
  assert.ok(elements.get("#evaluator-info").textContent.includes(MODEL_NAME));
});

test("dashboard distinguishes pending audit and scheduled recovery from successful full audit", () => {
  const state = publicState(initialState());
  state.latestRun = { status: "completed", coreStatus: "completed", schemaVersion: 4, candidates: [],
    audit: { status: "failed", metrics: null, error: "upstream 503", championVersion: "v0" } };
  state.automation = { status: "waiting_retry", nextRetryAt: "2026-10-10T02:00:00Z" };
  const elements = render(state);
  assert.match(elements.get("#audit-score").textContent, /审计中断/);
  assert.match(elements.get("#notice").textContent, /主实验已完成/);
  assert.match(elements.get("#notice").textContent, /下次自动续跑/);
  state.latestRun = { status: "paused", progress: { completedTasks: 7, stage: "baseline-validation" } };
  assert.match(render(state).get("#notice").textContent, /已保存步骤 7/);
});
