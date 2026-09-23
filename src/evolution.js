import { benchmark, initialPrompt, modelName } from "./benchmark.js";

export const STATE_KEY = "rsi:v2:state";
const RUN_PREFIX = "rsi:v2:run:";
const HEADINGS = ["结论", "要点", "风险", "术语"];
const SCORER_VERSION = 3;

export function experimentDate(timestamp) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(timestamp));
}

export function initialState() {
  return {
    schemaVersion: 2,
    generation: 0,
    champion: { version: "v0", prompt: initialPrompt, score: null },
    latestRun: null,
    history: [],
    updatedAt: null
  };
}

export function extractText(response) {
  if (typeof response === "string") return response.trim();
  if (typeof response?.response === "string") return response.response.trim();
  if (typeof response?.response?.content === "string") return response.response.content.trim();
  if (typeof response?.choices?.[0]?.message?.content === "string") return response.choices[0].message.content.trim();
  throw new Error("Workers AI returned no text");
}

function clean(text) {
  return text.normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase();
}

export function scoreSummary(summary, sample) {
  const normalized = clean(summary);
  const hits = sample.anchors.map(alternatives => alternatives.some(term => normalized.includes(clean(term))));
  const coverage = hits.filter(Boolean).length / sample.anchors.length;
  const headings = HEADINGS.map(heading => new RegExp(`(^|\\n)\\s*(?:#{1,3}\\s*)?(?:\\*\\*)?${heading}(?:\\*\\*)?\\s*[:：]`, "m").test(summary));
  const format = headings.filter(Boolean).length / HEADINGS.length;
  const characters = Array.from(summary.replace(/\s+/g, "")).length;
  const efficiency = characters >= 80 && characters <= 450 ? (450 - characters) / 370 : 0;
  const forbidden = sample.forbidden.filter(term => normalized.includes(clean(term)));
  const score = Math.round(100 * (coverage * 0.6 + format * 0.2 + efficiency * 0.2) - forbidden.length * 15);
  return {
    score: Math.max(0, score),
    coverage: Number(coverage.toFixed(3)),
    format: Number(format.toFixed(3)),
    efficiency: Number(efficiency.toFixed(3)),
    characters,
    forbidden,
    missing: sample.anchors.filter((_, index) => !hits[index]).map(terms => terms[0])
  };
}

function parseCandidates(text) {
  const raw = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.candidates) || parsed.candidates.length !== 2) throw new Error("Candidate response must contain two prompts");
  return parsed.candidates.map((item, index) => {
    const prompt = String(item.prompt ?? "").trim();
    const hypothesis = String(item.hypothesis ?? "").trim().slice(0, 180);
    if (prompt.length < 80 || prompt.length > 1200 || !HEADINGS.every(heading => prompt.includes(heading)) ||
      !/原文|文章/.test(prompt) || !/禁止|不得|不能|不可|仅依据|只依据|严格基于/.test(prompt)) {
      throw new Error(`Candidate ${index + 1} failed validation`);
    }
    if (!hypothesis) throw new Error("Candidate hypothesis missing");
    return { id: `C${index + 1}`, prompt, hypothesis };
  });
}

async function generateCandidates(ai, champion, previousRun) {
  const failures = previousRun?.candidates?.map(item => `${item.id}: ${item.metrics?.missing?.join("、") || item.reason || "无"}`).join("\n") || "尚无历史失分";
  const response = await ai.run(modelName, {
    messages: [
      { role: "system", content: "/no_think\n你负责优化技术文章的中文结构化摘要提示词。只返回有效 JSON，不使用 Markdown。候选必须保留四段标题和禁止编造要求，每个候选只改变一个策略。" },
      { role: "user", content: `当前冠军提示词：\n${champion}\n\n上一轮失分：\n${failures}\n\n生成两个不同的完整候选提示词。JSON 格式：{"candidates":[{"hypothesis":"单一修改点","prompt":"完整提示词"},{"hypothesis":"单一修改点","prompt":"完整提示词"}]}。` }
    ],
    max_tokens: 2000,
    temperature: 0.7
  });
  return parseCandidates(extractText(response));
}

async function runPrompt(ai, prompt) {
  const outputs = await Promise.all(benchmark.map(async sample => {
    const response = await ai.run(modelName, {
      messages: [
        { role: "system", content: `/no_think\n${prompt}` },
        { role: "user", content: `请根据下文完成任务。只输出摘要。\n\n${sample.article}` }
      ],
      max_tokens: 460,
      temperature: 0,
      seed: 42
    });
    const summary = extractText(response);
    const result = scoreSummary(summary, sample);
    return { sampleId: sample.id, title: sample.title, summary, ...result };
  }));
  return aggregateOutputs(outputs);
}

function aggregateOutputs(outputs) {
  return {
    score: Number((outputs.reduce((sum, item) => sum + item.score, 0) / outputs.length).toFixed(1)),
    coverage: Number((outputs.reduce((sum, item) => sum + item.coverage, 0) / outputs.length).toFixed(3)),
    format: Number((outputs.reduce((sum, item) => sum + item.format, 0) / outputs.length).toFixed(3)),
    characters: Math.round(outputs.reduce((sum, item) => sum + item.characters, 0) / outputs.length),
    forbidden: outputs.flatMap(item => item.forbidden),
    missing: [...new Set(outputs.flatMap(item => item.missing))],
    outputs
  };
}

export function rescoreMetrics(metrics) {
  const outputs = benchmark.map(sample => {
    const original = metrics.outputs?.find(item => item.sampleId === sample.id);
    if (!original || typeof original.summary !== "string") throw new Error(`Missing saved output for ${sample.id}`);
    return { sampleId: sample.id, title: sample.title, summary: original.summary, ...scoreSummary(original.summary, sample) };
  });
  return aggregateOutputs(outputs);
}

export async function getState(env) {
  const stored = await env.EVOLUTION.get(STATE_KEY, "json");
  return stored?.schemaVersion === 2 ? stored : initialState();
}

export async function runEvolution(env, timestamp = Date.now()) {
  const date = experimentDate(timestamp);
  const state = await getState(env);
  if (state.latestRun?.date === date && state.latestRun.status === "completed") {
    return { skipped: true, state };
  }
  const startedAt = new Date().toISOString();
  try {
    const candidates = await generateCandidates(env.AI, state.champion.prompt, state.latestRun);
    if (candidates.some(item => item.prompt === state.champion.prompt) || candidates[0].prompt === candidates[1].prompt) {
      throw new Error("Candidate prompt did not change");
    }
    const baseline = await runPrompt(env.AI, state.champion.prompt);
    const evaluated = [];
    for (const candidate of candidates) {
      const metrics = await runPrompt(env.AI, candidate.prompt);
      const eligible = metrics.forbidden.length === 0 && metrics.coverage >= baseline.coverage && metrics.score >= baseline.score + 2;
      evaluated.push({
        ...candidate, metrics, eligible,
        reason: eligible ? "综合分至少提升 2 分，事实覆盖未下降，禁用断言为零" :
          metrics.forbidden.length ? "出现基准集禁用断言" :
          metrics.coverage < baseline.coverage ? "事实覆盖低于当日冠军" : "综合分提升不足 2 分"
      });
    }
    const winner = evaluated.filter(item => item.eligible).sort((a, b) => b.metrics.score - a.metrics.score)[0];
    const generation = state.generation + (winner ? 1 : 0);
    const champion = winner
      ? { version: `v${generation}`, prompt: winner.prompt, score: winner.metrics.score }
      : { ...state.champion, score: baseline.score };
    const run = {
      id: crypto.randomUUID(), date, status: "completed", startedAt, completedAt: new Date().toISOString(),
      model: modelName, scorerVersion: SCORER_VERSION, benchmarkIds: benchmark.map(item => item.id),
      baseline, candidates: evaluated, accepted: Boolean(winner), selectedId: winner?.id ?? null,
      championVersion: champion.version, championScore: champion.score,
      reason: winner ? `${winner.id} 通过晋级门槛` : "所有候选未通过晋级门槛，冠军保持不变"
    };
    const next = {
      schemaVersion: 2, generation, champion, latestRun: run,
      history: [...state.history, { date, generation, score: champion.score, accepted: Boolean(winner), focus: winner?.hypothesis ?? "保持冠军" }].slice(-30),
      updatedAt: run.completedAt
    };
    await env.EVOLUTION.put(`${RUN_PREFIX}${date}`, JSON.stringify(run));
    await env.EVOLUTION.put(STATE_KEY, JSON.stringify(next));
    return { skipped: false, state: next };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const run = { id: crypto.randomUUID(), date, status: "failed", startedAt, completedAt: new Date().toISOString(), error: message };
    const next = { ...state, latestRun: run, updatedAt: run.completedAt };
    await env.EVOLUTION.put(`${RUN_PREFIX}${date}`, JSON.stringify(run));
    await env.EVOLUTION.put(STATE_KEY, JSON.stringify(next));
    console.error(JSON.stringify({ message: "evolution_failed", date, error: message }));
    throw error;
  }
}

export async function rescoreLatest(env) {
  const state = await getState(env);
  const run = state.latestRun;
  if (run?.status !== "completed" || run.accepted) throw new Error("Only a completed, non-promoted run may be rescored");
  const localDate = experimentDate(Date.parse(run.startedAt));
  if (run.scorerVersion === SCORER_VERSION && run.date === localDate) return { skipped: true, state };
  const baseline = run.scorerVersion === SCORER_VERSION ? run.baseline : rescoreMetrics(run.baseline);
  const candidates = run.candidates.map(candidate => {
    const metrics = run.scorerVersion === SCORER_VERSION ? candidate.metrics : rescoreMetrics(candidate.metrics);
    const eligible = metrics.forbidden.length === 0 && metrics.coverage >= baseline.coverage && metrics.score >= baseline.score + 2;
    return {
      ...candidate, metrics, eligible,
      reason: eligible ? "综合分至少提升 2 分，事实覆盖未下降，禁用断言为零" :
        metrics.forbidden.length ? "出现基准集禁用断言" :
        metrics.coverage < baseline.coverage ? "事实覆盖低于当日冠军" : "综合分提升不足 2 分"
    };
  });
  const winner = candidates.filter(item => item.eligible).sort((a, b) => b.metrics.score - a.metrics.score)[0];
  const generation = state.generation + (winner ? 1 : 0);
  const champion = winner
    ? { version: `v${generation}`, prompt: winner.prompt, score: winner.metrics.score }
    : { ...state.champion, score: baseline.score };
  const rescoredAt = new Date().toISOString();
  const correctedRun = {
    ...run, date: localDate, previousDate: run.date !== localDate ? run.date : undefined,
    scorerVersion: SCORER_VERSION, rescoredAt, baseline, candidates,
    accepted: Boolean(winner), selectedId: winner?.id ?? null,
    championVersion: champion.version, championScore: champion.score,
    reason: winner ? `${winner.id} 在评分器修正后通过晋级门槛` : "按修正后的评分器重算；所有候选未通过晋级门槛"
  };
  const history = state.history.map(item => item.date === run.date
    ? { ...item, date: localDate, generation, score: champion.score, accepted: Boolean(winner), focus: winner?.hypothesis ?? "保持冠军" }
    : item);
  const next = { ...state, generation, champion, latestRun: correctedRun, history, updatedAt: rescoredAt };
  await env.EVOLUTION.put(`${RUN_PREFIX}${localDate}`, JSON.stringify(correctedRun));
  await env.EVOLUTION.put(STATE_KEY, JSON.stringify(next));
  return { skipped: false, state: next };
}

export function publicState(state) {
  return {
    schemaVersion: state.schemaVersion, generation: state.generation, champion: state.champion,
    latestRun: state.latestRun, history: state.history, updatedAt: state.updatedAt,
    benchmark: benchmark.map(({ id, title, article, anchors }) => ({ id, title, article, anchors: anchors.map(group => group[0]) })),
    scoring: "事实关键词覆盖 60% + 四段格式 20% + 80–450 字内的精简度 20%；命中禁用断言每项扣 15 分。候选需提升至少 2 分、事实覆盖不下降、无禁用断言。"
  };
}
