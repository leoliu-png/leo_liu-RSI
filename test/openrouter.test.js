import test from "node:test";
import assert from "node:assert/strict";
import { MODEL_NAME, OPENROUTER_BASE_URL } from "../src/model.js";
import { createModelClient } from "../src/openrouter.js";
import { createEvaluationContext, judgeSummary } from "../src/evaluator.js";
import { developmentCorpus } from "../src/corpus.js";

const env = { OPENROUTER_API_KEY: "test-private-token", MODEL_NAME, JUDGE_MODEL: MODEL_NAME, OPENROUTER_BASE_URL };
const input = { messages: [{ role: "user", content: "test" }], temperature: 0, max_tokens: 300, seed: 42 };
const good = () => Response.json({ model: MODEL_NAME, choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0 } });
const options = fetch => ({ fetch, intervalMs: 0, sleep: async () => {} });

test("OpenRouter sends the requested model and server-side credential, with reasoning disabled", async () => {
  const client = createModelClient(env, options(async (url, init) => {
    assert.equal(url, `${OPENROUTER_BASE_URL}/chat/completions`);
    assert.equal(init.headers.Authorization, `Bearer ${env.OPENROUTER_API_KEY}`);
    const body = JSON.parse(init.body);
    assert.equal(body.model, MODEL_NAME);
    assert.deepEqual(body.reasoning, { enabled: false });
    assert.deepEqual(body.messages, input.messages);
    assert.equal(Object.hasOwn(body, "seed"), false, "Laguna does not support seed");
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
  await assert.rejects(createModelClient({ ...env, OPENROUTER_BASE_URL: "https://another-host" }, options(fetch)).run(MODEL_NAME, input), /refusing to send/);
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
      message: `daily quota exhausted ${env.OPENROUTER_API_KEY}` } }, { status })));
    await assert.rejects(client.run(MODEL_NAME, input), error => !error.message.includes(env.OPENROUTER_API_KEY) && error.message.includes("[REDACTED]"));
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
