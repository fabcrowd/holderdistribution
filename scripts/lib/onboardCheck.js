/**
 * The local gates for an onboarded project, in the order they run (strictly one
 * after another: vitest beside typecheck/lint times out the spawn tests), and
 * the PASS/FAIL table printed at the end. Pure; scripts/onboard-check.js runs them.
 */

/** @returns {Array<{id: string, cmd: string, args: string[]}>} */
export function gatePlan({ slug, skipTests = false }) {
  const gates = [
    { id: "vitest", cmd: "npx", args: ["vitest", "run"], tests: true },
    { id: "typecheck", cmd: "npm", args: ["run", "typecheck"], tests: true },
    { id: "lint", cmd: "npm", args: ["run", "lint"], tests: true },
    { id: "feed-consistency", cmd: "node", args: ["scripts/check-feed-consistency.js", "--all", "--strict"] },
    { id: "pipeline-health", cmd: "node", args: ["scripts/pipeline-health.js"] },
    { id: "go-live", cmd: "node", args: ["scripts/check-go-live.js", "--project", slug, "--alignment", "strict"] },
  ];
  return gates.filter((g) => !(skipTests && g.tests)).map(({ id, cmd, args }) => ({ id, cmd, args }));
}

export const logPathFor = (slug, id) => `tasks/onboard-check-${slug}-${id}.log`;

/** @param {Array<{id: string, status: number|null, log: string}>} results */
export function summarize(results) {
  const failed = results.filter((r) => r.status !== 0);
  const width = Math.max(4, ...results.map((r) => r.id.length));
  const lines = results.map((r) => `${r.status === 0 ? "PASS" : "FAIL"}  ${r.id.padEnd(width)}  ${r.log}`);
  const verdict = failed.length === 0 ? `All ${results.length} gates passed.` : `${failed.length} of ${results.length} gates failed: ${failed.map((r) => r.id).join(", ")}. Read the log paths above.`;
  return { exitCode: failed.length === 0 ? 0 : 1, text: `${lines.join("\n")}\n${verdict}` };
}
