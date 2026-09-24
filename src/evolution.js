import { benchmark, initialPrompt, modelName } from "./benchmark.js";
import { holdoutForDate } from "./holdout.js";

export const STATE_KEY = "rsi:v3:state";
const LEGACY_STATE_KEY = "rsi:v2:state";
const RUN_PREFIX = "rsi:v3:run:";
const HEADINGS = ["结论", "要点", "风险", "术语"];
const SCORER_VERSION = 3;
const INITIAL_STRATEGY = {
  version: "s0",
  hypothesis: "针对事实遗漏与冗长问题，只做一处可验证的提示词修改",
  instruction: "先分析最近几轮在公开开发集上的遗漏事实、禁用断言、格式和长度问题。只提出一个明确的改进假设；候选仍须忠于原文、保留四段标题。不要根据未公开验证文章猜测内容。"
};

export function experimentDate(timestamp) {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit"
  }).format(new Date(timestamp));
}

export function initialState() {
  return {
    schemaVersion: 3,
    generation: 0,
    champion: { version: "v0", prompt: initialPrompt, score: null },
    strategyGeneration: 0,
    strategy: { ...INITIAL_STRATEGY },
    challenger: null,
    strategyHistory: [],
    feedbackHistory: [],
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

function parseJson(text) {
  return JSON.parse(text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, ""));
}

function parseStrategy(text) {
  const value = parseJson(text);
  const instruction = String(value.instruction ?? "").trim();
  const hypothesis = String(value.hypothesis ?? "").trim().slice(0, 180);
  if (instruction.length < 60 || instruction.length > 700 || !hypothesis ||
      /答案泄露|评分器|绕过|修改代码/.test(instruction)) {
    throw new Error("Strategy proposal failed validation");
  }
  return { id: crypto.randomUUID(), hypothesis, instruction, trials: [] };
}

function parseCandidate(text, id, strategyVersion) {
  const value = parseJson(text);
  const prompt = String(value.prompt ?? "").trim();
  const hypothesis = String(value.hypothesis ?? "").trim().slice(0, 180);
  if (prompt.length < 80 || prompt.length > 1200 || !HEADINGS.every(heading => prompt.includes(heading)) ||
      !/原文|文章/.test(prompt) || !/禁止|不得|不能|不可|仅依据|只依据|严格基于/.test(prompt)) {
    throw new Error(`${id} failed prompt validation`);
  }
  if (!hypothesis) throw new Error(`${id} hypothesis missing`);
  return { id, strategyVersion, prompt, hypothesis };
}

function historicalFeedback(state) {
  const records = state.feedbackHistory?.slice(-5) || [];
  if (!records.length && state.latestRun?.status === "completed") {
    records.push({
      date: state.latestRun.date,
      candidates: state.latestRun.candidates?.map(item => ({
        id: item.id, reason: item.reason, missing: item.metrics?.missing || [],
        forbidden: item.metrics?.forbidden || [], score: item.metrics?.score
      })) || []
    });
  }
  return records.length ? JSON.stringify(records) : "尚无历史失败记录";
}

async function generateStrategy(ai, state) {
  const response = await ai.run(modelName, {
    messages: [
      { role: "system", content: "/no_think\n你研究如何更有效地产生技术摘要提示词候选。只返回 JSON，不能改变摘要任务、评分规则或候选必须忠于原文的约束。" },
      { role: "user", content: `当前生成策略：\n${state.strategy.instruction}\n\n最近开发集失败证据：\n${historicalFeedback(state)}\n\n提出一条不同且可检验的生成候选策略，重点解决多轮反复出现的问题。只返回 {"hypothesis":"为什么这条策略会更好","instruction":"给候选提示词生成器的具体操作指令"}。不要请求或猜测未公开验证文章。` }
    ],
    max_tokens: 650,
    temperature: 0.65
  });
  const challenger = parseStrategy(extractText(response));
  if (challenger.instruction === state.strategy.instruction) throw new Error("Strategy proposal did not change");
  return challenger;
}

async function generateCandidate(ai, champion, strategy, feedback, id) {
  const response = await ai.run(modelName, {
    messages: [
      { role: "system", content: `/no_think\n你负责改进技术文章的四段式中文摘要提示词。只返回有效 JSON。必须保留四段标题、忠于原文和禁止编造要求。\n候选生成策略：${strategy.instruction}` },
      { role: "user", content: `当前冠军提示词：\n${champion}\n\n最近开发集失败证据：\n${feedback}\n\n只提出一个完整候选，并清楚写出单一修改点。格式：{"hypothesis":"单一修改点","prompt":"完整提示词"}。不得加入任何未公开验证文章的信息。` }
    ],
    max_tokens: 1200,
    temperature: 0.7
  });
  return parseCandidate(extractText(response), id, strategy.version || `trial-${strategy.id.slice(0, 8)}`);
}

async function runPrompt(ai, prompt, samples) {
  const outputs = await Promise.all(samples.map(async sample => {
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
    return { sampleId: sample.id, title: sample.title, summary, ...scoreSummary(summary, sample) };
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

function migrateLegacy(stored) {
  const fresh = initialState();
  if (stored?.schemaVersion !== 2) return fresh;
  return {
    ...fresh, generation: stored.generation, champion: stored.champion,
    latestRun: stored.latestRun, history: stored.history || [], updatedAt: stored.updatedAt
  };
}

export async function getState(env) {
  const stored = await env.EVOLUTION.get(STATE_KEY, "json");
  if (stored?.schemaVersion === 3) return stored;
  return migrateLegacy(await env.EVOLUTION.get(LEGACY_STATE_KEY, "json"));
}

export function promotionDecision(candidate, baseline, holdoutBaseline) {
  if (candidate.metrics.forbidden.length) return { eligible: false, reason: "开发集出现禁用断言" };
  if (candidate.metrics.coverage < baseline.coverage) return { eligible: false, reason: "开发集事实覆盖下降" };
  if (candidate.metrics.score < baseline.score + 2) return { eligible: false, reason: "开发集综合分提升不足 2 分" };
  if (candidate.holdout.forbidden.length) return { eligible: false, reason: "新验证文章出现禁用断言，回退" };
  if (candidate.holdout.coverage < holdoutBaseline.coverage) return { eligible: false, reason: "新验证文章事实覆盖下降，回退" };
  if (candidate.holdout.score < holdoutBaseline.score) return { eligible: false, reason: "新验证文章综合分下降，回退" };
  return { eligible: true, reason: "开发集提升至少 2 分，且新验证文章无退步" };
}

export function challengerBeatsIncumbent(current, challenger) {
  return challenger.metrics.score >= current.metrics.score + 2 &&
    challenger.holdout.score >= current.holdout.score + 1 &&
    challenger.metrics.coverage >= current.metrics.coverage &&
    challenger.holdout.coverage >= current.holdout.coverage &&
    challenger.metrics.forbidden.length === 0 && challenger.holdout.forbidden.length === 0;
}

export function updateStrategyTrial(state, date, current, candidate) {
  const challenger = state.challenger;
  const challengerWon = challengerBeatsIncumbent(current, candidate);
  const trial = {
    date, incumbent: state.strategy.version, challengerId: challenger.id,
    incumbentDevelopmentScore: current.metrics.score, challengerDevelopmentScore: candidate.metrics.score,
    incumbentHoldoutScore: current.holdout.score, challengerHoldoutScore: candidate.holdout.score,
    challengerWon
  };
  const trials = [...challenger.trials, trial];
  const wins = trials.filter(item => item.challengerWon).length;
  let strategy = state.strategy;
  let nextChallenger = { ...challenger, trials };
  let strategyGeneration = state.strategyGeneration;
  let decision = `挑战策略试用 ${trials.length}/3；已赢 ${wins} 次，需累计 2 次才晋级`;
  if (wins >= 2) {
    strategyGeneration++;
    strategy = { version: `s${strategyGeneration}`, hypothesis: challenger.hypothesis, instruction: challenger.instruction };
    nextChallenger = null;
    decision = `挑战策略跨日验证通过：${wins}/${trials.length} 次胜出，晋级 ${strategy.version}`;
  } else if (trials.length >= 3) {
    nextChallenger = null;
    decision = `挑战策略仅胜出 ${wins}/3 次，回退并保留 ${strategy.version}`;
  }
  return { trial, strategy, challenger: nextChallenger, strategyGeneration, decision };
}

export async function runEvolution(env, timestamp = Date.now()) {
  const date = experimentDate(timestamp);
  const state = await getState(env);
  if (state.latestRun?.date === date && state.latestRun.status === "completed") return { skipped: true, state };
  const startedAt = new Date().toISOString();
  try {
    const challenger = state.challenger || await generateStrategy(env.AI, state);
    const workingState = { ...state, challenger };
    const feedback = historicalFeedback(state);
    const candidates = [
      await generateCandidate(env.AI, state.champion.prompt, state.strategy, feedback, "C1"),
      await generateCandidate(env.AI, state.champion.prompt, challenger, feedback, "C2")
    ];
    if (candidates.some(item => item.prompt === state.champion.prompt) || candidates[0].prompt === candidates[1].prompt) {
      throw new Error("Candidate prompt did not change");
    }
    const validationSamples = holdoutForDate(date);
    const [baseline, holdoutBaseline] = await Promise.all([
      runPrompt(env.AI, state.champion.prompt, benchmark),
      runPrompt(env.AI, state.champion.prompt, validationSamples)
    ]);
    const evaluated = [];
    for (const item of candidates) {
      const [metrics, holdout] = await Promise.all([
        runPrompt(env.AI, item.prompt, benchmark),
        runPrompt(env.AI, item.prompt, validationSamples)
      ]);
      const result = promotionDecision({ metrics, holdout }, baseline, holdoutBaseline);
      evaluated.push({ ...item, metrics, holdout, ...result });
    }
    const winner = evaluated.filter(item => item.eligible)
      .sort((a, b) => b.metrics.score - a.metrics.score || b.holdout.score - a.holdout.score)[0];
    const generation = state.generation + (winner ? 1 : 0);
    const champion = winner
      ? { version: `v${generation}`, prompt: winner.prompt, score: winner.metrics.score }
      : { ...state.champion, score: baseline.score };
    const strategyResult = updateStrategyTrial(workingState, date, evaluated[0], evaluated[1]);
    const run = {
      id: crypto.randomUUID(), schemaVersion: 3, date, status: "completed", startedAt, completedAt: new Date().toISOString(),
      model: modelName, scorerVersion: SCORER_VERSION,
      benchmarkIds: benchmark.map(item => item.id), validationSamples,
      baseline, holdoutBaseline, candidates: evaluated,
      accepted: Boolean(winner), selectedId: winner?.id ?? null,
      championVersion: champion.version, championScore: champion.score,
      strategyTrial: strategyResult.trial, strategyDecision: strategyResult.decision,
      reason: winner ? `${winner.id} 在开发集和新文章上均通过晋级门槛` : "所有候选未同时通过开发集与新文章验证；冠军保持不变"
    };
    const feedbackRecord = {
      date, candidates: evaluated.map(item => ({
        id: item.id, score: item.metrics.score,
        missing: item.metrics.missing, forbidden: item.metrics.forbidden
      }))
    };
    const next = {
      ...state, schemaVersion: 3, generation, champion,
      strategyGeneration: strategyResult.strategyGeneration, strategy: strategyResult.strategy,
      challenger: strategyResult.challenger,
      strategyHistory: [...state.strategyHistory, strategyResult.trial].slice(-30),
      feedbackHistory: [...state.feedbackHistory, feedbackRecord].slice(-10),
      latestRun: run,
      history: [...state.history, {
        date, generation, score: champion.score,
        holdoutScore: winner?.holdout.score ?? holdoutBaseline.score,
        accepted: Boolean(winner), focus: winner?.hypothesis ?? "保持冠军",
        strategy: strategyResult.strategy.version
      }].slice(-30),
      updatedAt: run.completedAt
    };
    await env.EVOLUTION.put(`${RUN_PREFIX}${date}`, JSON.stringify(run));
    await env.EVOLUTION.put(STATE_KEY, JSON.stringify(next));
    return { skipped: false, state: next };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const run = { id: crypto.randomUUID(), schemaVersion: 3, date, status: "failed", startedAt, completedAt: new Date().toISOString(), error: message };
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
  if (run?.schemaVersion === 3) throw new Error("V3 results include holdout validation and cannot be rescored without rerunning the experiment");
  if (run?.status !== "completed" || run.accepted) throw new Error("Only a completed, non-promoted legacy run may be rescored");
  const localDate = experimentDate(Date.parse(run.startedAt));
  if (run.scorerVersion === SCORER_VERSION && run.date === localDate) return { skipped: true, state };
  const baseline = run.scorerVersion === SCORER_VERSION ? run.baseline : rescoreMetrics(run.baseline);
  const candidates = run.candidates.map(item => {
    const metrics = run.scorerVersion === SCORER_VERSION ? item.metrics : rescoreMetrics(item.metrics);
    const eligible = metrics.forbidden.length === 0 && metrics.coverage >= baseline.coverage && metrics.score >= baseline.score + 2;
    return { ...item, metrics, eligible };
  });
  const winner = candidates.filter(item => item.eligible).sort((a, b) => b.metrics.score - a.metrics.score)[0];
  const generation = state.generation + (winner ? 1 : 0);
  const champion = winner ? { version: `v${generation}`, prompt: winner.prompt, score: winner.metrics.score } : { ...state.champion, score: baseline.score };
  const correctedRun = { ...run, date: localDate, scorerVersion: SCORER_VERSION, baseline, candidates,
    accepted: Boolean(winner), selectedId: winner?.id ?? null, championVersion: champion.version, championScore: champion.score,
    rescoredAt: new Date().toISOString(), reason: winner ? `${winner.id} 在旧版评分修正后晋级` : "旧版评分修正后仍无候选晋级" };
  const history = state.history.map(item => item.date === run.date
    ? { ...item, date: localDate, generation, score: champion.score, accepted: Boolean(winner) } : item);
  const next = { ...state, generation, champion, latestRun: correctedRun, history, updatedAt: correctedRun.rescoredAt };
  await env.EVOLUTION.put(`${RUN_PREFIX}${localDate}`, JSON.stringify(correctedRun));
  await env.EVOLUTION.put(STATE_KEY, JSON.stringify(next));
  return { skipped: false, state: next };
}

export function publicState(state) {
  return {
    schemaVersion: state.schemaVersion, generation: state.generation, champion: state.champion,
    strategy: state.strategy, challenger: state.challenger, strategyHistory: state.strategyHistory,
    latestRun: state.latestRun, history: state.history, updatedAt: state.updatedAt,
    benchmark: benchmark.map(({ id, title, article, anchors }) => ({ id, title, article, anchors: anchors.map(group => group[0]) })),
    scoring: "开发集：事实覆盖 60% + 四段格式 20% + 长度精简度 20%，禁用断言扣分；候选需提升至少 2 分。新文章验证：综合分和事实覆盖均不得下降，且禁用断言为零。挑战生成策略需在最多 3 次配对试验中赢 2 次才晋级。",
    holdoutPolicy: "每天按日期组合两篇新的参数化技术短文；候选与策略生成器均不接收当日验证文章，测试后完整公开。相同主题模板可能重复，因此仍需未来引入人工审校和独立真实文章。"
  };
}
