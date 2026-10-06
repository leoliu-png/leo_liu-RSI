import { summaryUnits } from "../src/evaluator.js";
export function judgmentFor(sample, summary, wrong = false) {
  const units = summaryUnits(summary);
  return {
    units: units.map((unit, index) => ({ id: unit.id, verdict: wrong && index === 0 ? "contradicted" : "supported",
      sourceIds: [sample.sources[0].id], reason: wrong && index === 0 ? "与原文不符" : "测试桩：有依据" })),
    facts: sample.facts.map(fact => ({ id: fact.id, status: "covered", unitIds: [units[0].id], quote: units[0].text, reason: "测试桩：已覆盖" })),
    constraints: sample.constraints.map(item => ({ id: item.id, status: "preserved", unitIds: [units[0].id], quote: units[0].text, reason: "测试桩：已保留" })),
    clarity: { clear: true, nonRedundant: true, reason: "测试桩：清晰" }
  };
}
