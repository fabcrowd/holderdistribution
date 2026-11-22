import { describe, expect, it } from "vitest";
import { CHAIN_VMS } from "./chainVms.js";
import { assertNoProblems, compareToAllowlist, listFiles, listSourceFiles, readRepoFile, repo, scanSource, stripYamlComments } from "./guardScan.js";

// Owner rule (2026-11-18): a difference between ledgers belongs in a chain adapter, and shared code asks the
// adapter's capability instead of branching on the chain family. This guard fails when a non-test file
// outside the adapter layer branches on the family (evm, solana, hedera): a comparison with a family name,
// a `case`, a family-name set or list, a default of "evm" for a missing vm, projectHasVm / isEvm /
// isSolana / isHedera, an HD_SOLANA_FLOWS / HD_HEDERA_FLOWS / HD_HAS_EVM switch, a table keyed by two or more
// families, and a workflow step condition that names a family. The list of today's violations (audit:
// tasks/scale-100/design/scaling-audit.md, section 1.1) may only shrink: a hit in an unlisted file fails, more
// hits than recorded fails, and fewer hits than recorded fails too (lower the number or remove the entry).
//
// The family literal pattern belongs here, not in coinNeutralGuard.test.js: "hedera" is both a coin slug and
// a vm name, and the coin guard leaves chain family names to this guard so each pattern has one owner. Chain
// names (ethereum, polygon, base) and the default-coin layout flag belong to the coin guard.
//
// What this guard does not see: a family held in a variable (`vm === VM_SOLANA`), a branch on a capability
// function that hides a family test (vmPinsToBlock), config/nightly-jobs.json `requires: evm`, address
// validators called by name (isEvmAddress, isSolanaAddress: 36 call sites in 7 files, a typed validator and
// not a branch), a string compared after being lowercased on another line, and a per-family script that is
// simply selected by its file name (scan-solana-flows.js) with no condition around it. Also not seen: a regex
// test of a family (/^solana$/), a lookup table keyed by families whose keys are more than 2 lines apart,
// a prefix shorter than the family name (startsWith("sol")), a shell `case "$VM" in solana)`, and a family
// built by concatenation. Seen since the first review: the family literal in any case ("Solana"),
// startsWith / endsWith against a family name, a folded or continued `if:` in a workflow, and a shell
// `[ "$VM" = solana ]` test in a run block.

const SOURCE_ROOTS = ["scripts", "netlify", "src"];
const WORKFLOW_DIR = ".github/workflows";
const SKIP_FILES = new Set(["netlify/functions/forensics-gate.cjs"]);
const skipSource = (p) => SKIP_FILES.has(p) || p.startsWith("scripts/datachecks/") || p.startsWith("src/datachecks/");

// ---------------------------------------------------------------------------------------------------------
// The adapter layer: where a family branch is allowed
// ---------------------------------------------------------------------------------------------------------

// Found from the code: chainAdapters.js loads each adapter module by a relative import; the directory of each
// loaded module is an adapter folder. The explicit entries are the rest of the layer:
//   scripts/lib/chainAdapters.js  the adapter registry, the EVM adapter and the loader (a fixed list of vms)
//   scripts/lib/chainVms.js       the vm set and the capability predicates shared code is told to ask
//   scripts/lib/address.js        the per-family address rules (isEvmAddress, isSolanaAddress, canonicalAddressForVm)
//                                 that the adapters' isAddress and normalizeAddress call; the audit lists
//                                 scripts/lib/ledger/config.js as the accidental second copy, and that stays a hit
// Not exempt on purpose: pull-holders-rpc.js (the EVM scan was never moved into its adapter), the per-family
// scripts (scan-solana-flows.js, generate-wallet-flows-hedera.js) and lib/ledger/*Source.js. They are the
// parallel implementations the audit lists in 1.3; a family branch inside one of them is a hit.
const ADAPTER_REGISTRY_FILE = "scripts/lib/chainAdapters.js";
const ADAPTER_FILES = new Set([ADAPTER_REGISTRY_FILE, "scripts/lib/chainVms.js", "scripts/lib/address.js"]);

/** Directories (repo-relative, no trailing slash) of the modules chainAdapters.js loads, from its own text. */
export const adapterDirsFrom = (registryText) => {
  const dirs = new Set();
  for (const m of scanSource(registryText).code.matchAll(/(?:import\(\s*|from\s+)["']\.\/([\w-]+)\/[\w./-]+\.js["']/g)) dirs.add(`scripts/lib/${m[1]}`);
  return [...dirs].sort();
};

const ADAPTER_DIRS = adapterDirsFrom(readRepoFile(ADAPTER_REGISTRY_FILE));
const inAdapterLayer = (relPath) => ADAPTER_FILES.has(relPath) || ADAPTER_DIRS.some((dir) => relPath.startsWith(`${dir}/`));

// ---------------------------------------------------------------------------------------------------------
// Today's violations. Entry: file -> { count, reason }.
// ---------------------------------------------------------------------------------------------------------

const ENTRY = (count, reason) => ({ count, reason });

const ALLOWED_BRANCHES = new Map([
  ["scripts/add-project.js", ENTRY(6, "not in the audit: the add-project CLI picks chain facts per vm and defaults a missing vm to evm (a fifth copy of the which-vm rule, audit 1.1)")],
  ["scripts/build-cutoffs.js", ENTRY(1, "audit 1.1 (which-vm rule, c.vm ?? evm); accident: use resolveChainVm")],
  ["scripts/build-ledger.js", ENTRY(3, "audit 1.1 (build-ledger.js:133-170): real, per-vm ledger source dispatched inline; move into the adapter")],
  ["scripts/chain-inventory.js", ENTRY(3, "audit 1.1 (which-vm rule, c.vm ?? evm); accident")],
  ["scripts/detect-token-chains.js", ENTRY(2, "not in the audit: address-shape and chain-kind test per vm in the token-chain detector; real, belongs in an adapter port")],
  ["scripts/generate-holders-history.js", ENTRY(2, "audit 1.1 (generate-holders-history.js:407-409): first-live-date floor only for Solana and Hedera; accident (only those two have a day store)")],
  ["scripts/generate-tier-outflows.js", ENTRY(2, "audit 1.1 (:258, :565-592, :601-641): three tier-outflow paths and mixed-ledger refusal; accident of the per-chain design")],
  ["scripts/init-forensics-registry.js", ENTRY(3, "audit 1.1 (init-forensics-registry.js:48-49): Solana and Hedera special cases in paid-section reports; accident")],
  ["scripts/lib/chainInventory.js", ENTRY(4, "audit 1.1 (chainInventory.js:37,68): which-vm rule with the evm default; accident")],
  ["scripts/lib/chainStatus.js", ENTRY(2, "audit 1.1 (chainStatus.js:23-24): checkpoint shape per vm (block vs slot); small real difference to move behind an adapter capability")],
  ["scripts/lib/duneCex.js", ENTRY(3, "audit 1.1 (duneCex.js:58-59): Dune chain names; spellbook model table is now vm-neutral (3, was 4); real (external naming), move behind an adapter capability")],
  ["scripts/lib/goLive.js", ENTRY(4, "audit 1.1 (goLive.js:265,280-282): Solana and Hedera go-live checks; accident of separate stores")],
  ["scripts/lib/ledger/config.js", ENTRY(1, "audit 1.1: second set of address validators keyed by vm (duplicates address.js); accident")],
  ["scripts/lib/networkStake.js", ENTRY(1, "not in the audit: network stake lookup skips non-EVM chains; real, should be the adapter's optional stakingInfo port")],
  ["scripts/lib/nightlyPlan.js", ENTRY(4, "not in the audit: provider order keyed by the vms a project has (alchemy for evm, helius for solana); real provider difference, move behind a capability")],
  ["scripts/lib/onboard.js", ENTRY(11, "audit 1.1 (lib/onboard.js:129-187): discovery facts per vm; real, belongs in an adapter discover port")],
  ["scripts/lib/onboardAnswers.js", ENTRY(6, "not in the audit: vmOfChain is another copy of the which-vm rule (a key solana or hedera decides the vm), plus answers rules per vm; accident")],
  ["scripts/lib/onboardRun.js", ENTRY(15, "audit 1.1 (onboardRun.js:47-55, :364-510): onboarding steps per vm and the which-vm rule; accident, records the gaps of the per-chain scripts")],
  ["scripts/lib/projects.js", ENTRY(7, "audit 1.1 (projects.js:164-213): config validation per vm; real, duplicates the adapter's isAddress")],
  ["scripts/lib/rpcMetrics.js", ENTRY(1, "not in the audit: reads HD_HAS_EVM to drop the alchemy provider; accident of a workflow flag")],
  ["scripts/lib/tokenChains.js", ENTRY(2, "audit 1.1 (tokenChains.js:135): a chain keyed solana without vm is Solana, a copy of the which-vm rule; accident")],
  ["scripts/lib/walletFlows.js", ENTRY(1, "not in the audit: address-shape table keyed by family (a third set of address validators beside address.js and ledger/config.js); accident")],
  ["scripts/onboard-run.js", ENTRY(1, "not in the audit: onboarding runner tests for a Solana chain; accident, records per-chain gaps")],
  ["scripts/onboard.js", ENTRY(8, "audit 1.1 (onboard.js:259-266): discovery facts per vm; real, belongs in an adapter discover port")],
  ["scripts/pull-holders-rpc.js", ENTRY(4, "audit 1.1 (pull-holders-rpc.js:656-690, :764-765, :897-915): EVM scanned inline, other vms through the adapter; accident (EVM was never moved into its adapter)")],
  ["scripts/scan-exchange-flows.js", ENTRY(3, "audit 1.1 (scan-exchange-flows.js:200-230, :276): Solana and Hedera history builders inside the EVM flow script, mixed-ledger refusal; accident")],
  ["scripts/sync-cex-wallets-dune.js", ENTRY(1, "not in the audit (1, was 2: the mode rule reads the EVM chain list once): the spellbook sync branches on vm; real (external source), move behind an adapter capability")],
  ["scripts/trace-bot-proceeds.js", ENTRY(2, "audit 1.1 (trace-bot-proceeds.js:91): Solana special case and the evm default; accident")],
  ["scripts/workflow-paths.js", ENTRY(3, "audit 1.1 (workflow-paths.js:72-73, :171): HD_SOLANA_FLOWS, HD_HEDERA_FLOWS, HD_HAS_EVM switch workflow steps; accident")],
  ["src/components/WalletFlowsPanel.tsx", ENTRY(2, "not in the audit: the panel branches on the vm of a wallet-flow row; accident")],
  ["src/hooks/useChainStatus.ts", ENTRY(1, "not in the audit: the site tells a Solana chain's status shape from an EVM one; real, a checkpoint capability")],
  ["src/lib/explorerLinks.ts", ENTRY(10, "audit 1.1 (explorerLinks.ts:18-104): the site's own vm resolution and explorer roots, duplicate of chainAdapters; accident")],
  ["src/lib/flowEmptyState.ts", ENTRY(1, "not in the audit: empty-state copy for a Solana chain; accident")],
  ["src/lib/venueFlows.ts", ENTRY(1, "not in the audit: venue flows skip non-EVM chains; accident")],
  [".github/workflows/generate-tier-outflows.yml", ENTRY(1, "not in the audit: a Hedera flow-scan step switched on HD_HEDERA_FLOWS; accident (separate per-family scan)")],
  [".github/workflows/refresh-holders.yml", ENTRY(3, "audit 1.1 (refresh-holders.yml:398-427, :452-463): separate Solana, Hedera and EVM flow-scan steps; accident")],
  [".github/workflows/refresh-wallet-flows.yml", ENTRY(4, "audit 1.1 (refresh-wallet-flows.yml:95-111): three wallet-flow steps and conditions on their outcomes; accident")],
  [".github/workflows/scan-exchange-flows.yml", ENTRY(1, "not in the audit: a Hedera flow-scan step switched on HD_HEDERA_FLOWS; accident")],
]);

// ---------------------------------------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------------------------------------

const FAMILY = CHAIN_VMS.join("|");
const Q = "[\"'`]";
// The family literal is matched without regard to case ("Solana" is the same branch as "solana").
const RULES = [
  { name: "comparison", detail: "compares with a chain family name", re: new RegExp(String.raw`[!=]==?\s*${Q}(?:${FAMILY})${Q}|${Q}(?:${FAMILY})${Q}\s*[!=]==?`, "gi") },
  { name: "case", detail: "switches on a chain family name", re: new RegExp(String.raw`\bcase\s+${Q}(?:${FAMILY})${Q}\s*:`, "gi") },
  {
    name: "membership",
    detail: "tests a set, list or prefix of chain family names",
    re: new RegExp(String.raw`\.(?:includes|has|indexOf|startsWith|endsWith)\(\s*${Q}(?:${FAMILY})${Q}|new Set\(\s*\[\s*${Q}(?:${FAMILY})${Q}|\[\s*${Q}(?:${FAMILY})${Q}[^\]]*\]\s*\.includes\(`, "gi"),
  },
  { name: "default", detail: 'defaults a missing vm to "evm"', re: new RegExp(String.raw`(?:\?\?|\|\|)\s*${Q}evm${Q}`, "gi") },
  { name: "predicate", detail: "asks whether the project is a chain family", re: /\b(?:projectHasVm|isEvm|isSolana|isHedera)\b/g },
  { name: "env-switch", detail: "switches on a per-family workflow flag", re: /\bHD_(?:SOLANA_FLOWS|HEDERA_FLOWS|HAS_EVM)\b/g },
];
const FAMILY_KEY = new RegExp(String.raw`(?:^|[{,])[ \t]*["']?(${FAMILY})["']?\s*:`, "gm");
const WORKFLOW_IF = /^(\s*)(-\s+)?if:\s*(.*)$/;
const WORKFLOW_FAMILY_WORD = new RegExp(String.raw`\b(?:${FAMILY})\b`, "i");
// A shell test that compares a variable with a family name: [ "$VM" = solana ], [[ $VM == "solana" ]].
const SHELL_FAMILY_TEST = new RegExp(String.raw`\[\[?[^\]\n]*?[!=]=?\s*["']?(?:${FAMILY})["']?\s*\]`, "gi");

const lineAt = (code, index) => {
  let line = 1;
  for (let k = 0; k < index; k++) if (code.charCodeAt(k) === 10) line++;
  return line;
};

/** Tables keyed by two or more chain families, keys within 2 lines of each other; one hit per table. */
const familyTableHits = (code) => {
  const keys = [...code.matchAll(FAMILY_KEY)].map((m) => ({ line: lineAt(code, m.index + m[0].search(/\S/)), key: m[1] }));
  const tables = [];
  let current = null;
  for (const hit of keys) {
    if (current && hit.line - current.last <= 2) {
      current.keys.add(hit.key);
      current.last = hit.line;
    } else {
      if (current) tables.push(current);
      current = { line: hit.line, last: hit.line, keys: new Set([hit.key]) };
    }
  }
  if (current) tables.push(current);
  return tables.filter((t) => t.keys.size >= 2).map((t) => ({ line: t.line, detail: `has a table keyed by chain families (${[...t.keys].join(", ")})` }));
};

/** Family branches in one JS/TS file's text (comments stripped): [{ line, detail }]. */
export const familyBranchHits = (text) => {
  const code = scanSource(text).code;
  const hits = [];
  for (const { detail, re } of RULES) {
    for (const m of code.matchAll(re)) hits.push({ line: lineAt(code, m.index), detail: `${detail} (\`${m[0].trim()}\`)` });
  }
  hits.push(...familyTableHits(code));
  return hits.sort((a, b) => a.line - b.line);
};

/**
 * Family branches in one workflow file's text: a per-family flag anywhere, an `if:` naming a family (also when
 * the condition is a folded or block scalar, or continues on the next, more indented lines; one hit per
 * condition, at its `if:` line), and a shell test of a variable against a family name.
 */
export const workflowBranchHits = (yaml) => {
  const hits = [];
  const lines = stripYamlComments(yaml).split("\n");
  const indentOf = (text) => text.length - text.trimStart().length;
  lines.forEach((text, index) => {
    for (const m of text.matchAll(RULES.find((r) => r.name === "env-switch").re)) hits.push({ line: index + 1, detail: `switches on the per-family workflow flag \`${m[0]}\`` });
    for (const m of text.matchAll(SHELL_FAMILY_TEST)) hits.push({ line: index + 1, detail: `tests a shell variable against a chain family name (\`${m[0]}\`)` });
    const step = WORKFLOW_IF.exec(text);
    if (!step) return;
    const keyIndent = step[1].length + (step[2] ? step[2].length : 0);
    let condition = step[3].replace(/^[>|][+-]?$/, "");
    for (let k = index + 1; k < lines.length && (lines[k].trim() === "" || indentOf(lines[k]) > keyIndent); k++) condition += ` ${lines[k].trim()}`;
    if (WORKFLOW_FAMILY_WORD.test(condition)) hits.push({ line: index + 1, detail: `has a step condition that names a chain family (\`${condition.trim().slice(0, 100)}\`)` });
  });
  return hits;
};

const sourceFiles = listSourceFiles(SOURCE_ROOTS, skipSource).filter((p) => !inAdapterLayer(p));
const workflowFiles = listFiles([WORKFLOW_DIR], (p) => /\.ya?ml$/.test(p) && !p.slice(WORKFLOW_DIR.length + 1).includes("/"));

const measure = () => {
  const measured = new Map();
  for (const f of sourceFiles) {
    const hits = familyBranchHits(readRepoFile(f));
    if (hits.length) measured.set(f, hits);
  }
  for (const f of workflowFiles) {
    const hits = workflowBranchHits(readRepoFile(f));
    if (hits.length) measured.set(f, hits);
  }
  return measured;
};

// ---------------------------------------------------------------------------------------------------------
// Scanner tests, on small inline samples
// ---------------------------------------------------------------------------------------------------------

describe("familyBranchHits", () => {
  const count = (text) => familyBranchHits(text).length;

  it("flags a comparison with a family name in every operator and quote style, either side", () => {
    expect(count('if (chain.vm === "solana") go();')).toBe(1);
    expect(count("if (vm !== 'hedera') go();")).toBe(1);
    expect(count("if (vm == `evm`) go();")).toBe(1);
    expect(count('if ("solana" === chain.key) go();')).toBe(1);
    expect(count('const both = a === "evm" || b === "evm";')).toBe(2);
  });

  it("flags a switch, a membership test, a set of families and the evm default", () => {
    expect(count('switch (vm) {\n  case "solana":\n    return 1;\n}')).toBe(1);
    expect(count('const ok = vms.includes("evm");')).toBe(1);
    expect(count('const ok = ["evm", "hedera"].includes(vm);')).toBeGreaterThanOrEqual(1);
    expect(count('const PINNED = new Set(["evm", "hedera"]);')).toBe(1);
    expect(count('const vm = chain.vm ?? "evm";')).toBe(1);
    expect(count("const vm = chain.vm || 'evm';")).toBe(1);
  });

  it("flags the predicates and the per-family flags", () => {
    expect(count("if (projectHasVm(config, vm)) run();")).toBe(1);
    expect(count("const isEvm = vm === x;")).toBe(1);
    expect(count('if (process.env.HD_SOLANA_FLOWS === "true") run();')).toBe(1);
    expect(count("const a = env.HD_HAS_EVM; const b = env.HD_HEDERA_FLOWS;")).toBe(2);
  });

  it("flags a table keyed by two or more families, not one key or a ternary", () => {
    expect(count("const SOURCE = { evm: a, solana: b, hedera: c };")).toBe(1);
    expect(count("const STEPS = {\n  evm: [1],\n  solana: [2],\n};")).toBe(1);
    expect(count("const x = { solana: 1 };")).toBe(0);
    expect(count('const x = ok ? "solana" : "evm";')).toBe(0);
    expect(count("const x = { evm: 1 };\n\n\n\nconst y = { solana: 2 };")).toBe(0);
  });

  it("does not flag a family name that is not a branch, or one only in a comment", () => {
    expect(count('// if (vm === "solana") skip\n/* vm ?? "evm" */\nconst x = 1;')).toBe(0);
    expect(count('const label = "solana";')).toBe(0);
    expect(count('const url = "https://solana.example/evm";')).toBe(0);
    expect(count('const evmCount = 1; const isEvmAddress = (a) => a;')).toBe(0);
    expect(count('const r = /["\']/.test(s); const same = "solanaX" === y;')).toBe(0);
  });

  it("names the line", () => {
    expect(familyBranchHits('const a = 1;\nconst b = 2;\nif (vm === "hedera") run();')[0].line).toBe(3);
  });
});

describe("workflowBranchHits", () => {
  const yaml = [
    "jobs:",
    "  a:",
    "    steps:",
    "      - name: Scan Hedera flows",
    "        if: ${{ env.HD_HEDERA_FLOWS == 'true' }}",
    "        run: node scripts/scan-hedera-flows.js",
    "      - name: gated",
    "        if: steps.evm.outputs.partial != 'true'",
    "        run: echo ok",
    "      - name: shell",
    "        run: |",
    "          echo \"$flags\" | grep -qx 'HD_HAS_EVM=true'",
    "      # if: env.HD_SOLANA_FLOWS == 'true'",
    "      - name: plain",
    "        if: success()",
    "        run: echo solana",
  ].join("\n");

  it("finds a per-family flag, a step condition naming a family and a flag in a shell line, and nothing else", () => {
    expect(workflowBranchHits(yaml).map((h) => h.line)).toEqual([5, 8, 12]);
  });
});

describe("familyBranchHits: case and prefix tests", () => {
  const count = (text) => familyBranchHits(text).length;

  it("flags a family name in any case and a prefix or suffix test against a family name", () => {
    expect(count('if (chain.vm === "Solana") go();')).toBe(1);
    expect(count("if (vm == 'HEDERA') go();")).toBe(1);
    expect(count('const vm = chain.vm ?? "EVM";')).toBe(1);
    expect(count('if (key.startsWith("solana")) go();')).toBe(1);
    expect(count('if (key.endsWith("evm")) go();')).toBe(1);
  });

  it("does not flag a prefix test against something that is not a family name", () => {
    expect(count('if (key.startsWith("sol")) go();')).toBe(0);
    expect(count('if (key.startsWith("solanaX")) go();')).toBe(0);
    expect(count('if (url.startsWith("https://")) go();')).toBe(0);
  });
});

describe("workflowBranchHits: folded conditions and shell tests", () => {
  const hitLines = (yaml) => workflowBranchHits(yaml).map((h) => h.line);

  it("finds a family in a folded, block or continued if: condition, once per condition, at the if: line", () => {
    const yaml = [
      "steps:",
      "  - name: folded",
      "    if: >-",
      "      success() &&",
      "      steps.hedera.outcome == 'success'",
      "    run: echo a",
      "  - name: continued",
      "    if: ${{ always() &&",
      "      steps.solana.outputs.partial == 'true' }}",
      "    run: echo b",
      "  - if: steps.evm.outcome == 'failure'",
      "    run: echo c",
    ].join("\n");
    expect(hitLines(yaml)).toEqual([3, 8, 11]);
  });

  it("does not take a family word from the step's run line or from a condition that names none", () => {
    const yaml = ["steps:", "  - name: plain", "    if: >-", "      success() &&", "      github.ref == 'refs/heads/main'", "    run: node scripts/scan-solana-flows.js"].join("\n");
    expect(hitLines(yaml)).toEqual([]);
  });

  it("finds a shell test of a variable against a family name, in either bracket style and quoting", () => {
    const yaml = [
      "steps:",
      "  - run: |",
      '      if [ "$VM" = solana ]; then echo a; fi',
      '      [[ $VM == "solana" ]] && echo b',
      "      [ $VM != 'evm' ] && echo c",
    ].join("\n");
    expect(hitLines(yaml)).toEqual([3, 4, 5]);
  });

  it("does not flag a shell test of something else, or a family word that is only printed", () => {
    const yaml = ["steps:", "  - run: |", '      if [ "$VM" = other ]; then echo solana; fi', "      [ -f scan-solana.json ] && echo ok", '      echo "evm"'].join("\n");
    expect(hitLines(yaml)).toEqual([]);
  });
});

describe("adapterDirsFrom", () => {
  it("reads the adapter folders from the registry's own imports", () => {
    const text = 'const a = await import("./solana/adapter.js");\nimport { x } from "./hedera/adapter.js";\nimport { y } from "./address.js";\n// import("./gone/adapter.js")';
    expect(adapterDirsFrom(text)).toEqual(["scripts/lib/hedera", "scripts/lib/solana"]);
  });
});

describe("compareToAllowlist (shared)", () => {
  const advice = "ask the chain adapter's capability.";
  const run = (measured, allowed) => compareToAllowlist({ rule: "chain-family-branch", advice, measured: new Map(measured), allowed: new Map(allowed) });
  it("passes when counts match, and names file, line and rule otherwise", () => {
    const hit = (line) => ({ line, detail: "compares with a chain family name" });
    expect(run([["a.js", [hit(1)]]], [["a.js", ENTRY(1, "x")]])).toEqual([]);
    expect(run([["b.js", [hit(7)]]], [])).toEqual([`b.js:7 [chain-family-branch] compares with a chain family name. ${advice}`]);
    expect(run([["a.js", [hit(1), hit(2)]]], [["a.js", ENTRY(1, "x")]])[0]).toMatch(/has 2 hits, the allowlist records 1/);
    expect(run([["a.js", [hit(1)]]], [["a.js", ENTRY(3, "x")]])[0]).toMatch(/lower its count/);
    expect(run([], [["c.js", ENTRY(1, "x")]])[0]).toMatch(/remove its allowlist entry/);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The guard
// ---------------------------------------------------------------------------------------------------------

describe("no chain-family branch outside the adapter layer", () => {
  it("finds the adapter layer from the code", () => {
    expect(ADAPTER_DIRS).toEqual(expect.arrayContaining(["scripts/lib/solana", "scripts/lib/hedera"]));
    for (const file of ADAPTER_FILES) expect(readRepoFile(file).length, file).toBeGreaterThan(0);
    expect(repo.length).toBeGreaterThan(0);
  });

  it("scans real files and none in the adapter layer", () => {
    expect(sourceFiles.length).toBeGreaterThan(300);
    expect(workflowFiles.length).toBeGreaterThan(10);
    expect(sourceFiles.some((f) => f === "scripts/pull-holders-rpc.js")).toBe(true);
    expect(sourceFiles.some((f) => f.startsWith("scripts/lib/solana/") || f.startsWith("scripts/lib/hedera/"))).toBe(false);
  });

  it("has no unlisted family branch, and the list is exact", () => {
    assertNoProblems(
      compareToAllowlist({
        rule: "chain-family-branch",
        advice:
          "Ask the chain adapter's capability (scripts/lib/chainAdapters.js, scripts/lib/chainVms.js) instead of branching on the family here; if no capability covers it, add one to the adapters.",
        measured: measure(),
        allowed: ALLOWED_BRANCHES,
      }),
    );
  });
});
