import { experimentDate } from "./evolution.js";
import { MODEL_NAME, MODEL_PROFILE, MODEL_PROVIDER } from "./model.js";
export { EvolutionRunner } from "./runner.js";

function runner(env) { return env.RUNNER.get(env.RUNNER.idFromName(MODEL_PROFILE)); }

async function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const encoder = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected))
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    try {
      if (path === "/api/evolution" && request.method === "GET") {
        const response = await runner(env).fetch("https://runner/state");
        return json(await response.json(), response.status);
      }
      if (path === "/api/health" && request.method === "GET") {
        return json({ ok: true, version: 4, provider: MODEL_PROVIDER, model: MODEL_NAME, modelProfile: MODEL_PROFILE, now: new Date().toISOString() });
      }
      if (["/api/admin/run", "/api/admin/probe"].includes(path) && request.method === "POST") {
        const provided = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
        if (!await tokenMatches(provided, env.RUN_TOKEN) && !await tokenMatches(provided, env.MAINTENANCE_TOKEN)) return json({ error: "Unauthorized" }, 401);
        const response = await runner(env).fetch(`https://runner/${path.endsWith("probe") ? "probe" : "schedule"}`, {
          method: "POST", body: JSON.stringify({ timestamp: Date.now() })
        });
        return json(await response.json(), path.endsWith("probe") ? response.status : response.ok ? 202 : response.status);
      }
      if (path === "/api/admin/rescore" && request.method === "POST") {
        const provided = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
        if (!await tokenMatches(provided, env.RUN_TOKEN)) return json({ error: "Unauthorized" }, 401);
        return json({ error: "V4 requires a fresh experiment; legacy keyword scores cannot be converted into semantic evidence" }, 409);
      }
      if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(JSON.stringify({ message: "request_failed", path, error: error instanceof Error ? error.message : String(error) }));
      return json({ error: "Internal server error" }, 500);
    }
  },
  async scheduled(controller, env) {
    const response = await runner(env).fetch("https://runner/schedule", {
      method: "POST", body: JSON.stringify({ timestamp: controller.scheduledTime || Date.now() })
    });
    if (!response.ok) throw new Error(`Daily scheduler HTTP ${response.status}`);
    const result = await response.json();
    console.log(JSON.stringify({
      message: result.queued ? "evolution_queued" : "evolution_schedule_skipped",
      date: experimentDate(controller.scheduledTime || Date.now()),
      status: result.job?.status
    }));
  }
};
