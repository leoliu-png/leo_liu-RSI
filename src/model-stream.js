// MiniMax gateways may duplicate reasoning_content as a leading <think> block.
export function visibleModelText(content) {
  if (typeof content !== "string") return content;
  const thinking = /^\s*<think>[\s\S]*?<\/think>\s*/u.exec(content);
  if (thinking) return content.slice(thinking[0].length);
  if (/^\s*<think>/u.test(content)) throw Object.assign(new Error("Unclosed model thinking block"), { code: "incomplete_stream", retryable: true });
  return content;
}

// Assemble SSE without treating cut-off streams or reasoning as completed answers.
export async function readModelStream(response, { touch = () => {}, onUsage = async () => {} } = {}) {
  if (!response.body) throw Object.assign(new Error("Model stream has no body"), { code: "invalid_stream", retryable: true });
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = "", content = "", reasoning = "", finish = null, model, id, usage, done = false, bytes = 0;
  const consume = async frame => {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:"))
      .map(line => line.slice(5).trimStart()).join("\n");
    if (!data) return;
    if (data.trim() === "[DONE]") { done = true; return; }
    const value = JSON.parse(data);
    if (value.error) throw Object.assign(new Error(value.error.message || "Model stream failed"), {
      code: Number(value.error.code) ? `http_${value.error.code}` : "stream_error", retryable: true, streamError: value.error
    });
    if (model && value.model && value.model !== model) throw Object.assign(new Error("Model identity changed within a stream"), { code: "model_mismatch", retryable: false });
    model ||= value.model;
    id ||= value.id;
    const choice = value.choices?.[0];
    if (typeof choice?.delta?.content === "string") content += choice.delta.content;
    if (typeof choice?.delta?.reasoning_content === "string") reasoning += choice.delta.reasoning_content;
    if (choice?.finish_reason) finish = choice.finish_reason;
    if (value.usage) { usage = value.usage; await onUsage(usage); }
  };
  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      touch();
      bytes += chunk.value.byteLength;
      if (bytes > 4 * 1024 * 1024) throw Object.assign(new Error("Model stream exceeded bounded response size"), { code: "invalid_stream", retryable: false });
      buffer += decoder.decode(chunk.value, { stream: true });
      let match;
      while (!done && (match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        await consume(frame);
      }
    }
    buffer += decoder.decode();
    if (!done && buffer.trim()) await consume(buffer);
    if (!finish || !["stop", "length"].includes(finish)) throw Object.assign(new Error("Model stream ended without a complete text finish marker"), { code: "incomplete_stream", retryable: true });
    return { id, model, object: "chat.completion", choices: [{ index: 0, finish_reason: finish,
      message: { role: "assistant", content, ...(reasoning ? { reasoning_content: reasoning } : {}) } }], ...(usage ? { usage } : {}) };
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}
