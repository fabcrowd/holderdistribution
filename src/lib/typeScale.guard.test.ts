// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { MIN_FONT_PX } from "./terminalLayout";

const SRC_ROOT = resolve(__dirname, "..");
const PROJECT_ROOT = resolve(SRC_ROOT, "..");
const SOURCE_FILE = /\.(ts|tsx)$/;
const TEST_FILE = /\.test\./;

const TAILWIND_TEXT_SIZE = /text-\[(\d+(?:\.\d+)?)px\]/g;
const STYLE_FONT_SIZE = /fontSize\s*[:=]\s*\{?\s*(\d+(?:\.\d+)?)\b/g;

type Hit = { file: string; line: number; text: string; size: number };

const collectSourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === "node_modules") return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(path);
    if (!SOURCE_FILE.test(entry.name) || TEST_FILE.test(entry.name)) return [];
    return [path];
  });

const findUndersized = (file: string, pattern: RegExp): Hit[] => {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  return lines.flatMap((text, index) =>
    [...text.matchAll(pattern)]
      .map((match) => ({ file, line: index + 1, text: text.trim(), size: Number(match[1]) }))
      .filter((hit) => hit.size < MIN_FONT_PX),
  );
};

const formatHits = (hits: Hit[]): string =>
  hits
    .map((hit) => `${relative(PROJECT_ROOT, hit.file).replace(/\\/g, "/")}:${hit.line} (${hit.size}px) ${hit.text}`)
    .join("\n");

describe("type scale guard", () => {
  const files = collectSourceFiles(SRC_ROOT);

  it("finds source files to scan", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it(`has no Tailwind arbitrary text size below ${MIN_FONT_PX}px`, () => {
    const hits = files.flatMap((file) => findUndersized(file, TAILWIND_TEXT_SIZE));
    expect(hits, `Use text-xs (${MIN_FONT_PX}px) or larger:\n${formatHits(hits)}`).toEqual([]);
  });

  it(`has no style/SVG fontSize literal below ${MIN_FONT_PX}px`, () => {
    const hits = files.flatMap((file) => findUndersized(file, STYLE_FONT_SIZE));
    expect(hits, `Raise fontSize to ${MIN_FONT_PX} or larger:\n${formatHits(hits)}`).toEqual([]);
  });
});
