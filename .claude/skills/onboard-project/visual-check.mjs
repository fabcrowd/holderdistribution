// Visual check for one token's page (onboard-project skill, Step 5b).
//
// It opens the landing page and /<slug> in headless Chrome at 1440x900 and 390x844, clicks each tab,
// and writes one screenshot (.png) and one text dump (.txt) per page, tab and width, plus report.json.
// Exit codes: 0 = every view clean; 1 = a defect was found (a page logs a console error, scrolls
// sideways, shows the error page or "Page not found", prints NaN / undefined / Infinity, is nearly
// empty, or a tab cannot be found or leads away from /<slug>); 2 = the check could not run to the end
// (nothing answers on --base, playwright-core or Chrome is missing, or a navigation or click failed).
// A failed view is recorded in report.json and the remaining views still run.
// It does NOT compare numbers with the feeds: read the .txt dumps against public/data/<slug>/ yourself.
//
// At 1440 wide the token page is TerminalDashboard: the document does not scroll, <main> does. So the
// sideways-scroll check also measures <main>, and the screenshot is taken with the viewport grown to
// the height of <main>'s full content.
//
// Start the preview first (never `npm run dev` or `npm run build`; they rewrite public/sitemap.xml):
//   npx vite --port 5197 --strictPort --host 127.0.0.1
// Then:
//   node .claude/skills/onboard-project/visual-check.mjs --slug <slug> --out <scratch dir>
//
// playwright-core is not a dependency of this repo. Pass the folder that holds it with --playwright
// or PLAYWRIGHT_DIR; the default is where it is installed on the owner's machine. To get it elsewhere,
// install it outside the repo: `npm install --prefix <scratch dir> playwright-core`, then pass
// --playwright <scratch dir>/node_modules. It drives the installed Chrome (--chrome or CHROME_PATH),
// so no browser download is needed. --base sets the preview URL (default http://127.0.0.1:5197).
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const slug = arg("slug");
const outDir = arg("out");
if (!slug || !outDir) {
  console.error("Usage: node visual-check.mjs --slug <slug> --out <dir> [--base <url>] [--tabs A,B,C] [--playwright <node_modules dir>] [--chrome <chrome.exe>]");
  process.exit(2);
}
const baseUrl = arg("base", "http://127.0.0.1:5197").replace(/\/$/, "");
const tabs = arg("tabs", "Holders,Distribution,Supply").split(",").map((t) => t.trim()).filter(Boolean);
const playwrightDir = arg("playwright", process.env.PLAYWRIGHT_DIR ?? "C:/repos/projects/test/node_modules/");
const chromePath = arg("chrome", process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe");

const SIZES = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "390x844", width: 390, height: 844 },
];
const BAD_TEXT = /NaN|undefined|Infinity|Something went wrong|Page not found/g;
const SETTLE_MS = 2500;
const NAV_TIMEOUT_MS = 120000;
const MAX_DETAILS = 20;
const ERROR_LIMIT = 200;

let chromium;
try {
  ({ chromium } = createRequire(playwrightDir.replace(/[\\/]?$/, "/"))("playwright-core"));
} catch {
  console.error(`playwright-core was not found under ${playwrightDir}. Pass --playwright <a node_modules folder that has it>.`);
  process.exit(2);
}

try {
  await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(10000) });
} catch {
  console.error(`Nothing answers on ${baseUrl}. Start the preview, or pass --base http://127.0.0.1:<port> when it runs on another port.`);
  process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });
const report = [];

/** Scroll the document and <main> once so lazily rendered widgets mount, then return to the top. */
const scrollThrough = async (page) => {
  const height = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.querySelector("main")?.scrollHeight ?? 0));
  for (let y = 0; y < height; y += 700) {
    await page.evaluate((v) => { window.scrollTo(0, v); document.querySelector("main")?.scrollTo(0, v); }, y);
    await page.waitForTimeout(200);
  }
  await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector("main")?.scrollTo(0, 0); });
  await page.waitForTimeout(600);
};

/** Open the collapsed "Details: ..." accordions so their content is in the screenshot and the text dump. */
const openDetails = async (page) => {
  for (let i = 0; i < MAX_DETAILS; i += 1) {
    const closed = page.locator("button[aria-expanded='false']").filter({ hasText: /^\s*Details/ }).first();
    if (!(await closed.count())) return;
    await closed.click().catch(() => {});
    await page.waitForTimeout(400);
  }
};

const capture = async (page, name, size, errors, extra = {}) => {
  await openDetails(page);
  await scrollThrough(page);
  const metrics = await page.evaluate(() => {
    const main = document.querySelector("main");
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      main: main ? { scrollWidth: main.scrollWidth, clientWidth: main.clientWidth, hiddenHeight: main.scrollHeight - main.clientHeight } : null,
      text: document.body.innerText,
    };
  });
  const base = path.join(outDir, `${name}-${size.name}`);
  // A scrolling <main> inside a viewport-high shell is clipped by fullPage: grow the viewport by the hidden height.
  const grow = metrics.main && metrics.main.hiddenHeight > 0 ? metrics.main.hiddenHeight : 0;
  if (grow) await page.setViewportSize({ width: size.width, height: size.height + grow });
  try {
    if (grow) await page.waitForTimeout(600);
    await page.screenshot({ path: `${base}.png`, fullPage: true });
  } finally {
    if (grow) await page.setViewportSize({ width: size.width, height: size.height });
  }
  fs.writeFileSync(`${base}.txt`, metrics.text);
  const badText = [...new Set(metrics.text.match(BAD_TEXT) ?? [])];
  const problems = [
    ...errors.map((e) => `console: ${e}`),
    ...(metrics.scrollWidth > metrics.clientWidth ? [`scrolls sideways: ${metrics.scrollWidth} > ${metrics.clientWidth}`] : []),
    ...(metrics.main && metrics.main.scrollWidth > metrics.main.clientWidth ? [`main scrolls sideways: ${metrics.main.scrollWidth} > ${metrics.main.clientWidth}`] : []),
    ...(badText.length ? [`text contains ${badText.join(", ")}`] : []),
    ...(metrics.text.trim().length < 200 ? ["page is nearly empty"] : []),
    ...(extra.problem ? [extra.problem] : []),
  ];
  report.push({ view: name, size: size.name, screenshot: `${base}.png`, text: `${base}.txt`, chars: metrics.text.length, problems });
};

/** Run one view; an exception becomes a recorded run error for that view and the check goes on. */
const guarded = async (name, size, step) => {
  try {
    await step();
  } catch (err) {
    report.push({ view: name, size: size.name, screenshot: null, text: null, chars: 0, runError: true, problems: [`could not run: ${String(err.message ?? err).split("\n")[0].slice(0, ERROR_LIMIT)}`] });
  }
};

const openPage = async (page, url) => {
  await page.goto(url, { waitUntil: "networkidle", timeout: NAV_TIMEOUT_MS });
  await page.waitForTimeout(SETTLE_MS);
};

/** Click the tab; it is a link at desktop width and a tab at phone width. Returns false if none matched. */
const clickTab = async (page, tab) => {
  for (const role of ["tab", "link", "button"]) {
    const target = page.getByRole(role, { name: tab, exact: true }).first();
    if (await target.count()) {
      await target.click({ timeout: 30000 });
      return true;
    }
  }
  return false;
};

let browser;
try {
  browser = await chromium.launch({ executablePath: chromePath, headless: true });
} catch (err) {
  console.error(`Chrome could not be started from ${chromePath} (${String(err.message ?? err).split("\n")[0]}). Pass --chrome <chrome.exe>.`);
  process.exit(2);
}
try {
  for (const size of SIZES) {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height } });
    const page = await context.newPage();
    let errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, ERROR_LIMIT)); });
    page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, ERROR_LIMIT)}`));

    await guarded("landing", size, async () => {
      errors = [];
      await openPage(page, `${baseUrl}/`);
      await capture(page, "landing", size, errors);
    });
    await guarded(slug, size, async () => {
      errors = [];
      await openPage(page, `${baseUrl}/${slug}`);
      await capture(page, slug, size, errors);
    });
    for (const tab of tabs) {
      const view = `${slug}-${tab.toLowerCase().replace(/\s+/g, "-")}`;
      await guarded(view, size, async () => {
        errors = [];
        // Every tab starts from the token page, whatever the previous click did.
        await openPage(page, `${baseUrl}/${slug}`);
        errors = [];
        const clicked = await clickTab(page, tab);
        await page.waitForTimeout(SETTLE_MS);
        // A same-named link elsewhere on the page must not pass as the tab: the click has to stay on the token's page.
        const pathname = new URL(page.url()).pathname;
        const onToken = pathname === `/${slug}` || pathname.startsWith(`/${slug}/`);
        const problem = !clicked ? `tab "${tab}" was not found` : !onToken ? `tab "${tab}" left the token page for ${pathname}` : null;
        await capture(page, view, size, errors, problem ? { problem } : {});
      });
    }
    await context.close().catch(() => {});
  }
} finally {
  await browser.close().catch(() => {});
}

fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 1)}\n`);
const failed = report.filter((r) => r.problems.length);
for (const r of report) console.log(`${r.problems.length ? "FAIL" : "PASS"} ${r.view} ${r.size}${r.problems.length ? `: ${r.problems.join("; ")}` : ""}`);
console.log(`${report.length - failed.length} of ${report.length} views clean. Report: ${path.join(outDir, "report.json")}`);
process.exit(report.some((r) => r.runError) ? 2 : failed.length ? 1 : 0);
