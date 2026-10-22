export function statusReport(data, now = Date.now(), previous = {}) {
  const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
  const run = data.latestRun?.date === date ? data.latestRun : null;
  const job = data.automation?.date === date ? data.automation : null;
  const terminal = ["blocked", "exhausted", "missed"].includes(job?.status);
  const missing = !run && !job && now >= Date.parse(`${date}T09:30:00+08:00`);
  const auditComplete = !run?.audit?.status || run.audit.status === "completed";
  const completed = run?.status === "completed" && auditComplete && (!job || job.status === "completed");
  const finalFailure = terminal || missing || (run?.status === "failed" && run.retryable === false);
  const experimentStatus = finalFailure ? (missing ? "missing" : run?.status === "completed" ? "audit_failed" : "failed")
    : completed ? "completed" : run?.status === "completed" ? "audit_pending" : !run && !job ? "not_started" : "pending";
  const code = missing ? "missing_daily_run" : job?.code || run?.code || (terminal ? "execution_stopped" : "");
  const stage = run?.progress?.stage || "scheduler";
  const fingerprint = finalFailure ? JSON.stringify([date, data.modelProfile || "unknown", run?.id || "no-run", stage, code]) : null;
  const prior = previous.archive || previous;
  const notifiedFailures = prior.date === date && Array.isArray(prior.notifiedFailures) ? [...prior.notifiedFailures] : [];
  // Old status files already produced failure emails before deduplication existed.
  if (prior.date === date && prior.finalFailure && !Array.isArray(prior.notifiedFailures) && previous.latestRun) {
    const oldRun = previous.latestRun, oldJob = previous.automation;
    const oldKey = JSON.stringify([date, previous.modelProfile || "unknown", oldRun.id || "no-run",
      oldRun.progress?.stage || "scheduler", oldJob?.code || oldRun.code || "execution_stopped"]);
    notifiedFailures.push({ fingerprint: oldKey, firstReportedAt: prior.checkedAt, workflowUrl: null, migratedLegacyAlert: true });
  }
  const notify = finalFailure && !notifiedFailures.some(item => item.fingerprint === fingerprint);
  const notification = notify ? { fingerprint, firstReportedAt: new Date(now).toISOString(),
    workflowUrl: process.env.GITHUB_RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null } : null;
  return { date, checkedAt: new Date(now).toISOString(), kind: completed ? "successful-experiment" : "operational-status-not-successful-experiment",
    experimentStatus, freshMeasurement: Boolean(completed), finalFailure, code, stage, fingerprint, notify,
    duplicateAlert: finalFailure && !notify, error: missing ? "No daily execution after the 09:30 CST startup grace period" : job?.error || run?.error || null,
    notifiedFailures: [...notifiedFailures, ...(notification ? [notification] : [])].slice(-32) };
}

export function statusSummary(report, data) {
  const labels = { completed: "完整实验已完成", failed: "实验失败（未恢复）", missing: "每日任务未启动",
    audit_failed: "主实验完成，但审计失败", audit_pending: "主实验完成，审计待完成", not_started: "今日尚未开始", pending: "正在运行或等待续跑" };
  const safe = value => String(value ?? "—").replace(/[\r\n|]/g, " ").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `## RSI：${labels[report.experimentStatus]}\n\n` +
    `代码检查通过或归档检查通过，不等于真实实验已完成。\n\n` +
    `| 日期 | 真实实验状态 | 最新测量日期 | 完整新结果 |\n| --- | --- | --- | --- |\n` +
    `| ${report.date} | ${labels[report.experimentStatus]} | ${safe(data.latestRun?.date)} | ${report.freshMeasurement ? "是" : "否"} |\n\n` +
    (report.error ? `原因：${safe(report.error)}\n\n` : "") +
    (report.duplicateAlert ? "相同故障已告警；本次继续保存失败证据，不重复发送失败提醒，也不将实验标为成功。\n" : "");
}
