import { MODEL_NAME, OPENROUTER_BASE_URL } from "./model.js";

export function redactError(value, key) {
  let message = String(value).replace(/sk-or-v1-[a-zA-Z0-9]+/g, "[REDACTED]");
  if (key) message = message.split(key).join("[REDACTED]");
  return message.slice(0, 600);
}

export function createModelClient(env, options = {}) {
  const request = options.fetch || fetch;
  const pause = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = options.now || Date.now;
  const stats = { attempts: 0, retries: 0, cost: 0, reportedCostCalls: 0 };
  let queue = Promise.resolve();
  let nextStart = 0;
  const maxAttempts = options.maxAttempts ?? 64;
  const interval = options.intervalMs ?? 3100;

  async function startGate() {
    const gate = queue.then(async () => {
      await pause(Math.max(0, nextStart - now()));
      nextStart = now() + interval;
    });
    queue = gate.catch(() => {});
    await gate;
  }

  return { stats, async run(model, input) {
    if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY secret is not configured");
    if (model !== MODEL_NAME || (env.MODEL_NAME && env.MODEL_NAME !== MODEL_NAME) ||
        (env.JUDGE_MODEL && env.JUDGE_MODEL !== MODEL_NAME)) throw new Error("Model configuration does not match the selected model");
    if (env.OPENROUTER_BASE_URL && env.OPENROUTER_BASE_URL !== OPENROUTER_BASE_URL) {
      throw new Error("Unexpected OpenRouter base URL; refusing to send credentials");
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await startGate();
      if (stats.attempts >= maxAttempts) throw new Error(`OpenRouter HTTP attempt budget exhausted (${maxAttempts})`);
      stats.attempts++;
      let response, data;
      try {
        response = await request(`${OPENROUTER_BASE_URL}/chat/completions`, {
          method: "POST", headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages: input.messages, max_tokens: input.max_tokens,
            temperature: input.temperature, seed: input.seed, reasoning: { enabled: false } }),
          signal: AbortSignal.timeout(options.timeoutMs ?? 120000)
        });
        data = await response.json();
      } catch (error) {
        throw new Error(`OpenRouter request failed: ${redactError(error.message, env.OPENROUTER_API_KEY)}`);
      }
      if (typeof data.usage?.cost === "number") { stats.cost += data.usage.cost; stats.reportedCostCalls++; }
      const message = redactError(data.error?.message || `HTTP ${response.status}`, env.OPENROUTER_API_KEY);
      if (!response.ok || data.error) {
        const status = Number(data.error?.code) || response.status;
        const exhausted = /daily|quota|credits|balance|每天|每日|额度/i.test(message);
        const retryAfter = response.headers.get("Retry-After");
        const retryMs = retryAfter == null ? 10000 : /^\d+(\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - now());
        if (!attempt && !exhausted && (status === 429 || status >= 500) && Number.isFinite(retryMs) && retryMs <= 60000) {
          stats.retries++;
          await pause(Math.max(1000, retryMs));
          continue;
        }
        throw new Error(`OpenRouter ${status}: ${message}`);
      }
      const choice = data.choices?.[0];
      if (choice?.finish_reason === "length") throw new Error("OpenRouter output was truncated; refusing incomplete evidence");
      if (typeof choice?.message?.content !== "string" || !choice.message.content.trim()) {
        throw new Error("OpenRouter returned no usable text");
      }
      if (data.model && data.model !== MODEL_NAME) throw new Error("OpenRouter returned an unexpected model; refusing fallback");
      return data;
    }
  } };
}
