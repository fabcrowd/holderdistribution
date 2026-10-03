/**
 * Live site audit for https://holderdistribution.com
 * Checks: page load, console errors, network errors, JSON endpoints,
 *         banners, chart/table render, desktop + mobile viewports.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const SITE = 'https://holderdistribution.com';
const OUT  = path.join(__dirname, 'screenshots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const DATA_ENDPOINTS = [
  `${SITE}/data/holders.json`,
  `${SITE}/data/tokenomics.json`,
  `${SITE}/data/history.json`,
];

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'mobile',  width: 390,  height: 844 },
];

function ts() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function auditEndpoints(context, report) {
  console.log('\n=== DATA ENDPOINT CHECKS ===');
  report.endpoints = [];

  for (const url of DATA_ENDPOINTS) {
    const page = await context.newPage();
    try {
      const resp = await page.goto(url, { timeout: 15000 });
      const status = resp ? resp.status() : 'no-response';
      let body = null;
      let parseError = null;
      let keys = null;

      if (resp && resp.ok()) {
        try {
          body = await resp.text();
          const parsed = JSON.parse(body);
          keys = Array.isArray(parsed)
            ? `Array(${parsed.length})`
            : Object.keys(parsed).slice(0, 5).join(', ');
        } catch (e) {
          parseError = e.message;
        }
      }

      const result = { url, status, keys, parseError, bodySnippet: body ? body.slice(0, 200) : null };
      report.endpoints.push(result);

      console.log(`  ${url}`);
      console.log(`    HTTP ${status}  keys/length: ${keys || 'N/A'}  parseError: ${parseError || 'none'}`);
    } catch (e) {
      const result = { url, status: 'ERROR', error: e.message };
      report.endpoints.push(result);
      console.log(`  ${url}  → ERROR: ${e.message}`);
    } finally {
      await page.close();
    }
  }
}

async function auditViewport(context, viewport, report) {
  console.log(`\n=== VIEWPORT: ${viewport.name} (${viewport.width}x${viewport.height}) ===`);
  const vp = { name: viewport.name, consoleMessages: [], networkErrors: [], jsErrors: [] };

  const page = await context.newPage();
  await page.setViewportSize({ width: viewport.width, height: viewport.height });

  // Capture ALL console messages
  page.on('console', msg => {
    const entry = { type: msg.type(), text: msg.text() };
    vp.consoleMessages.push(entry);
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log(`  CONSOLE [${msg.type()}]: ${msg.text()}`);
    }
  });

  // Capture page errors (uncaught JS exceptions)
  page.on('pageerror', err => {
    vp.jsErrors.push({ message: err.message, stack: err.stack });
    console.log(`  JS ERROR: ${err.message}`);
  });

  // Capture failed network requests
  page.on('requestfailed', req => {
    const entry = { url: req.url(), method: req.method(), failure: req.failure()?.errorText };
    vp.networkErrors.push(entry);
    console.log(`  NETWORK FAIL: ${req.method()} ${req.url()} — ${req.failure()?.errorText}`);
  });

  // Track all responses (look for non-2xx on key URLs)
  const responses = [];
  page.on('response', resp => {
    if (!resp.ok() && resp.status() !== 304) {
      const entry = { url: resp.url(), status: resp.status() };
      responses.push(entry);
      console.log(`  HTTP ${resp.status()}: ${resp.url()}`);
    }
  });

  // --- LOAD PAGE ---
  let loadError = null;
  try {
    await page.goto(SITE, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) {
    loadError = e.message;
    console.log(`  PAGE LOAD ERROR: ${e.message}`);
  }

  vp.loadError = loadError;
  vp.badResponses = responses;

  // Screenshot immediately after load
  const shotInitial = `${viewport.name}-01-initial-${ts()}.png`;
  await page.screenshot({ path: path.join(OUT, shotInitial), fullPage: false });
  console.log(`  Screenshot saved: ${shotInitial}`);

  // Full page screenshot
  const shotFull = `${viewport.name}-02-fullpage-${ts()}.png`;
  await page.screenshot({ path: path.join(OUT, shotFull), fullPage: true });
  console.log(`  Screenshot saved: ${shotFull}`);

  // --- CHECK FOR BANNERS / ERROR MESSAGES ---
  const bannerTexts = [];
  const bannerSelectors = [
    '[class*="error"]',
    '[class*="banner"]',
    '[class*="alert"]',
    '[class*="warning"]',
    '[class*="stale"]',
    '[class*="feed"]',
    '[role="alert"]',
    '[data-testid*="error"]',
    '[data-testid*="banner"]',
  ];

  for (const sel of bannerSelectors) {
    try {
      const els = await page.locator(sel).all();
      for (const el of els) {
        const visible = await el.isVisible();
        if (visible) {
          const text = (await el.textContent() || '').trim();
          if (text) {
            bannerTexts.push({ selector: sel, text: text.slice(0, 300) });
            console.log(`  BANNER [${sel}]: "${text.slice(0, 200)}"`);
          }
        }
      }
    } catch (_) {}
  }
  vp.banners = bannerTexts;

  // --- LOOK FOR "feed error" or "stale" text anywhere on page ---
  const pageText = await page.evaluate(() => document.body.innerText);
  const feedErrorMatch = pageText.match(/(feed error|stale data|failed to fetch|error loading|no data|could not load|network error|undefined|NaN)[^\n]*/gi);
  vp.feedErrorMatches = feedErrorMatch || [];
  if (feedErrorMatch && feedErrorMatch.length > 0) {
    console.log(`  FEED/ERROR TEXT FOUND:`);
    feedErrorMatch.forEach(m => console.log(`    "${m}"`));
  }

  // --- CHECK CHARTS ---
  // Look for canvas elements (Chart.js/echarts), SVG charts, or chart containers
  const chartInfo = await page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const svgs = Array.from(document.querySelectorAll('svg'));
    const chartContainers = Array.from(document.querySelectorAll(
      '[class*="chart"], [class*="Chart"], [id*="chart"], [id*="Chart"], [data-testid*="chart"]'
    ));

    return {
      canvasCount: canvases.length,
      canvasDimensions: canvases.map(c => ({ w: c.width, h: c.height, clientW: c.clientWidth, clientH: c.clientHeight })),
      svgCount: svgs.length,
      svgWithData: svgs.filter(s => s.children.length > 3).length,
      chartContainerCount: chartContainers.length,
      chartContainerTexts: chartContainers.slice(0, 5).map(el => el.textContent?.trim().slice(0, 100)),
    };
  });
  vp.charts = chartInfo;
  console.log(`  Charts: ${chartInfo.canvasCount} canvas, ${chartInfo.svgCount} SVG (${chartInfo.svgWithData} with data), ${chartInfo.chartContainerCount} chart containers`);

  // --- CHECK TABLES ---
  const tableInfo = await page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    const tbodies = Array.from(document.querySelectorAll('tbody'));
    return {
      tableCount: tables.length,
      rowCounts: tbodies.map(tb => tb.querySelectorAll('tr').length),
      emptyTables: tbodies.filter(tb => tb.querySelectorAll('tr').length === 0).length,
    };
  });
  vp.tables = tableInfo;
  console.log(`  Tables: ${tableInfo.tableCount} total, row counts: ${JSON.stringify(tableInfo.rowCounts)}, empty: ${tableInfo.emptyTables}`);

  // --- CHECK FOR DATA RENDERED IN PAGE ---
  // Look for numbers that look like holder counts, percentages, etc.
  const dataPresence = await page.evaluate(() => {
    const text = document.body.innerText;
    return {
      hasNumbers: /\d{3,}/.test(text),
      hasPercentages: /\d+(\.\d+)?%/.test(text),
      hasDollarAmounts: /\$[\d,]+/.test(text),
      bodyTextLength: text.length,
      firstChars: text.slice(0, 500),
    };
  });
  vp.dataPresence = dataPresence;
  console.log(`  Page text length: ${dataPresence.bodyTextLength} chars, hasNumbers: ${dataPresence.hasNumbers}, hasPercentages: ${dataPresence.hasPercentages}`);

  // --- SCROLL DOWN and screenshot ---
  try {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2));
    await page.waitForTimeout(1000);
    const shotMid = `${viewport.name}-03-scrollmid-${ts()}.png`;
    await page.screenshot({ path: path.join(OUT, shotMid), fullPage: false });
    console.log(`  Screenshot saved: ${shotMid}`);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1000);
    const shotBottom = `${viewport.name}-04-scrollbottom-${ts()}.png`;
    await page.screenshot({ path: path.join(OUT, shotBottom), fullPage: false });
    console.log(`  Screenshot saved: ${shotBottom}`);
  } catch (_) {}

  // --- GET PAGE TITLE and H1 ---
  const title = await page.title();
  const h1 = await page.locator('h1').first().textContent().catch(() => 'N/A');
  vp.title = title;
  vp.h1 = h1;
  console.log(`  Title: "${title}"`);
  console.log(`  H1: "${h1}"`);

  // Capture full DOM structure for deep inspection
  const domSnippet = await page.evaluate(() => document.documentElement.innerHTML.slice(0, 3000));
  vp.domSnippet = domSnippet;

  await page.close();
  report.viewports.push(vp);
}

async function main() {
  const report = { timestamp: new Date().toISOString(), endpoints: [], viewports: [] };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: false,
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });

  console.log('=== HOLDERDISTRIBUTION.COM LIVE AUDIT ===');
  console.log(`Timestamp: ${report.timestamp}`);
  console.log(`Target: ${SITE}`);

  // 1. Check JSON endpoints
  await auditEndpoints(context, report);

  // 2. Audit each viewport
  for (const vp of VIEWPORTS) {
    await auditViewport(context, vp, report);
  }

  await browser.close();

  // Save report
  const reportPath = path.join(__dirname, 'audit-results.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\n=== AUDIT COMPLETE ===`);
  console.log(`Report saved: ${reportPath}`);
  console.log(`Screenshots: ${OUT}`);

  // Print summary
  console.log('\n=== SUMMARY ===');
  console.log('Endpoints:');
  report.endpoints.forEach(ep => {
    console.log(`  ${ep.url} → HTTP ${ep.status} | ${ep.keys || ep.error || 'empty'}`);
  });

  report.viewports.forEach(vp => {
    console.log(`\nViewport: ${vp.name}`);
    console.log(`  Load error: ${vp.loadError || 'none'}`);
    console.log(`  JS errors: ${vp.jsErrors.length}`);
    vp.jsErrors.forEach(e => console.log(`    - ${e.message}`));
    console.log(`  Console errors: ${vp.consoleMessages.filter(m => m.type === 'error').length}`);
    vp.consoleMessages.filter(m => m.type === 'error').forEach(m => console.log(`    - ${m.text}`));
    console.log(`  Network failures: ${vp.networkErrors.length}`);
    vp.networkErrors.forEach(e => console.log(`    - ${e.url}: ${e.failure}`));
    console.log(`  Banners: ${vp.banners.length}`);
    vp.banners.forEach(b => console.log(`    - [${b.selector}] "${b.text}"`));
    console.log(`  Feed/error text matches: ${vp.feedErrorMatches.length}`);
    vp.feedErrorMatches.forEach(m => console.log(`    - "${m}"`));
    console.log(`  Charts: ${JSON.stringify(vp.charts)}`);
    console.log(`  Tables: ${JSON.stringify(vp.tables)}`);
  });
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
