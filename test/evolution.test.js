import test from "node:test";
import assert from "node:assert/strict";
import { benchmark } from "../src/benchmark.js";
import { experimentDate, initialState, rescoreMetrics, runEvolution, scoreSummary } from "../src/evolution.js";

function fakeEnvironment({ improve = true, fail = false } = {}) {
  const values = new Map();
  let calls = 0;
  const candidates = [
    { hypothesis: "先列出事实", prompt: "候选 A。结论：先写结论。要点：列出事实。风险：说明限制。术语：解释术语。仅依据原文，保留实体和数字；输出前复核关键词，禁止臆造原文以外的信息，全文控制在 450 字以内。" },
    { hypothesis: "先压缩篇幅", prompt: "候选 B。结论：先写结论。要点：列出事实。风险：说明限制。术语：解释术语。仅依据原文，保留实体和数字；先压缩连接词，再输出完整的四段摘要，全文控制在 450 字以内。" }
  ];
  const env = {
    EVOLUTION: {
      async get(key) { return values.has(key) ? JSON.parse(values.get(key)) : null; },
      async put(key, value) { values.set(key, value); }
    },
    AI: {
      async run(_model, input) {
        calls++;
        if (fail) throw new Error("model unavailable");
        if (input.temperature === 0.7) return { response: JSON.stringify({ candidates }) };
        const article = input.messages[1].content;
        const sample = benchmark.find(item => article.includes(item.article));
        assert.ok(sample);
        const prompt = input.messages[0].content;
        const base = sample.article;
        if (prompt.includes("候选 A") && improve) {
          return { response: `结论：本段介绍${sample.title}。\n要点：${base}\n风险：仅按原文所述。\n术语：关键名称沿用原文。` };
        }
        if (prompt.includes("候选 B") && improve) {
          return { response: `结论：本段介绍${sample.title}。\n要点：${base} 同步复制。\n风险：仅按原文所述。\n术语：关键名称沿用原文。` };
        }
        return { response: base };
      }
    }
  };
  return { env, values, calls: () => calls };
}

test("score uses disclosed anchors and format", () => {
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

test("real inference results select winner, preserve evidence, and do not rerun same day", async () => {
  const mock = fakeEnvironment();
  const first = await runEvolution(mock.env, Date.parse("2026-09-24T01:00:00Z"));
  assert.equal(first.skipped, false);
  assert.equal(first.state.generation, 1);
  assert.equal(first.state.latestRun.selectedId, "C1");
  assert.equal(first.state.latestRun.baseline.outputs.length, 3);
  assert.equal(first.state.latestRun.candidates[0].metrics.outputs.length, 3);
  assert.equal(first.state.latestRun.candidates[1].eligible, false);
  assert.ok(mock.values.has("rsi:v2:run:2026-09-24"));
  const callsAfterFirst = mock.calls();
  const second = await runEvolution(mock.env, Date.parse("2026-09-24T02:00:00Z"));
  assert.equal(second.skipped, true);
  assert.equal(mock.calls(), callsAfterFirst);
});

test("model error keeps champion unchanged and records failure", async () => {
  const mock = fakeEnvironment({ fail: true });
  await assert.rejects(runEvolution(mock.env, Date.parse("2026-09-24T01:00:00Z")), /model unavailable/);
  const state = await mock.env.EVOLUTION.get("rsi:v2:state");
  assert.equal(state.generation, initialState().generation);
  assert.equal(state.latestRun.status, "failed");
  assert.equal(state.history.length, 0);
});
