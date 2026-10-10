import test from "node:test";
import assert from "node:assert/strict";
import { benchmark } from "../src/benchmark.js";
import { holdoutForDate } from "../src/holdout.js";
import { developmentCorpus, validationCorpus, auditCorpus, calibrationCases, validationForDate } from "../src/corpus.js";
import { judgmentFor } from "../test-support/judgment.js";
import { hasSnapshotEvidence } from "../scripts/snapshot-evidence.mjs";
import {
  STATE_KEY, RUN_PREFIX, challengerBeatsIncumbent, experimentDate, getState, initialState, publicState,
  promotionDecision, rescoreMetrics, runEvolution as runRealEvolution, scoreSummary, updateStrategyTrial
} from "../src/evolution.js";
const runEvolution = (env, timestamp) => runRealEvolution(env, timestamp, env.AI);

const promptA = "候选 A。结论：先写结论。要点：列出事实。风险：说明限制。术语：解释术语。仅依据原文，保留实体和数字；输出前逐项核对每个数字的计量对象、适用范围、前提条件和原文证据，找不到直接依据就删除该断言，禁止臆造原文以外的信息，全文控制在 450 字以内。";
const promptB = "候选 B。结论：先写结论。要点：列出事实。风险：说明限制。术语：解释术语。仅依据原文，保留实体和数字；风险段区分已观察到的问题和未证实的可能性，术语段只解释文中实际定义的概念，并删除四段间重复事实，禁止编造，全文控制在 450 字以内。";

function fakeEnvironment({ fail = false, holdoutFail = false, calibrationFail = false, proposalPrompt } = {}) {
  const values = new Map();
  let calls = 0;
  let proposalCalls = 0;
  const samples = [...developmentCorpus, ...validationCorpus, ...auditCorpus,
    ...[24, 25, 26, 27].flatMap(day => validationForDate(`2026-09-${day}`))];
  const env = {
    EVOLUTION: {
      async get(key) { return values.has(key) ? JSON.parse(values.get(key)) : null; },
      async put(key, value) { values.set(key, value); }
    },
    AI: {
      async run(_model, input) {
        calls++;
        if (fail) throw new Error("model unavailable");
        if (input.messages[0].content.startsWith("rsi-evaluator-v4")) {
          const payload = JSON.parse(input.messages[1].content);
          const wrong = !calibrationFail && calibrationCases.some(item => item.expected === "reject" && item.summary === payload.summary) ||
            payload.summary.includes("无条件错误断言");
          return { response: judgmentFor({ sources: payload.source, facts: payload.importantFacts, constraints: payload.constraints },
            payload.summary, wrong) };
        }
        if (input.temperature === 0.65 || input.temperature === 0.7) {
          const proposalInput = JSON.stringify(input.messages);
          assert.ok(samples.filter(item => item.id.includes("2026-")).every(item => !proposalInput.includes(item.article)),
            "the proposal model must not see holdout articles");
          assert.ok([...validationCorpus, ...auditCorpus].every(item => !proposalInput.includes(item.article)),
            "validation and audit contents must not enter candidate generation");
        }
        if (input.temperature === 0.65) return { response: JSON.stringify({
          hypothesis: "先核对关键条件比先压缩长度更稳健",
          instruction: "先从最近开发集失分中识别遗漏的实体、数字和限制，再提出只针对一类遗漏的改写；保留原文忠实性和四段结构，并在生成前检查是否复制了旧候选。"
        }) };
        if (input.temperature === 0.7) {
          proposalCalls++;
          const proposed = proposalPrompt?.(proposalCalls, input);
          if (proposed) return { response: JSON.stringify({ hypothesis: "尝试新的提示词改写", prompt: proposed }) };
          const challenger = input.messages[0].content.includes("先从最近开发集失分");
          return { response: JSON.stringify({ hypothesis: challenger ? "先处理事实" : "先检查结构", prompt: challenger ? promptB : promptA }) };
        }
        const article = input.messages[1].content;
        const sample = samples.find(item => article.includes(item.article));
        assert.ok(sample, "inference must use a known test article");
        const prompt = input.messages[0].content;
        if (prompt.includes("候选 A")) {
          const wrong = holdoutFail && validationCorpus.some(item => item.article === sample.article) ? " 无条件错误断言。" : "";
          return { response: `结论：概述${sample.title}。\n要点：${sample.article}${wrong}\n风险：仅按原文所述。\n术语：关键名称沿用原文。` };
        }
        return { response: sample.article };
      }
    }
  };
  return { env, values, calls: () => calls, proposalCalls: () => proposalCalls };
}

test("development scorer recognizes facts and Markdown headings", () => {
  assert.equal(experimentDate(Date.parse("2026-09-23T18:00:00Z")), "2026-09-24");
  const sample = benchmark[0];
  const weak = scoreSummary(sample.article, sample);
  const strong = scoreSummary(`结论：概述。\n要点：${sample.article}\n风险：原文有限制。\n术语：PostgreSQL 是数据库。`, sample);
  assert.ok(strong.score > weak.score);
  assert.equal(strong.coverage, 1);
  assert.equal(strong.format, 1);
  const markdown = scoreSummary(`**结论**：概述。\n**要点**：${sample.article}\n**风险**：原文有限制。\n**术语**：PostgreSQL 是数据库。`, sample);
  assert.equal(markdown.format, 1);
  assert.equal(rescoreMetrics({ outputs: benchmark.map(item => ({ sampleId: item.id, summary: item.article })) }).outputs.length, 3);
});

test("holdout passages change by day and are separate from the development set", () => {
  const first = holdoutForDate("2026-09-24");
  const second = holdoutForDate("2026-09-25");
  assert.equal(first.length, 2);
  assert.notDeepEqual(first.map(item => item.article), second.map(item => item.article));
  assert.ok(first.every(item => !benchmark.some(dev => dev.id === item.id)));
  for (let day = 1; day <= 28; day++) {
    const date = `2026-10-${String(day).padStart(2, "0")}`;
    assert.ok(holdoutForDate(date).every(item => scoreSummary(item.article, item).forbidden.length === 0));
  }
});

test("paired strategies produce candidates; development and unseen passages gate promotion", async () => {
  const mock = fakeEnvironment();
  const first = await runEvolution(mock.env, Date.parse("2026-09-24T01:00:00Z"));
  assert.equal(first.skipped, false);
  assert.equal(first.state.generation, 1);
  assert.equal(first.state.latestRun.selectedId, "C1");
  assert.equal(first.state.latestRun.baseline.outputs.length, 3);
  assert.equal(first.state.latestRun.holdoutBaseline.outputs.length, 2);
  assert.equal(first.state.latestRun.candidates[0].holdout.outputs.length, 2);
  assert.equal(first.state.latestRun.strategyTrial.challengerWon, false);
  assert.equal(first.state.latestRun.candidates[0].focus, first.state.latestRun.candidates[1].focus);
  assert.equal(hasSnapshotEvidence(first.state), true);
  assert.equal(first.state.challenger.trials.length, 1);
  assert.ok(mock.values.has(`${RUN_PREFIX}2026-09-24`));
  const callsAfterFirst = mock.calls();
  const second = await runEvolution(mock.env, Date.parse("2026-09-24T02:00:00Z"));
  assert.equal(second.skipped, true);
  assert.equal(mock.calls(), callsAfterFirst);
});

test("calibration failure stops proposals and never promotes a champion", async () => {
  const mock = fakeEnvironment({ calibrationFail: true });
  await assert.rejects(runEvolution(mock.env, Date.parse("2026-09-24T01:00:00Z")), /calibration rejected/);
  assert.equal(mock.proposalCalls(), 0);
  const state = await mock.env.EVOLUTION.get(STATE_KEY);
  assert.equal(state.champion.version, "v0");
  assert.equal(state.latestRun.calibration.passed, false);
});

test("V4 snapshots require calibration and semantic evidence", async () => {
  const mock = fakeEnvironment();
  const { state } = await runEvolution(mock.env, Date.parse("2026-09-24T01:00:00Z"));
  assert.equal(hasSnapshotEvidence(state), true);
  assert.equal(hasSnapshotEvidence({ ...state, latestRun: { ...state.latestRun, calibration: null } }), false);
  const publicData = publicState(state);
  assert.equal(hasSnapshotEvidence(publicData), true);
  publicData.latestRun.calibration.model = "a-different-judge";
  assert.equal(hasSnapshotEvidence(publicData), false);
  const altered = structuredClone(state);
  delete altered.latestRun.baseline.outputs[0].judgment;
  assert.equal(hasSnapshotEvidence(altered), false);
});

test("holdout regression rolls back a development-set improvement", async () => {
  const mock = fakeEnvironment({ holdoutFail: true });
  const result = await runEvolution(mock.env, Date.parse("2026-09-24T01:00:00Z"));
  assert.equal(result.state.generation, 0);
  assert.equal(result.state.champion.version, "v0");
  assert.equal(result.state.latestRun.accepted, false);
  assert.match(result.state.latestRun.candidates[0].reason, /隔离验证文章/);
  assert.ok(result.state.latestRun.candidates[0].metrics.score > result.state.latestRun.baseline.score);
});

test("duplicate proposals are retried and never evaluated as distinct candidates", async () => {
  const champion = initialState().champion.prompt;
  const mock = fakeEnvironment({ proposalPrompt: call => [champion.replace("结论：", "结论 ："), promptA, promptA, promptB][call - 1] });
  const result = await runEvolution(mock.env, Date.parse("2026-09-24T01:00:00Z"));
  assert.equal(result.state.latestRun.status, "completed");
  assert.equal(result.state.latestRun.outcome, "evaluated");
  assert.deepEqual(result.state.latestRun.candidates.map(item => item.prompt), [promptA, promptB]);
  assert.deepEqual(result.state.latestRun.candidateGeneration.results.map(item => item.attempts), [2, 2]);
  assert.equal(result.state.latestRun.candidateGeneration.results[0].rejected.length, 1);
  assert.equal(result.state.latestRun.candidateGeneration.results[1].rejected.length, 1);
  assert.equal(mock.proposalCalls(), 4);
});

test("exhausted duplicate retries use distinct actionable fallback rules without fake strategy wins", async () => {
  const champion = initialState().champion.prompt;
  const mock = fakeEnvironment({ proposalPrompt: () => champion });
  const result = await runEvolution(mock.env, Date.parse("2026-09-24T01:00:00Z"));
  const run = result.state.latestRun;
  assert.equal(run.status, "completed");
  assert.equal(run.outcome, "fallback_candidates");
  assert.equal(run.accepted, false);
  assert.equal(run.candidates.length, 2);
  assert.ok(run.candidates.every(item => item.source === "guardrail_fallback"));
  assert.notEqual(run.candidates[0].prompt, run.candidates[1].prompt);
  assert.ok(run.candidates.every(item => item.prompt !== champion && item.prompt.includes("补充核验规则")));
  assert.equal(run.strategyTrial, null);
  assert.equal(run.baseline.outputs.length, 3);
  assert.equal(run.holdoutBaseline.outputs.length, 2);
  assert.equal(result.state.champion.version, "v0");
  assert.equal(result.state.challenger, null);
  assert.deepEqual(run.candidateGeneration.results.map(item => item.rejected.length), [3, 3]);
  assert.deepEqual(run.candidateGeneration.results.map(item => item.fallbackUsed), [true, true]);
  assert.equal(hasSnapshotEvidence(result.state), true);
  assert.equal(hasSnapshotEvidence({ ...result.state, latestRun: { ...run, candidateGeneration: null } }), false);
  assert.equal(mock.proposalCalls(), 6);
  assert.equal(result.state.feedbackHistory.at(-1).rejectedCandidates[0].rejected, 3);
  const again = await runEvolution(mock.env, Date.parse("2026-09-24T02:00:00Z"));
  assert.equal(again.skipped, true);
  assert.equal(mock.proposalCalls(), 6);
});

test("a single model candidate is paired with fallback without fabricating a strategy trial", async () => {
  const mock = fakeEnvironment({ proposalPrompt: () => promptA });
  const result = await runEvolution(mock.env, Date.parse("2026-09-24T01:00:00Z"));
  const run = result.state.latestRun;
  assert.equal(run.status, "completed");
  assert.equal(run.outcome, "fallback_candidates");
  assert.equal(run.candidates.length, 2);
  assert.equal(run.candidates[0].id, "C1");
  assert.equal(run.candidates[0].source, "model");
  assert.equal(run.candidates[1].source, "guardrail_fallback");
  assert.equal(run.strategyTrial, null);
  assert.equal(result.state.strategyHistory.length, 0);
  assert.equal(run.candidateGeneration.results[1].rejected.length, 3);
  assert.equal(result.state.challenger, null);
  assert.equal(hasSnapshotEvidence(result.state), true);
});

test("previously evaluated prompts are excluded from a later experiment", async () => {
  const mock = fakeEnvironment({ proposalPrompt: call => call === 1 ? promptA : promptB });
  mock.values.set(STATE_KEY, JSON.stringify({ ...initialState(), recentCandidatePrompts: [promptA] }));
  const result = await runEvolution(mock.env, Date.parse("2026-09-24T01:00:00Z"));
  assert.equal(result.state.latestRun.candidateGeneration.results[0].rejected.length, 1);
  assert.ok(result.state.latestRun.candidates.every(item => item.prompt !== promptA));
  assert.equal(result.state.latestRun.outcome, "fallback_candidates");
});

test("stylistic rewording alone is rejected and replaced by an actionable candidate", async () => {
  const champion = initialState().champion.prompt;
  const nearSynonym = champion.replace("禁止补充原文以外的信息", "不得添加原文未提及的内容");
  const mock = fakeEnvironment({ proposalPrompt: () => nearSynonym });
  const result = await runEvolution(mock.env, Date.parse("2026-09-24T01:00:00Z"));
  assert.equal(result.state.latestRun.outcome, "fallback_candidates");
  assert.ok(result.state.latestRun.candidates.every(item => item.prompt !== nearSynonym));
  assert.equal(result.state.latestRun.candidateGeneration.results[0].rejected[0].reason,
    "与冠军相比改动过小，缺少可检验的新行为规则");
});

test("an archived candidate is not reused even after it leaves the recent prompt window", async () => {
  const mock = fakeEnvironment({ proposalPrompt: call => call === 1 ? promptA : promptB });
  const state = initialState();
  state.seenCandidateKeys = [promptA.normalize("NFKC").replace(/\s+/g, "").toLowerCase()];
  mock.values.set(STATE_KEY, JSON.stringify(state));
  const result = await runEvolution(mock.env, Date.parse("2026-09-24T01:00:00Z"));
  assert.equal(result.state.latestRun.candidateGeneration.results[0].rejected[0].reason, "与冠军、历史候选或当日已接受候选重复");
  assert.ok(result.state.latestRun.candidates.every(item => item.prompt !== promptA));
});

test("fallback rules remain distinct across multiple days of repeated model output", async () => {
  const champion = initialState().champion.prompt;
  const mock = fakeEnvironment({ proposalPrompt: () => champion });
  const prompts = new Set();
  for (const day of [24, 25, 26, 27]) {
    const result = await runEvolution(mock.env, Date.parse(`2026-09-${day}T01:00:00Z`));
    assert.equal(result.state.latestRun.outcome, "fallback_candidates");
    for (const candidate of result.state.latestRun.candidates) {
      assert.equal(prompts.has(candidate.prompt), false);
      prompts.add(candidate.prompt);
    }
    assert.equal(result.state.strategyHistory.length, 0);
  }
  assert.equal(prompts.size, 8);
});

test("challenger strategy requires two paired wins and then replaces the incumbent", () => {
  const current = { metrics: { score: 80, coverage: 0.8, forbidden: [] }, holdout: { score: 82, coverage: 0.8, forbidden: [] } };
  const better = { metrics: { score: 84, coverage: 0.8, forbidden: [] }, holdout: { score: 85, coverage: 0.8, forbidden: [] } };
  assert.equal(challengerBeatsIncumbent(current, better), true);
  const state = { ...initialState(), challenger: { id: "trial-1", instruction: "better", hypothesis: "better", trials: [] } };
  const day1 = updateStrategyTrial(state, "2026-09-24", current, better);
  assert.equal(day1.strategy.version, "s0");
  const day2 = updateStrategyTrial({ ...state, challenger: day1.challenger }, "2026-09-25", current, better);
  assert.equal(day2.strategy.version, "s1");
  assert.equal(day2.challenger, null);
  const failed = updateStrategyTrial({ ...state, challenger: { ...state.challenger, trials: [
    { challengerWon: false }, { challengerWon: false }
  ] } }, "2026-09-26", better, current);
  assert.equal(failed.strategy.version, "s0");
  assert.equal(failed.challenger, null);
});

test("promotion checks both sets and failure preserves the champion", async () => {
  const baseline = { score: 80, coverage: 0.8 };
  const holdout = { score: 82, coverage: 0.8 };
  assert.equal(promotionDecision({ metrics: { score: 85, coverage: 0.8, forbidden: [] }, holdout: { score: 80, coverage: 0.8, forbidden: [] } }, baseline, holdout).eligible, false);
  const mock = fakeEnvironment({ fail: true });
  await assert.rejects(runEvolution(mock.env, Date.parse("2026-09-24T01:00:00Z")), /model unavailable/);
  const state = await mock.env.EVOLUTION.get(STATE_KEY);
  assert.equal(state.generation, initialState().generation);
  assert.equal(state.latestRun.status, "failed");
  assert.equal(state.strategy.version, "s0");
});

test("legacy v2 champion and history migrate without deleting old KV data", async () => {
  const mock = fakeEnvironment();
  const legacy = { schemaVersion: 2, generation: 2, champion: { version: "v2", prompt: "legacy", score: 91 },
    latestRun: null, history: [{ date: "2026-09-23", generation: 2, score: 91 }], updatedAt: "2026-09-23T00:00:00Z" };
  mock.values.set("rsi:v2:state", JSON.stringify(legacy));
  const state = await getState(mock.env);
  assert.equal(state.schemaVersion, 4);
  assert.equal(state.champion.score, null);
  assert.equal(state.legacyBaseline.score, 91);
  assert.equal(state.champion.version, "v2");
  assert.equal(state.history.length, 1);
  assert.equal(mock.values.has("rsi:v2:state"), true);
});

test("model switch keeps old V4 evidence but resets scores, trials, audit and same-day deduplication", async () => {
  const mock = fakeEnvironment();
  const date = "2026-09-24";
  const legacy = { ...initialState(), modelProfile: undefined, generation: 1,
    champion: { version: "v1", prompt: "legacy champion", score: 99 },
    latestRun: { status: "completed", date, id: "old-run", model: "old-generator" },
    challenger: { trials: [{ challengerWon: true }] }, lastAudit: { championVersion: "v1", scorerVersion: 4 },
    feedbackHistory: [{ from: "old-judge" }], history: [{ date, scorerVersion: 4, score: 99, generation: 1 }] };
  mock.values.set("rsi:v4:state", JSON.stringify(legacy));
  const state = await getState(mock.env);
  assert.equal(state.champion.version, "v1");
  assert.equal(state.champion.score, null);
  assert.equal(state.latestRun, null);
  assert.equal(state.challenger, null);
  assert.equal(state.lastAudit, null);
  assert.deepEqual(state.feedbackHistory, []);
  assert.equal(state.history[0].modelProfile, "legacy-workers-ai");
  assert.equal(state.legacyBaseline.score, 99);
  await runEvolution(mock.env, Date.parse(`${date}T01:00:00Z`));
  assert.equal(mock.values.has(`${RUN_PREFIX}${date}`), true);
  assert.deepEqual(JSON.parse(mock.values.get("rsi:v4:state")), JSON.parse(JSON.stringify(legacy)));
});

test("Minimax migration prefers the Laguna champion and preserves its original experiment records", async () => {
  const mock = fakeEnvironment();
  const profile = "openrouter-laguna-s21", key = `rsi:v4:${profile}:state`;
  const old = { ...initialState(), modelProfile: profile, generation: 2,
    champion: { version: "v2", prompt: "most recent champion", score: 88 },
    latestRun: { id: "laguna-run", status: "completed", date: "2026-10-10", model: "old-model" },
    feedbackHistory: [{ score: 88 }], recentCandidatePrompts: ["old candidate"], seenCandidateKeys: ["oldcandidate"],
    history: [{ date: "2026-10-10", scorerVersion: 4, modelProfile: profile, score: 88 }] };
  mock.values.set(key, JSON.stringify(old));
  mock.values.set("rsi:v4:state", JSON.stringify({ ...old, generation: 1, champion: { version: "v1", prompt: "older", score: 49 } }));
  const state = await getState(mock.env);
  assert.equal(state.champion.version, "v2");
  assert.equal(state.champion.score, null);
  assert.equal(state.latestRun, null);
  assert.equal(state.legacyBaseline.modelProfile, profile);
  assert.deepEqual(state.feedbackHistory, []);
  assert.deepEqual(state.seenCandidateKeys, ["oldcandidate"]);
  assert.equal(mock.values.get(key), JSON.stringify(old));
});
