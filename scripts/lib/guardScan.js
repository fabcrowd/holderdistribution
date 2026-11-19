import fs from "node:fs";
import path from "node:path";

// Shared scanner for coinNeutralGuard.test.js and chainBranchGuard.test.js. Reads source text only: it never
// touches public/data/ or data/, so a checkout without data files scans the same.

export const repo = path.resolve(import.meta.dirname, "..", "..");

const SOURCE_EXT = /\.(?:js|mjs|cjs|jsx|ts|tsx)$/;
const TEST_FILE = /\.(?:test|spec|datacheck)\.[cm]?[jt]sx?$/;
// A test, fixture or data-check location: not shared product code.
const TEST_DIR = /(?:^|\/)(?:__tests__|__fixtures__|fixtures?|datachecks?|test)(?:\/|$)/;

/** Repo-relative path with forward slashes. */
export const rel = (file) => path.relative(repo, file).split(path.sep).join("/");

export const isTestPath = (relPath) => TEST_FILE.test(relPath) || TEST_DIR.test(relPath);

const walk = (dir, accept, out) => {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, accept, out);
    else if (accept(rel(full))) out.push(rel(full));
  }
};

/** Repo-relative files under `roots` (repo-relative dirs) for which `accept(relPath)` is true, sorted. */
export const listFiles = (roots, accept) => {
  const out = [];
  for (const root of roots) walk(path.join(repo, root), accept, out);
  return out.sort();
};

/** Non-test JS/TS source files under `roots`, minus anything `skip(relPath)` rejects. */
export const listSourceFiles = (roots, skip = () => false) =>
  listFiles(roots, (p) => SOURCE_EXT.test(p) && !isTestPath(p) && !skip(p));

export const readRepoFile = (relPath) => fs.readFileSync(path.join(repo, relPath), "utf8");

// A "/" starts a regex literal (not a division) after one of these characters or after a keyword.
const REGEX_PREV = /[(,=:[!&|?{};>]/;
const REGEX_KEYWORD = /(?:^|[^\w$.])(?:return|typeof|case|in|of|delete|void|throw|new|else|do)$/;

/**
 * One pass over JS/TS source. Returns `code` (the text with comments blanked to spaces, so every offset and
 * line number is unchanged; string contents are kept), `bare` (the same with every string, template-text and
 * regex literal blanked to spaces, so only identifiers and operators remain), `strings` (each string or
 * template literal as { line, value }; a template with `${}` keeps only its literal text, with \u0000 where
 * an expression was) and `regexes` (each regex literal as { line, source }).
 * Why a tokenizer and not a regex: a "//" inside "https://x" and quotes inside a regex literal such as
 * /["']/ break a line-by-line comment strip. A quote in JSX text ends at the line break, so a stray
 * apostrophe cannot swallow the rest of the file.
 */
export const scanSource = (text) => {
  const out = [];
  const bare = [];
  const strings = [];
  const regexes = [];
  let literal = false; // true while inside the text of a string, template or regex literal
  const modes = []; // "code", or {tpl:true, depth} while inside a template literal expression
  let braceDepth = 0;
  let line = 1;
  let i = 0;
  const n = text.length;
  const push = (ch) => {
    out.push(ch);
    bare.push(literal && ch !== "\n" ? " " : ch);
    if (ch === "\n") line++;
  };
  const pushBlank = () => {
    out.push(" ");
    bare.push(" ");
  };
  const lastSignificant = () => {
    for (let k = out.length - 1; k >= 0; k--) if (!/\s/.test(out[k])) return k;
    return -1;
  };
  const readTemplate = () => {
    // Called with i just past an opening backtick.
    literal = true;
    let value = "";
    const startLine = line;
    while (i < n) {
      const ch = text[i];
      if (ch === "\\") {
        value += ch + (text[i + 1] ?? "");
        push(ch);
        if (i + 1 < n) push(text[i + 1]);
        i += 2;
        continue;
      }
      if (ch === "`") {
        literal = false;
        push(ch);
        i++;
        strings.push({ line: startLine, value });
        return false;
      }
      if (ch === "$" && text[i + 1] === "{") {
        push("$");
        push("{");
        literal = false;
        i += 2;
        value += "\u0000";
        modes.push({ tpl: true, depth: braceDepth, startLine, value });
        braceDepth++;
        return true;
      }
      value += ch;
      push(ch);
      i++;
    }
    literal = false;
    strings.push({ line: startLine, value });
    return false;
  };
  const resumeTemplate = (frame) => {
    // Continue a template after its ${} expression closed; keep literal text collected so far.
    let value = frame.value;
    const startLine = frame.startLine;
    literal = true;
    while (i < n) {
      const ch = text[i];
      if (ch === "\\") {
        value += ch + (text[i + 1] ?? "");
        push(ch);
        if (i + 1 < n) push(text[i + 1]);
        i += 2;
        continue;
      }
      if (ch === "`") {
        literal = false;
        push(ch);
        i++;
        strings.push({ line: startLine, value });
        return;
      }
      if (ch === "$" && text[i + 1] === "{") {
        push("$");
        push("{");
        literal = false;
        i += 2;
        value += "\u0000";
        modes.push({ tpl: true, depth: braceDepth, startLine, value });
        braceDepth++;
        return;
      }
      value += ch;
      push(ch);
      i++;
    }
    literal = false;
    strings.push({ line: startLine, value });
  };

  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      while (i < n && text[i] !== "\n") {
        pushBlank();
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "*") {
      pushBlank();
      pushBlank();
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        push(text[i] === "\n" ? "\n" : " ");
        i++;
      }
      if (i < n) {
        pushBlank();
        pushBlank();
        i += 2;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      const startLine = line;
      let value = "";
      push(ch);
      i++;
      literal = true;
      while (i < n && text[i] !== ch && text[i] !== "\n") {
        if (text[i] === "\\" && i + 1 < n && text[i + 1] !== "\n") {
          value += text[i] + text[i + 1];
          push(text[i]);
          push(text[i + 1]);
          i += 2;
          continue;
        }
        value += text[i];
        push(text[i]);
        i++;
      }
      literal = false;
      if (text[i] === ch) {
        push(ch);
        i++;
        strings.push({ line: startLine, value });
      }
      continue;
    }
    if (ch === "`") {
      push(ch);
      i++;
      readTemplate();
      continue;
    }
    if (ch === "/") {
      const k = lastSignificant();
      const prev = k < 0 ? "" : out[k];
      const before = out.slice(Math.max(0, k - 12), k + 1).join("");
      if (k < 0 || REGEX_PREV.test(prev) || REGEX_KEYWORD.test(before)) {
        // Regex literal: copy to the closing "/" (a "/" inside [...] does not close it).
        const startLine = line;
        let source = ch;
        literal = true;
        push(ch);
        i++;
        let inClass = false;
        while (i < n && text[i] !== "\n") {
          const c = text[i];
          if (c === "\\") {
            source += c + (text[i + 1] ?? "");
            push(c);
            if (i + 1 < n) push(text[i + 1]);
            i += 2;
            continue;
          }
          if (c === "[") inClass = true;
          else if (c === "]") inClass = false;
          source += c;
          push(c);
          i++;
          if (c === "/" && !inClass) break;
        }
        literal = false;
        if (source.length > 1 && source.endsWith("/")) regexes.push({ line: startLine, source: source.slice(1, -1) });
        continue;
      }
    }
    if (ch === "{") braceDepth++;
    if (ch === "}") {
      braceDepth--;
      const top = modes[modes.length - 1];
      if (top && top.tpl && top.depth === braceDepth) {
        modes.pop();
        push(ch);
        i++;
        resumeTemplate(top);
        continue;
      }
    }
    push(ch);
    i++;
  }
  return { code: out.join(""), bare: bare.join(""), strings, regexes };
};

/** 1-based line numbers of every match of `regex` (global) in `code`. */
export const matchLines = (code, regex) => {
  const re = new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`);
  const lines = [];
  for (const m of code.matchAll(re)) {
    let line = 1;
    for (let k = 0; k < m.index; k++) if (code.charCodeAt(k) === 10) line++;
    lines.push(line);
  }
  return lines;
};

/**
 * YAML text with comments removed (a "#" that starts a line or follows whitespace, outside quotes), line
 * count unchanged. Block-scalar text (run: |) is kept, as shell lines are code too.
 */
export const stripYamlComments = (yaml) =>
  yaml
    .split(/\r?\n/)
    .map((raw) => {
      let quote = null;
      for (let k = 0; k < raw.length; k++) {
        const c = raw[k];
        if (quote) {
          if (c === quote) quote = null;
        } else if (c === '"' || c === "'") quote = c;
        else if (c === "#" && (k === 0 || /\s/.test(raw[k - 1]))) return raw.slice(0, k);
      }
      return raw;
    })
    .join("\n");

/**
 * Compare measured counts with a recorded allowlist. `measured`: Map<key, Array<{line, detail}>> (one entry per
 * hit); `allowed`: Map<key, { count, reason }>. Returns problem strings: a hit in an unlisted key (names each
 * line), more hits than recorded, fewer hits than recorded or none. `advice` says what to do instead.
 */
export const compareToAllowlist = ({ rule, advice, measured, allowed }) => {
  const problems = [];
  for (const [key, hits] of measured) {
    const entry = allowed.get(key);
    if (!entry) {
      for (const hit of hits) problems.push(`${key}:${hit.line} [${rule}] ${hit.detail}. ${advice}`);
    } else if (hits.length > entry.count) {
      const lines = hits.map((h) => `${key}:${h.line} ${h.detail}`).join("; ");
      problems.push(`${key} [${rule}] has ${hits.length} hits, the allowlist records ${entry.count} (${lines}). ${advice}`);
    } else if (hits.length < entry.count) {
      problems.push(`${key} [${rule}] has ${hits.length} hits, fewer than the ${entry.count} recorded: lower its count in the allowlist to ${hits.length}.`);
    }
  }
  for (const key of allowed.keys()) {
    if (!measured.has(key)) problems.push(`${key} [${rule}] no longer has a hit: remove its allowlist entry (or the file is gone).`);
  }
  return problems;
};

/** Fails with every problem on its own line (an array diff would be cut to "[ ...(59) ]" in the output). */
export const assertNoProblems = (problems) => {
  if (problems.length > 0) throw new Error(`${problems.length} problem(s):\n${problems.join("\n")}`);
};
