// The candidate artifact of design 9.1 step 6, one per lane flush and attempt:
//   { schema: 1, kind, run, coins: { <slug>: { chain: [entry, ...], files: { <path>: <sha256> } } } }
// `chain` is the adopted entries oldest first, then this run's entry; entries carry no
// `publishedAt` (the publish job adds it to the one that becomes the manifest's). The
// last entry must be this run's. `files` holds the sha256 of each generated file, which
// the publish job compares with the files it restores (design 9.2 step 4).
//
// Cost by size: KB per coin (chain entries about 0.6 KB each, a hash per generated file);
// the artifact grows with the coins of one lane (16 per pack), never with H, C or D.
import { CandidateError, RecordSchemaError } from "./errors.js";
import { validateEntry } from "./manifest.js";
import { kindField, runField, slugField } from "./recordFields.js";
import { labelOf, parseRecord, shapeOf } from "./shape.js";
import { canonical, stableStringify } from "./stable.js";

export const CANDIDATE_SCHEMA = 1;

export function validateCandidate(c) {
  const probe = shapeOf("candidate").isObject(c) ? c : {};
  const label = labelOf("candidate", { kind: probe.kind });
  const s = shapeOf(label);
  s.object(c, "the record", ["schema", "kind", "run", "coins"]);
  if (c.schema !== CANDIDATE_SCHEMA) throw new RecordSchemaError(`${label}: schema ${JSON.stringify(c.schema)} is not readable here (this code reads schema ${CANDIDATE_SCHEMA})`);
  kindField(s, c.kind, "kind");
  runField(s, c.run, "run");
  s.map(c.coins, "coins", (coin, at, slug) => {
    slugField(s, slug, at);
    const cs = shapeOf(labelOf("candidate", { slug, kind: c.kind }));
    cs.object(coin, at, ["chain", "files"]);
    if (cs.array(coin.chain, `${at}.chain`).length === 0) throw cs.bad(`${at}.chain`, "must hold at least this run's entry");
    coin.chain.forEach((entry) => validateEntry(entry, { slug, kind: c.kind, published: false }));
    const last = coin.chain.at(-1).run;
    if (last.id !== c.run.id || last.attempt !== c.run.attempt) {
      throw cs.bad(`${at}.chain`, `ends with the entry of run ${last.id} attempt ${last.attempt}, not this run's ${c.run.id} attempt ${c.run.attempt}`);
    }
    cs.map(coin.files, `${at}.files`, (hash, where, path) => {
      cs.string(path, where);
      cs.sha256(hash, where);
    });
  });
  return c;
}

export function buildCandidate({ kind, run, coins }) {
  return canonical(validateCandidate(structuredClone({ schema: CANDIDATE_SCHEMA, kind, run, coins })));
}

export const serializeCandidate = (c) => `${stableStringify(validateCandidate(c))}\n`;

export function parseCandidate(text) {
  return canonical(validateCandidate(parseRecord(text, "candidate", CANDIDATE_SCHEMA)));
}

// Design 9.2 step 2: per coin, the candidate of the highest attempt. Two artifacts of the
// same attempt that both carry a coin must agree on it; if they differ the coin is
// reported in `conflicts` and left out (it keeps its main entry), the other coins go on.
// Artifacts of another kind, or of more than one run, mean the wrong download: an error.
//
// Per coin means per coin: a coin the highest attempt does not carry is taken from the
// highest lower attempt that does (a lane that retried only some of its coins). Each
// artifact is validated here, so this function does not rely on its caller having parsed it.
export function pickHighestAttempt(candidates, kind) {
  candidates.forEach(validateCandidate);
  const runId = candidates[0]?.run.id;
  for (const c of candidates) {
    if (c.kind !== kind) throw new CandidateError(`candidate: an artifact of kind ${c.kind} was given where kind ${kind} was expected`);
    if (c.run.id !== runId) throw new CandidateError(`candidate ${kind}: artifacts of runs ${runId} and ${c.run.id} were given together`);
  }
  const bySlug = new Map();
  for (const c of candidates) {
    for (const [slug, coin] of Object.entries(c.coins)) {
      const mine = { attempt: c.run.attempt, run: structuredClone(c.run), chain: structuredClone(coin.chain), files: structuredClone(coin.files) };
      bySlug.set(slug, [...(bySlug.get(slug) ?? []), mine]);
    }
  }
  const chosen = new Map();
  const conflicts = [];
  for (const [slug, found] of [...bySlug].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const top = Math.max(...found.map((f) => f.attempt));
    const atTop = found.filter((f) => f.attempt === top);
    const first = stableStringify(atTop[0]);
    if (atTop.some((f) => stableStringify(f) !== first)) {
      conflicts.push({ slug, reason: `${atTop.length} artifacts of attempt ${top} carry coin ${slug} with different content` });
    } else {
      chosen.set(slug, canonical(atTop[0]));
    }
  }
  return { coins: Object.fromEntries(chosen), conflicts };
}
