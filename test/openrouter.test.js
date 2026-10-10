import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_NAME, MODEL_BASE_URL, MAX_MODEL_OUTPUT_TOKENS } from "../src/model.js";
import { createModelClient } from "../src/openrouter.js";
import { createEvaluationContext, judgeSummary } from "../src/evaluator.js";
import { developmentCorpus } from "../src/corpus.js";

const env = { MODEL_API_KEY: "test-private-token", MODEL_NAME, JUDGE_MODEL: MODEL_NAME, MODEL_BASE_URL };
const input = { messages: [{ role: "user", content: "test" }], temperature: 0, max_tokens: 300, seed: 42 };
const good = () => Response.json({ model: MODEL_NAME, choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 } });
const options = fetch => ({ fetch, intervalMs: 0, sleep: async () => {} });

test("LiteLLM sends the requested model and server-side credential without provider-specific parameters", async () => {
  const client = createModelClient(env, options(async (url, init) => {
    assert.equal(url, `${MODEL_BASE_URL}/chat/completions`);
    assert.equal(init.headers.Authorization, `Bearer ${env.MODEL_API_KEY}`);
    const body = JSON.parse(init.body);
    assert.equal(body.model, MODEL_NAME);
    assert.equal(Object.hasOwn(body, "reasoning"), false);
    assert.deepEqual(body.messages, input.messages);
    assert.equal(Object.hasOwn(body, "seed"), false, "seed is not enabled for this endpoint");
    return good();
  }));
  assert.equal((await client.run(MODEL_NAME, input)).choices[0].message.content, "OK");
  assert.equal(client.stats.attempts, 1);
  assert.equal(client.stats.cost, 0);
  assert.equal(client.stats.reportedCostCalls, 1);
});

test("missing credentials, wrong model or unexpected URL fail before sending a request", async () => {
  const fetch = async () => { assert.fail("must not send credentials"); };
  await assert.rejects(createModelClient({}, options(fetch)).run(MODEL_NAME, input), /not configured/);
  await assert.rejects(createModelClient(env, options(fetch)).run("another-model", input), /selected model/);
  await assert.rejects(createModelClient({ ...env, MODEL_BASE_URL: "https://another-host" }, options(fetch)).run(MODEL_NAME, input), /refusing to send/);
});

test("transient rate limits get one bounded retry and physical attempts are budgeted", async () => {
  let calls = 0;
  const client = createModelClient(env, options(async () => ++calls === 1
    ? Response.json({ error: { message: "rate limited", code: 429 } }, { status: 429, headers: { "Retry-After": "1" } }) : good()));
  await client.run(MODEL_NAME, input);
  assert.equal(client.stats.attempts, 2);
  assert.equal(client.stats.retries, 1);
  const exhausted = createModelClient(env, { ...options(async () => good()), maxAttempts: 1 });
  await exhausted.run(MODEL_NAME, input);
  await assert.rejects(exhausted.run(MODEL_NAME, input), /budget exhausted/);
});

test("daily exhaustion and auth errors are not retried, and secrets cannot enter failure evidence", async () => {
  for (const status of [401, 429]) {
    const client = createModelClient(env, options(async () => Response.json({ error: { code: status,
      message: `daily quota exhausted ${env.MODEL_API_KEY}` } }, { status })));
    await assert.rejects(client.run(MODEL_NAME, input), error => !error.message.includes(env.MODEL_API_KEY) && error.message.includes("[REDACTED]"));
    assert.equal(client.stats.attempts, 1);
  }
});

test("empty, truncated and substituted model outputs are rejected", async () => {
  for (const response of [
    { choices: [{ message: { content: "" }, finish_reason: "stop" }] },
    { choices: [{ message: { content: "partial" }, finish_reason: "length" }] },
    { model: "paid-fallback", choices: [{ message: { content: "OK" }, finish_reason: "stop" }] }
  ]) await assert.rejects(createModelClient(env, options(async () => Response.json(response))).run(MODEL_NAME, input));
});

test("canceling a failed experiment aborts in-flight and queued requests without more inference", async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const client = createModelClient(env, options(async (_url, init) => {
    started();
    return new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("canceled"))));
  }));
  const pending = client.run(MODEL_NAME, input);
  await ready;
  client.cancel();
  await assert.rejects(pending, error => error.providerFailure && error.message.includes("canceled"));
  await assert.rejects(client.run(MODEL_NAME, input), /canceled/);
  assert.equal(client.stats.attempts, 1);
});

test("a provider outage is not retried again as a judge JSON repair", async () => {
  const client = createModelClient(env, options(async () => Response.json({ error: { code: 503, message: "overloaded" } }, { status: 503 })));
  const context = createEvaluationContext(client);
  await assert.rejects(judgeSummary(context, developmentCorpus[0], developmentCorpus[0].reference), /503/);
  assert.equal(context.usage.calls, 1);
  assert.equal(client.stats.attempts, 2);
  await context.cancel();
  await assert.rejects(context.ai.run(MODEL_NAME, input), /canceled/);
});

test("a transient network failure receives one bounded retry", async () => {
  let requests = 0;
  const client = createModelClient(env, options(async () => {
    if (++requests === 1) throw new TypeError("fetch failed");
    return good();
  }));
  await client.run(MODEL_NAME, input);
  assert.equal(requests, 2);
  assert.equal(client.stats.retries, 1);
});

test("HTML auth errors are terminal and restored HTTP budgets are not reset", async () => {
  let requests = 0;
  const client = createModelClient(env, options(async () => {
    requests++; return new Response("<html>Unauthorized</html>", { status: 401 });
  }));
  await assert.rejects(client.run(MODEL_NAME, input), error => error.code === "http_401" && !error.retryable);
  assert.equal(requests, 1);
  const restored = createModelClient(env, { ...options(async () => good()), initialStats: { attempts: 64 } });
  await assert.rejects(restored.run(MODEL_NAME, input), error => error.code === "daily_budget");
  assert.equal(restored.stats.attempts, 64);
});

test("truncation retries once with more space for thinking, preserving physical usage and rejected evidence", async () => {
  const limits = [], rejected = [];
  const client = createModelClient(env, { ...options(async (_url, init) => {
    limits.push(JSON.parse(init.body).max_tokens);
    return limits.length === 1 ? Response.json({ model: MODEL_NAME,
      choices: [{ finish_reason: "length", message: { content: "partial", reasoning_content: "thinking" } }],
      usage: { prompt_tokens: 100, completion_tokens: 4096, completion_tokens_details: { reasoning_tokens: 4000 }, cost: 0.02 } }) : good();
  }), onRejectedResponse: async (response, details) => rejected.push({ response, ...details }) });
  const result = await client.run(MODEL_NAME, { ...input, max_tokens: 4096 });
  assert.equal(result.choices[0].message.content, "OK");
  assert.deepEqual(limits, [4096, 8192]);
  assert.equal(client.stats.attempts, 2);
  assert.equal(client.stats.retries, 1);
  assert.equal(client.stats.truncatedResponses, 1);
  assert.equal(client.stats.inputTokens, 110);
  assert.equal(client.stats.outputTokens, 4098);
  assert.equal(client.stats.reasoningTokens, 4000);
  assert.equal(client.stats.cost, 0.02);
  assert.equal(rejected[0].response.choices[0].message.content, "partial");
  assert.equal(rejected[0].code, "output_truncated");
});

test("repeated truncation is retryable but cannot exceed two HTTP attempts or the output cap", async () => {
  const limits = [];
  const client = createModelClient(env, options(async (_url, init) => {
    limits.push(JSON.parse(init.body).max_tokens);
    return Response.json({ model: MODEL_NAME, choices: [{ finish_reason: "length", message: { content: "incomplete" } }] });
  }));
  await assert.rejects(client.run(MODEL_NAME, { ...input, max_tokens: 10000 }), error => error.code === "output_truncated" && error.retryable);
  assert.deepEqual(limits, [10000, MAX_MODEL_OUTPUT_TOKENS]);
  assert.equal(client.stats.attempts, 2);
  assert.equal(client.stats.truncatedResponses, 2);
  assert.equal(client.stats.retries, 1);
});

test("truncation recovery never bypasses the shared HTTP budget and never accepts a different model", async () => {
  const client = createModelClient(env, { ...options(async () => Response.json({ model: MODEL_NAME,
    choices: [{ finish_reason: "length", message: { content: "partial" } }] })), maxAttempts: 1 });
  await assert.rejects(client.run(MODEL_NAME, input), error => error.code === "daily_budget");
  assert.equal(client.stats.attempts, 1);
  let calls = 0;
  await assert.rejects(createModelClient(env, options(async () => {
    calls++;
    return Response.json({ model: "another-model", choices: [{ finish_reason: "length", message: { content: "partial" } }] });
  })).run(MODEL_NAME, input), error => error.code === "model_mismatch" && !error.retryable);
  assert.equal(calls, 1);
});

test("empty output has bounded recovery without fabricating response text", async () => {
  let calls = 0;
  const client = createModelClient(env, options(async () => ++calls === 1
    ? Response.json({ model: MODEL_NAME, choices: [{ finish_reason: "stop", message: { content: "" } }] }) : good()));
  assert.equal((await client.run(MODEL_NAME, input)).choices[0].message.content, "OK");
  assert.equal(calls, 2);
  assert.equal(client.stats.retries, 1);
});
