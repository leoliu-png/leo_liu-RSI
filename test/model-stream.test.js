import test from "node:test";
import assert from "node:assert/strict";
import { createModelClient } from "../src/openrouter.js";
import { readModelStream, visibleModelText } from "../src/model-stream.js";
import { extractText } from "../src/evolution.js";
import { MODEL_NAME } from "../src/model.js";

const env = { MODEL_API_KEY: "test-stream-secret" };
const input = { messages: [{ role: "user", content: "测试" }], temperature: 0, max_tokens: 4096 };
function stream(events, split = false) {
  const raw = events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\r\n\r\n`).join("");
  const bytes = new TextEncoder().encode(raw);
  return new Response(new ReadableStream({ start(controller) {
    if (split) for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    else controller.enqueue(bytes);
    controller.close();
  } }), { headers: { "content-type": "text/event-stream" } });
}
const completed = () => stream([
  { model: MODEL_NAME, choices: [{ delta: { reasoning_content: "核对原文" } }] },
  { model: MODEL_NAME, choices: [{ delta: { content: "完整中文摘要" } }] },
  { model: MODEL_NAME, choices: [{ delta: {}, finish_reason: "stop" }] },
  { choices: [], usage: { prompt_tokens: 10, completion_tokens: 12, completion_tokens_details: { reasoning_tokens: 6 }, cost: 0.01 } }, "[DONE]"
], true);
const options = fetch => ({ fetch, sleep: async () => {}, intervalMs: 0 });

test("native thinking wrappers are separated from visible summaries without modifying ordinary text", () => {
  assert.equal(visibleModelText('<think>internal reasoning</think>\n\n结论：可核查摘要。'), "结论：可核查摘要。");
  assert.equal(extractText({ choices: [{ message: { content: '<think>internal reasoning</think>\n要点：正文。' } }] }), "要点：正文。");
  assert.equal(visibleModelText('结论：原文讨论 <think> 标签。'), '结论：原文讨论 <think> 标签。');
  assert.throws(() => visibleModelText('<think>unfinished'), error => error.code === "incomplete_stream");
});

test("SSE assembly handles fragmented UTF-8, CRLF, separated thinking, finish and usage-only frames", async () => {
  const result = await readModelStream(completed());
  assert.equal(result.choices[0].message.content, "完整中文摘要");
  assert.equal(result.choices[0].message.reasoning_content, "核对原文");
  assert.equal(result.choices[0].finish_reason, "stop");
  assert.equal(result.usage.completion_tokens, 12);
});

test("stream requests and usage are accounted once without provider-specific thinking changes", async () => {
  const client = createModelClient(env, options(async (_url, init) => {
    const body = JSON.parse(init.body);
    assert.equal(body.stream, true);
    assert.equal(body.stream_options.include_usage, true);
    assert.equal(Object.hasOwn(body, "thinking"), false);
    return completed();
  }));
  await client.run(MODEL_NAME, input);
  assert.equal(client.stats.attempts, 1);
  assert.equal(client.stats.streamResponses, 1);
  assert.equal(client.stats.inputTokens, 10);
  assert.equal(client.stats.outputTokens, 12);
  assert.equal(client.stats.reasoningTokens, 6);
  assert.equal(client.stats.reportedCostCalls, 1);
});

test("a stream with partial text but no finish marker is never accepted as a complete response", async () => {
  const client = createModelClient(env, options(async () => stream([
    { model: MODEL_NAME, choices: [{ delta: { content: '{"validLooking":"but incomplete"}' } }] }, "[DONE]"
  ])));
  await assert.rejects(client.run(MODEL_NAME, input), error => error.code === "incomplete_stream");
  assert.equal(client.stats.attempts, 2);
});

test("quota errors within SSE do not trigger retries or leak the secret", async () => {
  const client = createModelClient(env, options(async () => stream([{ error: { code: 429, message: `quota exhausted ${env.MODEL_API_KEY}` } }])));
  await assert.rejects(client.run(MODEL_NAME, input), error => error.code === "quota_exhausted" && !error.retryable && !error.message.includes(env.MODEL_API_KEY));
  assert.equal(client.stats.attempts, 1);
});

test("network retry does not consume truncation expansion, and the expanded limit survives recovery", async () => {
  const policies = {}, limits = []; let call = 0;
  const client = createModelClient(env, { ...options(async (_url, init) => {
    limits.push(JSON.parse(init.body).max_tokens);
    if (++call === 1) return new Response("timeout", { status: 524 });
    if (call === 2) return stream([{ model: MODEL_NAME, choices: [{ delta: { content: "" }, finish_reason: "length" }] }, "[DONE]"]);
    return completed();
  }), policies });
  await client.run(MODEL_NAME, input);
  assert.deepEqual(limits, [4096, 4096, 8192]);
  assert.equal(client.stats.networkRetries, 1);
  assert.equal(client.stats.outputRetries, 1);
  const resumed = createModelClient(env, { ...options(async (_url, init) => {
    assert.equal(JSON.parse(init.body).max_tokens, 8192); return completed();
  }), policies, initialStats: client.stats });
  await resumed.run(MODEL_NAME, input);
  assert.equal(resumed.stats.attempts, 4);
});

test("saved expansion survives an execution-slice pause without spending another HTTP attempt", async () => {
  const policies = {}; let before = 0;
  const client = createModelClient(env, { ...options(async () => stream([
    { model: MODEL_NAME, choices: [{ delta: {}, finish_reason: "length" }] }, "[DONE]"
  ])), policies, beforeAttempt() { if (++before === 2) throw Object.assign(new Error("slice"), { code: "execution_slice", retryable: true }); } });
  await assert.rejects(client.run(MODEL_NAME, input), error => error.code === "execution_slice");
  assert.equal(client.stats.attempts, 1);
  assert.equal(Object.values(policies)[0].maxTokens, 8192);
});
