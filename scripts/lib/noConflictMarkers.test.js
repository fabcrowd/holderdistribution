import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// A merge conflict marker committed into a data or config file corrupts it silently (2026-11-15: a CEX
// candidates file on main). This scans every tracked text file under the directories the pipeline writes.
const repo = path.resolve(import.meta.dirname, "..", "..");
const ROOTS = ["data", "public/data", "config", ".github"];
const TEXT = /\.(?:json|js|mjs|cjs|ts|tsx|yml|yaml|md|csv|tsv|txt)$/;
const MARKER = /^(?:<<<<<<< |=======$|>>>>>>> )/;

/** 1-based line numbers of conflict marker lines in `text`. */
const markerLines = (text) =>
  text
    .split("\n")
    .map((line, i) => (MARKER.test(line.replace(/\r$/, "")) ? i + 1 : 0))
    .filter(Boolean);

const trackedFiles = () =>
  execFileSync("git", ["ls-files", "-z", "--", ...ROOTS], { cwd: repo, maxBuffer: 64 * 1024 * 1024 })
    .toString("utf8")
    .split("\0")
    .filter((name) => TEXT.test(name) && fs.existsSync(path.join(repo, name)));

describe("markerLines", () => {
  it("flags the three marker forms and nothing else", () => {
    expect(markerLines("a\n<<<<<<< Updated upstream\nb\n=======\nc\n>>>>>>> Stashed changes\n")).toEqual([2, 4, 6]);
    expect(markerLines('{ "a": "<<<<<<< x" }\n  =======\n==== \n')).toEqual([]);
  });
});

describe("no merge conflict markers in tracked data, config or workflow files", () => {
  const files = trackedFiles();

  it("scans real files", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("finds no conflict marker line", () => {
    const offenders = files.flatMap((name) =>
      markerLines(fs.readFileSync(path.join(repo, name), "utf8")).map((line) => `${name}:${line}`),
    );
    expect(offenders).toEqual([]);
  });
});
