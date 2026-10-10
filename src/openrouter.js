import { MODEL_NAME, MODEL_SUPPORTS_SEED, MODEL_BASE_URL } from "./model.js";
const providerFailure = (message, extra = {}) => Object.assign(new Error(message), { providerFailure: true, retryable: false, ...extra });

export function redactError(value, key) {
  let message = String(value).replace(/sk-[a-zA-Z0-9_-]+/g, "[REDACTED]");
  if (key) message = message.split(key).join("[REDACTED]");
  return message.slice(0, 600);
}

export function createModelClient(env, options = {}) {
  const request = options.fetch || fetch;
  const pause = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const now = options.now || Date.now;
  const stats = { attempts: 0, retries: 0, cost: 0, reportedCostCalls: 0, ...options.initialStats };
  const active = new Set();
  let canceled = false;
  let queue = Promise.resolve();
  let nextStart = 0;
  const maxAttempts = options.maxAttempts ?? 64;
  const interval = options.intervalMs ?? 3100;

  async function startGate() {
    const gate = queue.then(async () => {
      if (canceled) throw providerFailure("Experiment canceled after a failure");
      await pause(Math.max(0, nextStart - now()));
      if (canceled) throw providerFailure("Experiment canceled after a failure");
      nextStart = now() + interval;
    });
    queue = gate.catch(() => {});
    await gate;
  }

  return { stats, cancel() { canceled = true; for (const controller of active) controller.abort(); }, async run(model, input) {
    if (!env.MODEL_API_KEY) throw providerFailure("MODEL_API_KEY secret is not configured");
    if (model !== MODEL_NAME || (env.MODEL_NAME && env.MODEL_NAME !== MODEL_NAME) ||
        (env.JUDGE_MODEL && env.JUDGE_MODEL !== MODEL_NAME)) throw providerFailure("Model configuration does not match the selected model");
    if (env.MODEL_BASE_URL && env.MODEL_BASE_URL !== MODEL_BASE_URL) {
      throw providerFailure("Unexpected LiteLLM base URL; refusing to send credentials");
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await startGate();
      if (stats.attempts >= maxAttempts) throw providerFailure(`LiteLLM HTTP attempt budget exhausted (${maxAttempts})`, { code: "daily_budget" });
      stats.attempts++;
      await options.onAttempt?.(stats);
      let response, data;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 90000);
      active.add(controller);
      try {
        response = await request(`${MODEL_BASE_URL}/chat/completions`, {
          method: "POST", headers: { Authorization: `Bearer ${env.MODEL_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages: input.messages, max_tokens: input.max_tokens,
            temperature: input.temperature, ...(MODEL_SUPPORTS_SEED ? { seed: input.seed } : {}) }),
          signal: controller.signal
        });
        try { data = await response.json(); }
        catch {
          throw providerFailure(`LiteLLM HTTP ${response.status}: invalid JSON response`, {
            status: response.status, code: response.ok ? "invalid_response" : `http_${response.status}`,
            retryable: response.status === 429 || response.status >= 500
          });
        }
      } catch (error) {
        if (error.providerFailure && error.retryable === false) throw error;
        if (!canceled && !attempt) {
          stats.retries++;
          await pause(10000);
          continue;
        }
        throw providerFailure(`LiteLLM request failed: ${redactError(error.message, env.MODEL_API_KEY)}`, {
          code: canceled ? "canceled" : error.code || "network_error", retryable: !canceled
        });
      } finally {
        clearTimeout(timeout);
        active.delete(controller);
      }
      if (typeof data.usage?.cost === "number") { stats.cost += data.usage.cost; stats.reportedCostCalls++; }
      const message = redactError(data.error?.message || `HTTP ${response.status}`, env.MODEL_API_KEY);
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
        throw providerFailure(`LiteLLM ${status}: ${message}`, { status, code: exhausted ? "quota_exhausted" : `http_${status}`,
          retryable: !exhausted && (status === 429 || status >= 500), retryAfterMs: Number.isFinite(retryMs) ? retryMs : 0 });
      }
      const choice = data.choices?.[0];
      if (choice?.finish_reason === "length") throw providerFailure("LiteLLM output was truncated; refusing incomplete evidence");
      if (typeof choice?.message?.content !== "string" || !choice.message.content.trim()) {
        throw providerFailure("LiteLLM returned no usable text");
      }
      if (data.model && data.model !== MODEL_NAME) throw providerFailure("LiteLLM returned an unexpected model; refusing fallback");
      return data;
    }
  } };
}
