export function hasSnapshotEvidence(data) {
  const run = data?.latestRun;
  if (data?.schemaVersion !== 3 || run?.status !== "completed" || !Array.isArray(run.candidates) ||
      !Array.isArray(run.baseline?.outputs) || !Array.isArray(run.holdoutBaseline?.outputs) ||
      !Array.isArray(run.validationSamples) ||
      !run.candidates.every(item => Array.isArray(item.metrics?.outputs) && Array.isArray(item.holdout?.outputs))) {
    return false;
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
