// Change receipt: a compact record of what a run changed and what it can prove.
// Built from git facts and recorded check results, never from the model's own summary.

const STATUS_NAMES = Object.freeze({
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  "??": "untracked",
});
const NONE = "- none";
const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;
const SUMMARY_PATTERN = /^(Tests|Test Files)\s+\d/;
const SIGNAL_PATTERN = /(\bFAIL\b|\bpassed\b|\bfailed\b|\bexit\b)/i;

function statusName(code) {
  return STATUS_NAMES[code] || code;
}

// Picks the one line from a command's output that says what happened.
export function summarizeOutput(output) {
  const lines = output
    .replace(ANSI_PATTERN, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) return "";
  const reversed = [...lines].reverse();
  const summary = reversed.find((line) => SUMMARY_PATTERN.test(line));
  if (summary) return summary;
  const signal = reversed.find((line) => SIGNAL_PATTERN.test(line));
  return signal || lines[lines.length - 1];
}

export function parseStatusPorcelain(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const code = line.slice(0, 2).trim();
      return { status: statusName(code), path: line.slice(3) };
    });
}

function checkLines(checks) {
  if (checks.length === 0) return ["No checks were run; re-run with --verify."];
  return checks.map((c) => `- ${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.summary}`);
}

function changedLines(changed) {
  if (changed.length === 0) return [NONE];
  return changed.map((c) => `- ${c.status}: ${c.path}`);
}

function listOrNone(items) {
  return items.length === 0 ? [NONE] : items.map((item) => `- ${item}`);
}

function verifiedSection(checks) {
  const passed = checks.filter((c) => c.ok);
  if (passed.length === 0) return [NONE];
  return passed.map((c) => `- PASS ${c.name}: ${c.summary}`);
}

function failedSection(checks) {
  const failed = checks.filter((c) => !c.ok);
  if (failed.length === 0) return [NONE];
  return failed.map((c) => `- FAIL ${c.name}: ${c.summary}`);
}

export function buildReceipt({
  objective,
  branch,
  head,
  changed,
  diffStat,
  checks,
  decisions = [],
  unverified = [],
  approvalNeeded = [],
  generatedAt,
}) {
  const lines = [
    "# Change receipt",
    "",
    `Generated: ${generatedAt}`,
    `Branch: ${branch} @ ${head}`,
    "Commits made in this run: none",
    "",
    "## OBJECTIVE",
    objective,
    "",
    "## CHANGED",
    ...changedLines(changed),
    "",
    `${changed.length} uncommitted change(s).`,
    diffStat ? `\n${diffStat}` : "",
    "",
    "## VERIFIED",
    ...verifiedSection(checks),
    "",
    "## FAILED",
    ...failedSection(checks),
    "",
    "## NOT VERIFIED",
    ...checkLines(checks).filter((line) => !line.startsWith("- PASS") && !line.startsWith("- FAIL")),
    ...listOrNone(unverified),
    "",
    "## DECISIONS",
    ...listOrNone(decisions),
    "",
    "## APPROVAL NEEDED",
    ...listOrNone(approvalNeeded),
    "",
  ];
  return lines.join("\n");
}
