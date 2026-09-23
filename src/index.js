import { experimentDate, getState, publicState, rescoreLatest, runEvolution } from "./evolution.js";

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
      if (path === "/api/evolution" && request.method === "GET") return json(publicState(await getState(env)));
      if (path === "/api/health" && request.method === "GET") {
        return json({ ok: true, version: 2, now: new Date().toISOString() });
      }
      if (path === "/api/admin/run" && request.method === "POST") {
        const provided = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
        if (!await tokenMatches(provided, env.RUN_TOKEN)) return json({ error: "Unauthorized" }, 401);
        const result = await runEvolution(env);
        return json({ skipped: result.skipped, state: publicState(result.state) });
      }
      if (path === "/api/admin/rescore" && request.method === "POST") {
        const provided = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
        if (!await tokenMatches(provided, env.RUN_TOKEN)) return json({ error: "Unauthorized" }, 401);
        const result = await rescoreLatest(env);
        return json({ skipped: result.skipped, state: publicState(result.state) });
      }
      if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error(JSON.stringify({ message: "request_failed", path, error: error instanceof Error ? error.message : String(error) }));
      return json({ error: "Internal server error" }, 500);
    }
  },
  async scheduled(controller, env) {
    const result = await runEvolution(env, controller.scheduledTime || Date.now());
    console.log(JSON.stringify({
      message: result.skipped ? "evolution_skipped" : "evolution_completed",
      date: experimentDate(controller.scheduledTime || Date.now()),
      generation: result.state.generation,
      accepted: result.state.latestRun?.accepted
    }));
  }
};
