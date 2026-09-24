import test from "node:test";
import assert from "node:assert/strict";
import { benchmark } from "../src/benchmark.js";
import { holdoutForDate } from "../src/holdout.js";
import {
  STATE_KEY, challengerBeatsIncumbent, experimentDate, getState, initialState,
  promotionDecision, rescoreMetrics, runEvolution, scoreSummary, updateStrategyTrial
} from "../src/evolution.js";

const promptA = "候选 A。结论：先写结论。要点：列出事实。风险：说明限制。术语：解释术语。仅依据原文，保留实体和数字；输出前核对所有具体条件，禁止臆造原文以外的信息，全文控制在 450 字以内。";
const promptB = "候选 B。结论：先写结论。要点：列出事实。风险：说明限制。术语：解释术语。仅依据原文，保留实体和数字；先压缩连接词，再输出完整的四段摘要，禁止编造，全文控制在 450 字以内。";

function fakeEnvironment({ fail = false, holdoutFail = false } = {}) {
  const values = new Map();
  let calls = 0;
  const samples = [...benchmark, ...holdoutForDate("2026-09-24"), ...holdoutForDate("2026-09-25")];
  const env = {
    EVOLUTION: {
      async get(key) { return values.has(key) ? JSON.parse(values.get(key)) : null; },
      async put(key, value) { values.set(key, value); }
    },
    AI: {
      async run(_model, input) {
        calls++;
        if (fail) throw new Error("model unavailable");
        if (input.temperature === 0.65 || input.temperature === 0.7) {
          const proposalInput = JSON.stringify(input.messages);
          assert.ok(samples.filter(item => item.id.includes("2026-")).every(item => !proposalInput.includes(item.article)),
            "the proposal model must not see holdout articles");
        }
        if (input.temperature === 0.65) return { response: JSON.stringify({
          hypothesis: "先核对关键条件比先压缩长度更稳健",
          instruction: "先从最近开发集失分中识别遗漏的实体、数字和限制，再提出只针对一类遗漏的改写；保留原文忠实性和四段结构，并在生成前检查是否复制了旧候选。"
        }) };
        if (input.temperature === 0.7) {
          const challenger = input.messages[0].content.includes("先从最近开发集失分");
          return { response: JSON.stringify({ hypothesis: challenger ? "先处理事实" : "先检查结构", prompt: challenger ? promptB : promptA }) };
        }
        const article = input.messages[1].content;
        const sample = samples.find(item => article.includes(item.article));
        assert.ok(sample, "inference must use a known test article");
        const prompt = input.messages[0].content;
        if (prompt.includes("候选 A")) {
          const wrong = holdoutFail && sample.id.includes("2026-") ? ` ${sample.forbidden[0]}` : "";
          return { response: `结论：概述${sample.title}。\n要点：${sample.article}${wrong}\n风险：仅按原文所述。\n术语：关键名称沿用原文。` };
        }
        return { response: sample.article };
      }
    }
  };
  return { env, values, calls: () => calls };
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
  assert.equal(first.state.challenger.trials.length, 1);
  assert.ok(mock.values.has("rsi:v3:run:2026-09-24"));
  const callsAfterFirst = mock.calls();
  const second = await runEvolution(mock.env, Date.parse("2026-09-24T02:00:00Z"));
  assert.equal(second.skipped, true);
  assert.equal(mock.calls(), callsAfterFirst);
});

test("holdout regression rolls back a development-set improvement", async () => {
  const mock = fakeEnvironment({ holdoutFail: true });
  const result = await runEvolution(mock.env, Date.parse("2026-09-24T01:00:00Z"));
  assert.equal(result.state.generation, 0);
  assert.equal(result.state.champion.version, "v0");
  assert.equal(result.state.latestRun.accepted, false);
  assert.match(result.state.latestRun.candidates[0].reason, /新验证文章/);
  assert.ok(result.state.latestRun.candidates[0].metrics.score > result.state.latestRun.baseline.score);
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
  assert.equal(state.schemaVersion, 3);
  assert.equal(state.champion.version, "v2");
  assert.equal(state.history.length, 1);
  assert.equal(mock.values.has("rsi:v2:state"), true);
});
