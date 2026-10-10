export function hasSnapshotEvidence(data) {
  const run = data?.latestRun;
  if (![3, 4].includes(data?.schemaVersion) || run?.status !== "completed" || !Array.isArray(run.candidates) ||
      !Array.isArray(run.baseline?.outputs) || !Array.isArray(run.holdoutBaseline?.outputs) ||
      !Array.isArray(run.validationSamples) ||
      !run.candidates.every(item => Array.isArray(item.metrics?.outputs) && Array.isArray(item.holdout?.outputs))) {
    return false;
  }
  if (data.schemaVersion === 4) {
    if (data.modelProfile && (run.modelProfile !== data.modelProfile || (data.model && run.model !== data.model) ||
        (data.evaluator && run.evaluator?.model !== data.evaluator.model) || run.calibration?.model !== run.evaluator?.model ||
        run.calibration?.version !== run.evaluator?.version)) return false;
    const auditComplete = !run.audit?.status || run.audit.status === "completed";
    const auditWarning = run.coreStatus === "completed" && ["pending", "failed"].includes(run.audit?.status) &&
      run.audit.purpose === "report-only; excluded from optimization and promotion" && run.audit.metrics === null &&
      (run.audit.status === "pending" || typeof run.audit.error === "string");
    if (run.scorerVersion !== 4 || !run.evaluator?.model || !run.calibration?.passed ||
        !Array.isArray(run.developmentSamples) || (!auditComplete && !auditWarning) ||
        (auditComplete && !Array.isArray(run.audit?.metrics?.outputs))) return false;
    const pairs = [[run.baseline, run.developmentSamples], [run.holdoutBaseline, run.validationSamples],
      ...run.candidates.flatMap(item => [[item.metrics, run.developmentSamples], [item.holdout, run.validationSamples]]),
      ...(auditComplete ? [[run.audit.metrics, run.audit.samples]] : [])];
    if (!pairs.every(([metrics, samples]) => Array.isArray(samples) && metrics.outputs.length === samples.length &&
      metrics.outputs.every(output => output.scorerVersion === 4 && output.dimensions && output.sources?.length &&
        output.judgment?.units?.length && output.judgment.facts?.length && output.judgment.constraints?.length &&
        samples.some(sample => sample.id === output.sampleId)))) return false;
  }
  if (run.candidates.length === 2 && run.strategyTrial) return true;
  if (run.candidates.length === 2 && run.outcome === "fallback_candidates" && run.strategyTrial === null &&
      run.candidates.some(item => item.source === "guardrail_fallback") &&
      Array.isArray(run.candidateGeneration?.results) && run.candidateGeneration.results.length === 2 &&
      run.candidateGeneration.results.some(item => item.fallbackUsed)) return true;
  const expectedOutcome = run.candidates.length === 1 ? "partial_candidates" : "generation_exhausted";
  if (run.outcome !== expectedOutcome || run.strategyTrial !== null ||
      !Array.isArray(run.candidateGeneration?.results) || run.candidateGeneration.results.length !== 2 ||
      !run.candidateGeneration.results.every(item => Number.isInteger(item.attempts) && Array.isArray(item.rejected))) {
    return false;
  }
  return run.candidates.length === 1 || run.accepted === false;
}
