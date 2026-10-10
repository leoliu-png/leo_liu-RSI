import { benchmark, initialPrompt, modelName } from "./benchmark.js";
import { auditCorpus, DATASET_VERSION, developmentCorpus, developmentForDate, validationCorpus, validationForDate } from "./corpus.js";
import { calibrateEvaluator, createEvaluationContext, DEFAULT_JUDGE_MODEL, EVALUATOR_VERSION, judgeSummary, RUBRIC, SCORER_VERSION } from "./evaluator.js";
import { MODEL_PROFILE, MODEL_SUPPORTS_SEED, OPENROUTER_BASE_URL, PREVIOUS_STATE_KEYS } from "./model.js";
import { createModelClient, redactError } from "./openrouter.js";

export const STATE_KEY = `rsi:v4:${MODEL_PROFILE}:state`;
export const RUN_PREFIX = `rsi:v4:${MODEL_PROFILE}:run:`;
const HEADINGS = ["结论", "要点", "风险", "术语"];
const MAX_CANDIDATE_ATTEMPTS = 3;
const FALLBACK_RULES = {
  C1: [
    ["facts_scope", "逐条核对要点中的数字、对象和适用条件；缺少任何一项时，不把局部结果写成普遍结论。"],
    ["facts_negation", "优先保留原文中的否定、例外和限制词；不得把可能、计划或假设改写成已发生的事实。"],
    ["facts_source", "每条要点先找到原文中的直接依据；找不到对应语句的判断必须删除，不用常识补全。"],
    ["facts_relation", "遇到比较或因果关系时，只保留原文明确建立的关系；不得自行推断原因、优势或影响。"],
    ["facts_quantity", "原文有比例、时间或数量时，同时保留计量对象和单位；不要只摘录孤立数字。"],
    ["facts_priority", "先覆盖结论所依赖的关键证据，再写背景信息；同一事实只出现一次，避免背景挤占要点。"],
    ["facts_attribution", "区分作者观点、实验观察和已证实事实；将观点归于原文作者，不改写成无条件事实。"],
    ["facts_boundary", "摘要中的范围、时间和人群必须与原文一致；不能将单次实验或局部样本扩展到全部场景。"]
  ],
  C2: [
    ["risk_evidence", "风险段区分已观察到的问题与潜在风险；原文只提出可能性时，不得写成已经发生。"],
    ["risk_absence", "原文没有明确风险或限制时，风险段写原文未说明；不要依据行业常识自行补充。"],
    ["term_context", "术语段仅解释原文定义或上下文能直接核对的含义；外部百科知识不得加入。"],
    ["term_ambiguity", "术语有多种可能含义时，只采用文章上下文支持的含义；证据不足写原文未说明。"],
    ["brevity_duplicate", "输出前删除四段之间重复的事实；保留数字、名称和限定词，再压缩连接词与套话。"],
    ["brevity_structure", "结论仅保留一个中心判断；要点各写一个可核查事实，风险和术语不重复结论内容。"],
    ["risk_condition", "风险段写清触发限制的前提和影响范围；原文未给出前提或范围时不要猜测。"],
    ["term_first_use", "只解释摘要中实际出现且影响理解的技术术语；不为未出现的概念额外造定义。"]
  ]
};
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
    schemaVersion: 4,
    modelProfile: MODEL_PROFILE,
    scorerVersion: SCORER_VERSION,
    generation: 0,
    champion: { version: "v0", prompt: initialPrompt, score: null, scorerVersion: SCORER_VERSION },
    strategyGeneration: 0,
    strategy: { ...INITIAL_STRATEGY },
    challenger: null,
    strategyHistory: [],
    feedbackHistory: [],
    recentCandidatePrompts: [],
    seenCandidateKeys: [],
    latestRun: null,
    history: [],
    lastAudit: null,
    updatedAt: null
  };
}

export function extractText(response) {
  if (typeof response === "string") return response.trim();
  if (typeof response?.response === "string") return response.response.trim();
  if (typeof response?.response?.content === "string") return response.response.content.trim();
  if (typeof response?.choices?.[0]?.message?.content === "string") return response.choices[0].message.content.trim();
  throw new Error("Model returned no text");
}

function clean(text) {
  return text.normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase();
}

function meaningfulText(text) {
  return clean(text).replace(/[^\p{L}\p{N}]/gu, "");
}

function editDistance(a, b) {
  const left = Array.from(meaningfulText(a));
  const right = Array.from(meaningfulText(b));
  let row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const next = [i];
    for (let j = 1; j <= right.length; j++) {
      next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[right.length];
}

function hasSubstantiveChange(prompt, reference) {
  const threshold = Math.max(24, Math.ceil(Math.min(meaningfulText(prompt).length, meaningfulText(reference).length) * 0.12));
  return editDistance(prompt, reference) >= threshold;
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
  if (!records.length && state.latestRun?.status === "completed" && state.latestRun.scorerVersion === SCORER_VERSION) {
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
      { role: "system", content: "你研究如何更有效地产生技术摘要提示词候选。只返回 JSON，不能改变摘要任务、评分规则或候选必须忠于原文的约束。" },
      { role: "user", content: `当前生成策略：\n${state.strategy.instruction}\n\n最近开发集失败证据：\n${historicalFeedback(state)}\n\n提出一条不同且可检验的生成候选策略，重点解决多轮反复出现的问题。只返回 {"hypothesis":"为什么这条策略会更好","instruction":"给候选提示词生成器的具体操作指令"}。不要请求或猜测未公开验证文章。` }
    ],
    max_tokens: 650,
    temperature: 0.65
  });
  const challenger = parseStrategy(extractText(response));
  if (challenger.instruction === state.strategy.instruction) throw new Error("Strategy proposal did not change");
  return challenger;
}

async function generateCandidate(ai, champion, strategy, feedback, id, excludedPrompts = [], focus = "事实、条件和证据核对") {
  const exclusions = excludedPrompts.length
    ? `\n\n以下候选已经存在或因重复被拒绝，新的完整提示词不得与其中任何一条相同（仅改变空格也不算新候选）：\n${excludedPrompts.map((prompt, index) => `${index + 1}. ${prompt}`).join("\n")}`
    : "";
  const response = await ai.run(modelName, {
    messages: [
      { role: "system", content: `你负责改进技术文章的四段式中文摘要提示词。只返回有效 JSON。必须保留四段标题、忠于原文和禁止编造要求。\n候选生成策略：${strategy.instruction}` },
      { role: "user", content: `当前冠军提示词：\n${champion}\n\n最近开发集失败证据：\n${feedback}${exclusions}\n\n今天两种策略使用相同修改方向：${focus}。请按自己的生成策略解决开发集具体失败；不要堆叠泛泛的核对要求。必须增加、删除或替换一条可执行的摘要行为规则；只换同义词、标点或措辞不算修改。只提出一个完整候选，并清楚写出行为变化。格式：{"hypothesis":"可检验的行为变化","prompt":"完整提示词"}。不得加入任何未公开验证文章的信息。` }
    ],
    max_tokens: 1200,
    temperature: 0.7
  });
  return parseCandidate(extractText(response), id, strategy.version || `trial-${strategy.id.slice(0, 8)}`);
}

function fallbackCandidate(champion, id, occupied, sameDayPrompt) {
  const base = champion.replace(/\n补充核验规则：[^\n]*$/, "").trim();
  const rules = FALLBACK_RULES[id];
  const plans = [
    ...rules.map(rule => [rule]),
    ...rules.flatMap((rule, index) => rules.slice(index + 1).map(other => [rule, other]))
  ];
  for (const plan of plans) {
    if (plan.some(([, text]) => clean(base).includes(clean(text)))) continue;
    const prompt = `${base}\n补充核验规则：${plan.map(([, text]) => text).join(" ")}`;
    if (prompt.length > 1200 || occupied.has(clean(prompt)) ||
        !hasSubstantiveChange(prompt, champion) ||
        (sameDayPrompt && !hasSubstantiveChange(prompt, sameDayPrompt))) continue;
    return {
      id, strategyVersion: "rules-v1", prompt,
      hypothesis: `增加可核验的摘要步骤：${plan.map(([, text]) => text).join(" ").slice(0, 145)}`,
      source: "guardrail_fallback", interventionIds: plan.map(([name]) => name)
    };
  }
  return null;
}

async function generateUniqueCandidate(ai, champion, strategy, feedback, id, occupiedPrompts, seenKeys, sameDayPrompt = null, focus) {
  const excluded = [...occupiedPrompts];
  const occupied = new Set([...excluded.map(clean), ...seenKeys]);
  const rejected = [];
  for (let attempt = 1; attempt <= MAX_CANDIDATE_ATTEMPTS; attempt++) {
    const candidate = await generateCandidate(ai, champion, strategy, feedback, id, excluded, focus);
    const normalized = clean(candidate.prompt);
    const reason = occupied.has(normalized) ? "与冠军、历史候选或当日已接受候选重复"
      : !hasSubstantiveChange(candidate.prompt, champion) ? "与冠军相比改动过小，缺少可检验的新行为规则"
      : sameDayPrompt && !hasSubstantiveChange(candidate.prompt, sameDayPrompt) ? "与当日已有候选改动过近" : null;
    if (!reason) return { candidate: { ...candidate, source: "model" }, attempts: attempt, rejected, fallbackUsed: false };
    rejected.push({ attempt, reason, prompt: candidate.prompt });
    excluded.push(candidate.prompt);
    occupied.add(normalized);
  }
  const fallback = fallbackCandidate(champion, id, occupied, sameDayPrompt);
  return { candidate: fallback, attempts: MAX_CANDIDATE_ATTEMPTS, rejected, fallbackUsed: Boolean(fallback) };
}

async function runPrompt(context, prompt, samples) {
  const outputs = await Promise.all(samples.map(async sample => {
    const response = await context.ai.run(modelName, {
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: `请根据下文完成任务。只输出摘要。\n\n${sample.article}` }
      ],
      max_tokens: 800,
      temperature: 0,
      seed: 42
    });
    const summary = extractText(response);
    return { sampleId: sample.id, title: sample.title, summary, sources: sample.sources,
      ...await judgeSummary(context, sample, summary) };
  }));
  return aggregateOutputs(outputs);
}

function aggregateOutputs(outputs) {
  const semantic = outputs.every(item => item.scorerVersion === SCORER_VERSION);
  const dimensions = semantic ? Object.fromEntries(Object.keys(RUBRIC).map(key => [key,
    Number((outputs.reduce((sum, item) => sum + item.dimensions[key], 0) / outputs.length).toFixed(2))])) : undefined;
  return {
    scorerVersion: semantic ? SCORER_VERSION : 3,
    score: Number((outputs.reduce((sum, item) => sum + item.score, 0) / outputs.length).toFixed(1)),
    coverage: Number((outputs.reduce((sum, item) => sum + item.coverage, 0) / outputs.length).toFixed(3)),
    format: Number((outputs.reduce((sum, item) => sum + item.format, 0) / outputs.length).toFixed(3)),
    characters: Math.round(outputs.reduce((sum, item) => sum + item.characters, 0) / outputs.length),
    accuracy: semantic ? Number((outputs.reduce((sum, item) => sum + item.accuracy, 0) / outputs.length).toFixed(3)) : undefined,
    constraintPreservation: semantic ? Number((outputs.reduce((sum, item) => sum + item.constraintPreservation, 0) / outputs.length).toFixed(3)) : undefined,
    eligible: semantic ? outputs.every(item => item.eligible) : undefined,
    hardFailure: outputs.some(item => item.hardFailure), dimensions,
    errors: outputs.flatMap(item => (item.errors || []).map(error => ({ sampleId: item.sampleId, title: item.title, ...error }))),
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
  if (![2, 3, 4].includes(stored?.schemaVersion)) return fresh;
  return {
    ...fresh, generation: stored.generation,
    champion: { ...stored.champion, score: null, scorerVersion: SCORER_VERSION },
    strategy: stored.strategy || fresh.strategy,
    strategyGeneration: stored.strategyGeneration || 0,
    recentCandidatePrompts: stored.recentCandidatePrompts || [], seenCandidateKeys: stored.seenCandidateKeys || [],
    legacyBaseline: { schemaVersion: stored.schemaVersion, championVersion: stored.champion.version, score: stored.champion.score,
      runId: stored.latestRun?.id, model: stored.latestRun?.model, evaluator: stored.latestRun?.evaluator,
      modelProfile: stored.modelProfile || "legacy-workers-ai" },
    history: (stored.history || []).map(item => ({ ...item, scorerVersion: item.scorerVersion || 3,
      modelProfile: item.modelProfile || stored.modelProfile || "legacy-workers-ai" })), updatedAt: stored.updatedAt
  };
}

export async function getState(env) {
  const stored = await env.EVOLUTION.get(STATE_KEY, "json");
  if (stored?.schemaVersion === 4 && stored.modelProfile === MODEL_PROFILE) return stored;
  if (stored) return migrateLegacy(stored);
  for (const key of PREVIOUS_STATE_KEYS) {
    const previous = await env.EVOLUTION.get(key, "json");
    if (previous) return migrateLegacy(previous);
  }
  return initialState();
}

export function promotionDecision(candidate, baseline, holdoutBaseline) {
  if (candidate.metrics.scorerVersion === SCORER_VERSION) {
    if (!candidate.metrics.eligible) return { eligible: false, reason: "开发集存在事实错误、编造或格式/长度不合规" };
    if (!candidate.holdout.eligible) return { eligible: false, reason: "隔离验证文章存在事实错误、编造或格式/长度不合规" };
    if (candidate.metrics.accuracy < baseline.accuracy || candidate.metrics.constraintPreservation < baseline.constraintPreservation ||
        candidate.holdout.accuracy < holdoutBaseline.accuracy || candidate.holdout.constraintPreservation < holdoutBaseline.constraintPreservation) {
      return { eligible: false, reason: "事实准确性或条件保留下降" };
    }
  }
  if (candidate.metrics.forbidden.length) return { eligible: false, reason: "开发集出现禁用断言" };
  if (candidate.metrics.coverage < baseline.coverage) return { eligible: false, reason: "开发集事实覆盖下降" };
  if (candidate.metrics.score < baseline.score + 2) return { eligible: false, reason: "开发集综合分提升不足 2 分" };
  if (candidate.holdout.forbidden.length) return { eligible: false, reason: "新验证文章出现禁用断言，回退" };
  if (candidate.holdout.coverage < holdoutBaseline.coverage) return { eligible: false, reason: "新验证文章事实覆盖下降，回退" };
  if (candidate.holdout.score < holdoutBaseline.score) return { eligible: false, reason: "新验证文章综合分下降，回退" };
  return { eligible: true, reason: "开发集提升至少 2 分，且新验证文章无退步" };
}

export function challengerBeatsIncumbent(current, challenger) {
  if (challenger.metrics.scorerVersion === SCORER_VERSION && (!challenger.metrics.eligible || !challenger.holdout.eligible ||
      challenger.metrics.accuracy < current.metrics.accuracy || challenger.holdout.accuracy < current.holdout.accuracy ||
      challenger.metrics.constraintPreservation < current.metrics.constraintPreservation ||
      challenger.holdout.constraintPreservation < current.holdout.constraintPreservation)) return false;
  return challenger.metrics.score >= current.metrics.score + 2 &&
    challenger.holdout.score >= current.holdout.score + 1 &&
    challenger.metrics.coverage >= current.metrics.coverage &&
    challenger.holdout.coverage >= current.holdout.coverage &&
    challenger.metrics.forbidden.length === 0 && challenger.holdout.forbidden.length === 0;
}

export function updateStrategyTrial(state, date, current, candidate) {
  if (current.focus !== candidate.focus) throw new Error("Strategy candidates used different intervention directions");
  const challenger = state.challenger;
  const challengerWon = challengerBeatsIncumbent(current, candidate);
  const trial = {
    date, scorerVersion: SCORER_VERSION, focus: current.focus, incumbent: state.strategy.version, challengerId: challenger.id,
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

export function developmentFeedback(metrics, samples) {
  return {
    score: metrics.score, dimensions: metrics.dimensions, accuracy: metrics.accuracy,
    coverage: metrics.coverage, constraintPreservation: metrics.constraintPreservation, characters: metrics.characters,
    samples: metrics.outputs.map(output => {
      const sample = samples.find(item => item.id === output.sampleId);
      return { id: output.sampleId, score: output.score, dimensions: output.dimensions,
        issues: [
          ...output.errors.slice(0, 3).map(error => ({ summary: error.text, problem: error.reason, evidence: error.evidence })),
          ...output.judgment.facts.filter(row => ["partial", "omitted"].includes(row.status)).slice(0, 2).map(row => ({
            problem: row.reason, missingFact: sample.facts.find(fact => fact.id === row.id).text,
            evidence: sample.facts.find(fact => fact.id === row.id).evidenceIds.map(id => sample.sources.find(source => source.id === id)) })),
          ...output.judgment.constraints.filter(row => row.status === "omitted").slice(0, 2).map(row => ({ problem: row.reason,
            missingCondition: sample.constraints.find(item => item.id === row.id).text }))
        ] };
    })
  };
}

export async function runEvolution(env, timestamp = Date.now(), modelClient = createModelClient(env)) {
  const date = experimentDate(timestamp);
  const state = await getState(env);
  if (state.latestRun?.date === date && state.latestRun.status === "completed") return { skipped: true, state };
  const startedAt = new Date().toISOString();
  const context = createEvaluationContext(modelClient, DEFAULT_JUDGE_MODEL);
  let calibration = null;
  try {
    calibration = await calibrateEvaluator(context, env.EVOLUTION);
    if (!calibration.passed) throw new Error(`Evaluator calibration rejected: ${calibration.results.filter(item => !item.passed).map(item => item.id).join(", ")}`);
    const developmentSamples = developmentForDate(date);
    const validationSamples = validationForDate(date);
    const [baseline, holdoutBaseline] = await Promise.all([
      runPrompt(context, state.champion.prompt, developmentSamples),
      runPrompt(context, state.champion.prompt, validationSamples)
    ]);
    const baselineFeedback = developmentFeedback(baseline, developmentSamples);
    const proposalState = { ...state, feedbackHistory: [...state.feedbackHistory,
      { date, baseline: baselineFeedback, instruction: "基于具体错误或遗漏改进；分项已满分时不要重复添加相同要求" }] };
    const challenger = state.challenger || await generateStrategy(context.ai, proposalState);
    const workingState = { ...state, challenger };
    const feedback = historicalFeedback(proposalState);
    const focus = ["事实、数字、否定及适用条件", "信息完整性和术语/风险边界", "跨段重复与表达清晰度"]
      [Math.floor(Date.parse(`${date}T00:00:00Z`) / 86400000) % 3];
    const occupiedPrompts = [state.champion.prompt, ...(state.recentCandidatePrompts || []).slice(-10)];
    const seenKeys = state.seenCandidateKeys || [];
    const first = await generateUniqueCandidate(context.ai, state.champion.prompt, state.strategy, feedback, "C1", occupiedPrompts, seenKeys, null, focus);
    const second = await generateUniqueCandidate(context.ai, state.champion.prompt, challenger, feedback, "C2",
      first.candidate ? [...occupiedPrompts, first.candidate.prompt] : occupiedPrompts,
      seenKeys, first.candidate?.prompt, focus);
    const candidates = [first.candidate, second.candidate].filter(Boolean);
    const candidateGeneration = {
      maxAttemptsPerCandidate: MAX_CANDIDATE_ATTEMPTS,
      results: [
        { id: "C1", strategyVersion: first.candidate?.strategyVersion || state.strategy.version, attempts: first.attempts, accepted: Boolean(first.candidate), fallbackUsed: first.fallbackUsed, rejected: first.rejected },
        { id: "C2", strategyVersion: second.candidate?.strategyVersion || challenger.version || `trial-${challenger.id.slice(0, 8)}`, attempts: second.attempts, accepted: Boolean(second.candidate), fallbackUsed: second.fallbackUsed, rejected: second.rejected }
      ]
    };
    const evaluated = [];
    for (const item of candidates) {
      const [metrics, holdout] = await Promise.all([
        runPrompt(context, item.prompt, developmentSamples),
        runPrompt(context, item.prompt, validationSamples)
      ]);
      const result = promotionDecision({ metrics, holdout }, baseline, holdoutBaseline);
      evaluated.push({ ...item, focus, metrics, holdout, ...result });
    }
    const winner = evaluated.filter(item => item.eligible)
      .sort((a, b) => b.metrics.score - a.metrics.score || b.holdout.score - a.holdout.score)[0];
    const generation = state.generation + (winner ? 1 : 0);
    const champion = winner
      ? { version: `v${generation}`, prompt: winner.prompt, score: winner.metrics.score, scorerVersion: SCORER_VERSION }
      : { ...state.champion, score: baseline.score, scorerVersion: SCORER_VERSION };
    const pairedModelCandidates = evaluated.length === 2 && evaluated.every(item => item.source === "model");
    const strategyResult = pairedModelCandidates
      ? updateStrategyTrial(workingState, date, evaluated[0], evaluated[1])
      : {
          trial: null, strategy: state.strategy, challenger: null, strategyGeneration: state.strategyGeneration,
          decision: evaluated.length === 2
            ? "模型候选不足，使用预定义核验规则补位；不把补位成绩计入挑战策略胜负"
            : "候选去重及核验规则补位后仍不足两条；不计策略胜负，回退未完成配对的挑战策略"
        };
    const outcome = pairedModelCandidates ? "evaluated" : evaluated.length === 2 ? "fallback_candidates"
      : evaluated.length === 1 ? "partial_candidates" : "generation_exhausted";
    const audit = state.lastAudit?.championVersion === champion.version && state.lastAudit?.scorerVersion === SCORER_VERSION && state.lastAudit?.modelProfile === MODEL_PROFILE
      ? state.lastAudit : { championVersion: champion.version, scorerVersion: SCORER_VERSION, modelProfile: MODEL_PROFILE,
          checkedAt: new Date().toISOString(), purpose: "report-only; excluded from optimization and promotion",
          samples: auditCorpus, metrics: await runPrompt(context, champion.prompt, auditCorpus) };
    const run = {
      id: crypto.randomUUID(), schemaVersion: 4, date, status: "completed", startedAt, completedAt: new Date().toISOString(),
      model: modelName, modelProfile: MODEL_PROFILE, provider: "OpenRouter", scorerVersion: SCORER_VERSION,
      evaluator: { model: context.model, version: EVALUATOR_VERSION, rubric: RUBRIC }, datasetVersion: DATASET_VERSION,
      calibration, usage: context.usage, audit,
      strategyContext: { focus, maxAttempts: MAX_CANDIDATE_ATTEMPTS, evaluationSeed: MODEL_SUPPORTS_SEED ? 42 : null,
        seedSupported: MODEL_SUPPORTS_SEED, evaluationTemperature: 0 },
      benchmarkIds: developmentSamples.map(item => item.id), developmentSamples, validationSamples,
      baseline, holdoutBaseline, candidates: evaluated, candidateGeneration, outcome,
      accepted: Boolean(winner), selectedId: winner?.id ?? null,
      championVersion: champion.version, championScore: champion.score,
      strategyTrial: strategyResult.trial, strategyDecision: strategyResult.decision,
      reason: winner ? `${winner.id} 在开发集和新文章上均通过晋级门槛${pairedModelCandidates ? "" : "；策略配对未完成或未计分"}`
        : outcome === "generation_exhausted" ? "模型和核验规则库均未得到有效新 Prompt；仅完成冠军基线测评，冠军保持不变"
        : outcome === "partial_candidates" ? "仅一条实质不同候选通过验证；未完成策略配对，冠军保持不变"
        : outcome === "fallback_candidates" ? "已用核验规则补齐两条实质不同候选，但均未通过晋级门槛；冠军保持不变"
        : "所有候选未同时通过开发集与新文章验证；冠军保持不变"
    };
    const feedbackRecord = {
      date, baseline: baselineFeedback, candidates: evaluated.map(item => ({
        id: item.id, hypothesis: item.hypothesis, improvement: Number((item.metrics.score - baseline.score).toFixed(1)),
        development: developmentFeedback(item.metrics, developmentSamples)
      })), rejectedCandidates: candidateGeneration.results.map(item => ({ id: item.id, attempts: item.attempts, rejected: item.rejected.length }))
    };
    const next = {
      ...state, schemaVersion: 4, scorerVersion: SCORER_VERSION, generation, champion, lastAudit: audit,
      strategyGeneration: strategyResult.strategyGeneration, strategy: strategyResult.strategy,
      challenger: strategyResult.challenger,
      strategyHistory: strategyResult.trial ? [...state.strategyHistory, strategyResult.trial].slice(-30) : state.strategyHistory,
      feedbackHistory: [...state.feedbackHistory, feedbackRecord].slice(-10),
      recentCandidatePrompts: [...(state.recentCandidatePrompts || []), ...evaluated.map(item => item.prompt)].slice(-10),
      seenCandidateKeys: [...seenKeys, ...evaluated.map(item => clean(item.prompt))],
      latestRun: run,
      history: [...state.history, {
        date, scorerVersion: SCORER_VERSION, modelProfile: MODEL_PROFILE, generation, score: champion.score,
        holdoutScore: winner?.holdout.score ?? holdoutBaseline.score,
        accepted: Boolean(winner), focus: winner?.hypothesis ?? (outcome === "evaluated" ? "保持冠军" : "补位候选未晋级"),
        strategy: strategyResult.strategy.version
      }].slice(-30),
      updatedAt: run.completedAt
    };
    await env.EVOLUTION.put(`${RUN_PREFIX}${date}`, JSON.stringify(run));
    await env.EVOLUTION.put(STATE_KEY, JSON.stringify(next));
    return { skipped: false, state: next };
  } catch (error) {
    await context.cancel();
    const message = redactError(error instanceof Error ? error.message : String(error), env.OPENROUTER_API_KEY);
    const run = { id: crypto.randomUUID(), schemaVersion: 4, scorerVersion: SCORER_VERSION, date, status: "failed", startedAt,
      completedAt: new Date().toISOString(), model: modelName, modelProfile: MODEL_PROFILE, provider: "OpenRouter", evaluator: { model: context.model, version: EVALUATOR_VERSION },
      calibration, usage: context.usage, error: message };
    const next = { ...state, latestRun: run, updatedAt: run.completedAt };
    await env.EVOLUTION.put(`${RUN_PREFIX}${date}`, JSON.stringify(run));
    await env.EVOLUTION.put(STATE_KEY, JSON.stringify(next));
    console.error(JSON.stringify({ message: "evolution_failed", date, error: message }));
    throw error;
  }
}

export async function rescoreLatest() {
  throw new Error("V4 requires fresh semantic evaluation; legacy outputs cannot be relabeled as V4");
}

export function publicState(state) {
  return {
    schemaVersion: state.schemaVersion, scorerVersion: SCORER_VERSION,
    model: modelName, modelProfile: MODEL_PROFILE, provider: "OpenRouter", baseUrl: OPENROUTER_BASE_URL,
    generation: state.generation, champion: state.champion, legacyBaseline: state.legacyBaseline || null,
    strategy: state.strategy, challenger: state.challenger, strategyHistory: state.strategyHistory,
    latestRun: state.latestRun, history: state.history, updatedAt: state.updatedAt,
    evaluator: { model: state.latestRun?.evaluator?.model || DEFAULT_JUDGE_MODEL, version: EVALUATOR_VERSION, rubric: RUBRIC },
    dataset: { version: DATASET_VERSION, development: developmentCorpus.length, validation: validationCorpus.length,
      audit: auditCorpus.length, reviewStatus: "author-curated; awaiting independent human review" },
    benchmark: (state.latestRun?.developmentSamples || developmentCorpus).map(({ id, title, article, facts }) =>
      ({ id, title, article, anchors: facts.map(fact => fact.text) })),
    scoring: "固定语义评委核验原文证据，脚本按事实准确性40、信息完整性25、条件与范围20、表达10、格式5计算分数。任何矛盾或无依据断言将否决晋级并把单篇总分封顶49。80—450字是约束，不奖励越短越好。开发集需提升至少2分，隔离验证不得退步。策略需同焦点配对，最多3次试验中胜出2次。",
    holdoutPolicy: "从独立的6篇人工编写（尚待独立人工审校）文章池每天轮换2篇；它们不是每天新采集的文章，三天后会重复。提案模型只收到开发集失败证据，不接收验证/审计内容。另3篇审计文章只报告冠军效果，不用于优化或晋级。"
  };
}
