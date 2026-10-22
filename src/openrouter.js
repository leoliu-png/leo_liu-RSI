import { MODEL_NAME, MODEL_SUPPORTS_SEED, MODEL_BASE_URL, MAX_MODEL_OUTPUT_TOKENS, MODEL_REQUEST_TIMEOUT_MS, MODEL_STREAM_IDLE_MS } from "./model.js";
import { readModelStream, visibleModelText } from "./model-stream.js";
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
  const stats = { attempts: 0, retries: 0, networkRetries: 0, outputRetries: 0, streamResponses: 0, cost: 0, reportedCostCalls: 0,
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0, truncatedResponses: 0, ...options.initialStats };
  const active = new Set();
  const policies = options.policies || {};
  let canceled = false;
  let queue = Promise.resolve();
  let nextStart = 0;
  const maxAttempts = options.maxAttempts ?? 96;
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
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify({ model, messages: input.messages, temperature: input.temperature })));
    const key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    let outputLimit = Math.min(MAX_MODEL_OUTPUT_TOKENS, Math.max(1, input.max_tokens || 8192, policies[key]?.maxTokens || 0));
    let networkRetries = 0, outputRetries = 0;
    for (let attempt = 0; attempt < 4; attempt++) {
      await startGate();
      options.beforeAttempt?.();
      if (stats.attempts >= maxAttempts) throw providerFailure(`LiteLLM HTTP attempt budget exhausted (${maxAttempts})`, { code: "daily_http_budget" });
      stats.attempts++;
      await options.onAttempt?.(stats);
      let response, data, streamUsage;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? MODEL_REQUEST_TIMEOUT_MS);
      let idle;
      const touch = () => {
        clearTimeout(idle);
        idle = setTimeout(() => controller.abort(), options.idleTimeoutMs ?? MODEL_STREAM_IDLE_MS);
      };
      touch();
      active.add(controller);
      try {
        response = await request(`${MODEL_BASE_URL}/chat/completions`, {
          method: "POST", headers: { Authorization: `Bearer ${env.MODEL_API_KEY}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, messages: input.messages, max_tokens: outputLimit,
            temperature: input.temperature, stream: true, stream_options: { include_usage: true },
            ...(MODEL_SUPPORTS_SEED ? { seed: input.seed } : {}) }),
          signal: controller.signal
        });
        try {
          if (response.ok && /text\/event-stream/i.test(response.headers.get("content-type") || "")) {
            stats.streamResponses++;
            data = await readModelStream(response, { touch, onUsage: async usage => {
              stats.inputTokens += Math.max(0, (usage.prompt_tokens || 0) - (streamUsage?.prompt_tokens || 0));
              stats.outputTokens += Math.max(0, (usage.completion_tokens || 0) - (streamUsage?.completion_tokens || 0));
              stats.reasoningTokens += Math.max(0, (usage.completion_tokens_details?.reasoning_tokens || 0) - (streamUsage?.completion_tokens_details?.reasoning_tokens || 0));
              if (typeof usage.cost === "number") {
                stats.cost += usage.cost - (streamUsage?.cost || 0);
                if (typeof streamUsage?.cost !== "number") stats.reportedCostCalls++;
              }
              streamUsage = usage;
              await options.onAttempt?.(stats);
            } });
          } else data = await response.json();
          const message = data.choices?.[0]?.message;
          if (data.choices?.[0]?.finish_reason !== "length" && typeof message?.content === "string") {
            const thinking = /^\s*<think>([\s\S]*?)<\/think>/u.exec(message.content);
            if (thinking && !message.reasoning_content) message.reasoning_content = thinking[1];
            message.content = visibleModelText(message.content);
          }
        }
        catch (error) {
          if (error.streamError) data = { error: error.streamError };
          else if (error.code) throw providerFailure(redactError(error.message, env.MODEL_API_KEY), { code: error.code, retryable: error.retryable !== false });
          else throw providerFailure(`LiteLLM HTTP ${response.status}: invalid JSON response`, {
            status: response.status, code: response.ok ? "invalid_response" : `http_${response.status}`,
            retryable: response.ok || response.status === 429 || response.status >= 500
          });
        }
      } catch (error) {
        if (error.providerFailure && error.retryable === false) throw error;
        if (!canceled && networkRetries < 1 && attempt < 3) {
          networkRetries++; stats.networkRetries++;
          stats.retries++;
          await options.onAttempt?.(stats);
          clearTimeout(timeout); clearTimeout(idle); active.delete(controller);
          await pause(10000);
          continue;
        }
        throw providerFailure(`LiteLLM request failed: ${redactError(error.message, env.MODEL_API_KEY)}`, {
          code: canceled ? "canceled" : error.code || "network_error", retryable: !canceled
        });
      } finally {
        clearTimeout(timeout);
        clearTimeout(idle);
        active.delete(controller);
      }
      if (!streamUsage) {
        if (typeof data.usage?.cost === "number") { stats.cost += data.usage.cost; stats.reportedCostCalls++; }
        stats.inputTokens += data.usage?.prompt_tokens || 0;
        stats.outputTokens += data.usage?.completion_tokens || 0;
        stats.reasoningTokens += data.usage?.completion_tokens_details?.reasoning_tokens || 0;
      }
      await options.onAttempt?.(stats);
      const message = redactError(data.error?.message || `HTTP ${response.status}`, env.MODEL_API_KEY);
      if (!response.ok || data.error) {
        const status = Number(data.error?.code) || response.status;
        const exhausted = /daily|quota|credits|balance|每天|每日|额度/i.test(message);
        const retryAfter = response.headers.get("Retry-After");
        const retryMs = retryAfter == null ? 10000 : /^\d+(\.\d+)?$/.test(retryAfter)
          ? Number(retryAfter) * 1000 : Math.max(0, Date.parse(retryAfter) - now());
        if (networkRetries < 1 && attempt < 3 && !exhausted && (status === 429 || status >= 500) && Number.isFinite(retryMs) && retryMs <= 60000) {
          networkRetries++; stats.networkRetries++;
          stats.retries++;
          await pause(Math.max(1000, retryMs));
          continue;
        }
        throw providerFailure(`LiteLLM ${status}: ${message}`, { status, code: exhausted ? "quota_exhausted" : `http_${status}`,
          retryable: !exhausted && (status === 429 || status >= 500), retryAfterMs: Number.isFinite(retryMs) ? retryMs : 0 });
      }
      const choice = data.choices?.[0];
      if (data.model && data.model !== MODEL_NAME) throw providerFailure("LiteLLM returned an unexpected model; refusing fallback", { code: "model_mismatch" });
      if (choice?.finish_reason === "length") {
        stats.truncatedResponses++;
        const next = Math.min(outputLimit * 2, MAX_MODEL_OUTPUT_TOKENS);
        policies[key] = { maxTokens: next, lastCode: "output_truncated", updatedAt: new Date().toISOString() };
        await options.onPolicy?.(policies);
        await options.onRejectedResponse?.(data, { code: "output_truncated", maxTokens: outputLimit, nextMaxTokens: next, requestKey: key });
        await options.onAttempt?.(stats);
        if (outputRetries < 2 && attempt < 3 && next > outputLimit) {
          outputLimit = next;
          outputRetries++; stats.outputRetries++; stats.retries++;
          continue;
        }
        throw providerFailure("LiteLLM output was truncated after bounded recovery; refusing incomplete evidence", {
          code: "output_truncated", retryable: true, maxTokens: outputLimit,
          resourceLimitReached: outputLimit >= MAX_MODEL_OUTPUT_TOKENS, requestKey: key, rejectedResponse: data
        });
      }
      if (typeof choice?.message?.content !== "string" || !choice.message.content.trim()) {
        await options.onRejectedResponse?.(data, { code: "empty_output", maxTokens: outputLimit });
        if (outputRetries < 1 && attempt < 3) { outputRetries++; stats.outputRetries++; stats.retries++; continue; }
        throw providerFailure("LiteLLM returned no usable text", { code: "empty_output", retryable: true });
      }
      return data;
    }
  } };
}
