/**
 * Audit the locally-served production build at http://localhost:7777
 * This mirrors what is deployed on holderdistribution.com.
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:7777';
const OUT  = path.join(__dirname, 'screenshots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

// The files the audit task mentioned vs what actually exists
const DATA_ENDPOINTS = [
  // What the task asked about (may not exist)
  `${BASE}/data/holders.json`,
  `${BASE}/data/tokenomics.json`,
  `${BASE}/data/history.json`,
  // What actually exists in public/data
  `${BASE}/data/holders-lite.json`,
  `${BASE}/data/holders-history.json`,
  `${BASE}/data/holders-summary.json`,
  `${BASE}/data/treasury-history.json`,
  `${BASE}/data/cex-balance-history.json`,
  `${BASE}/data/exchange-flow-history.json`,
  `${BASE}/data/tier-outflows.json`,
  `${BASE}/data/supply-reconciliation.json`,
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
      const resp = await page.goto(url, { timeout: 10000 });
      const status = resp ? resp.status() : 'no-response';
      let body = null;
      let parseError = null;
      let keys = null;
      let sizeKb = null;

      if (resp) {
        try {
          body = await resp.text();
          sizeKb = (body.length / 1024).toFixed(1);
          if (resp.ok()) {
            const parsed = JSON.parse(body);
            keys = Array.isArray(parsed)
              ? `Array(${parsed.length})`
              : Object.keys(parsed).slice(0, 8).join(', ');
          }
        } catch (e) {
          parseError = e.message;
        }
      }

      const result = { url, status, keys, parseError, sizeKb, bodySnippet: body ? body.slice(0, 300) : null };
      report.endpoints.push(result);

      const short = url.replace(BASE, '');
      console.log(`  ${short.padEnd(45)} HTTP ${status}  ${sizeKb ? sizeKb + 'kB' : ''}  ${keys || parseError || 'empty'}`);
    } catch (e) {
      const result = { url, status: 'ERROR', error: e.message };
      report.endpoints.push(result);
      const short = url.replace(BASE, '');
      console.log(`  ${short.padEnd(45)} ERROR: ${e.message.split('\n')[0]}`);
    } finally {
      await page.close();
    }
  }
}

async function auditViewport(context, viewport, report) {
  console.log(`\n=== VIEWPORT: ${viewport.name} (${viewport.width}x${viewport.height}) ===`);
  const vp = { name: viewport.name, consoleMessages: [], networkErrors: [], jsErrors: [], networkRequests: [] };

  const page = await context.newPage();
  await page.setViewportSize({ width: viewport.width, height: viewport.height });

  // Capture ALL console messages
  page.on('console', msg => {
    const entry = { type: msg.type(), text: msg.text() };
    vp.consoleMessages.push(entry);
    if (msg.type() === 'error') {
      console.log(`  CONSOLE ERROR: ${msg.text()}`);
    } else if (msg.type() === 'warning') {
      console.log(`  CONSOLE WARN: ${msg.text()}`);
    }
  });

  // Capture page errors (uncaught JS exceptions)
  page.on('pageerror', err => {
    vp.jsErrors.push({ message: err.message, stack: err.stack });
    console.log(`  JS EXCEPTION: ${err.message}`);
  });

  // Capture failed network requests
  page.on('requestfailed', req => {
    const entry = { url: req.url(), method: req.method(), failure: req.failure()?.errorText };
    vp.networkErrors.push(entry);
    console.log(`  NETWORK FAIL: ${req.method()} ${req.url().replace(BASE,'')} — ${req.failure()?.errorText}`);
  });

  // Track non-2xx responses
  const badResponses = [];
  page.on('response', resp => {
    if (!resp.ok() && resp.status() !== 304) {
      const entry = { url: resp.url().replace(BASE,''), status: resp.status() };
      badResponses.push(entry);
      console.log(`  HTTP ${resp.status()}: ${resp.url().replace(BASE,'')}`);
    }
    // Track data fetches specifically
    if (resp.url().includes('/data/') || resp.url().includes('.json')) {
      vp.networkRequests.push({ url: resp.url().replace(BASE,''), status: resp.status() });
    }
  });

  // --- LOAD PAGE ---
  let loadError = null;
  try {
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 20000 });
  } catch (e) {
    loadError = e.message.split('\n')[0];
    console.log(`  PAGE LOAD ERROR: ${loadError}`);
  }

  vp.loadError = loadError;
  vp.badResponses = badResponses;

  // Wait a bit for async data loading
  await page.waitForTimeout(3000);

  // Screenshot immediately after load + data settle
  const shotInitial = `${viewport.name}-01-initial-${ts()}.png`;
  await page.screenshot({ path: path.join(OUT, shotInitial), fullPage: false });
  console.log(`  Screenshot: ${shotInitial}`);

  // Full page screenshot
  const shotFull = `${viewport.name}-02-fullpage-${ts()}.png`;
  await page.screenshot({ path: path.join(OUT, shotFull), fullPage: true });
  console.log(`  Screenshot: ${shotFull}`);

  // --- CHECK FOR BANNERS / ERROR MESSAGES ---
  const bannerTexts = [];
  const bannerSelectors = [
    '[class*="error"]:not(script)',
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
        const visible = await el.isVisible().catch(() => false);
        if (visible) {
          const text = (await el.textContent().catch(() => '') || '').trim();
          if (text && text.length > 3) {
            bannerTexts.push({ selector: sel, text: text.slice(0, 400) });
            console.log(`  BANNER [${sel}]: "${text.slice(0, 200)}"`);
          }
        }
      }
    } catch (_) {}
  }
  vp.banners = bannerTexts;

  // --- LOOK FOR ERROR/WARNING TEXT ON PAGE ---
  const pageText = await page.evaluate(() => document.body.innerText);
  const errorMatches = pageText.match(/(feed error|stale data|failed to fetch|error loading|no data|could not load|network error|something went wrong|data unavailable|unable to load|404|503|500)[^\n]*/gi);
  vp.errorTextMatches = errorMatches || [];
  if (errorMatches && errorMatches.length > 0) {
    console.log(`  ERROR TEXT ON PAGE:`);
    errorMatches.forEach(m => console.log(`    "${m}"`));
  }

  // --- CHECK CHARTS ---
  const chartInfo = await page.evaluate(() => {
    const canvases = Array.from(document.querySelectorAll('canvas'));
    const svgs = Array.from(document.querySelectorAll('svg'));
    const chartContainers = Array.from(document.querySelectorAll(
      '[class*="chart"], [class*="Chart"], [id*="chart"], [id*="Chart"]'
    ));
    const rechartWrappers = Array.from(document.querySelectorAll('.recharts-wrapper'));
    const echartsContainers = Array.from(document.querySelectorAll('[_echarts_instance_]'));

    return {
      canvasCount: canvases.length,
      canvasDimensions: canvases.map(c => ({ w: c.width, h: c.height, visible: c.clientWidth > 0 })),
      svgCount: svgs.length,
      svgWithChildren: svgs.filter(s => s.children.length > 3).length,
      chartContainerCount: chartContainers.length,
      rechartWrappersCount: rechartWrappers.length,
      echartsCount: echartsContainers.length,
      svgPaths: svgs.filter(s => s.querySelectorAll('path').length > 0).length,
    };
  });
  vp.charts = chartInfo;
  console.log(`  Charts: canvas=${chartInfo.canvasCount}, svg=${chartInfo.svgCount} (${chartInfo.svgWithChildren} with children, ${chartInfo.svgPaths} with paths), recharts=${chartInfo.rechartWrappersCount}, echarts=${chartInfo.echartsCount}`);

  // --- CHECK TABLES ---
  const tableInfo = await page.evaluate(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    const tbodies = Array.from(document.querySelectorAll('tbody'));
    return {
      tableCount: tables.length,
      rowCounts: tbodies.map(tb => tb.querySelectorAll('tr').length),
      emptyTables: tbodies.filter(tb => tb.querySelectorAll('tr').length === 0).length,
      tableHeaders: tables.map(t => Array.from(t.querySelectorAll('th')).map(th => th.textContent?.trim()).slice(0, 5)),
    };
  });
  vp.tables = tableInfo;
  console.log(`  Tables: count=${tableInfo.tableCount}, rowCounts=${JSON.stringify(tableInfo.rowCounts)}, emptyTables=${tableInfo.emptyTables}`);

  // --- DETECT KEY VISUAL CONTENT ---
  const contentCheck = await page.evaluate(() => {
    const text = document.body.innerText;
    const allText = document.body.innerHTML;

    // Look for specific content patterns
    return {
      bodyTextLength: text.length,
      hasHolderCountNumbers: /\d{1,3}(,\d{3})+/.test(text),  // formatted numbers like 1,234,567
      hasPercentages: /\d+(\.\d+)?%/.test(text),
      hasTokenAmounts: /\d[\d,.]+\s*(TEL|MATIC|ETH|BTC)/i.test(text),
      hasDates: /\d{4}-\d{2}-\d{2}|\w+ \d{1,2}, \d{4}/.test(text),
      hasLoadingSpinner: /loading|spinner|skeleton/i.test(allText),
      visibleText: text.slice(0, 1000),
    };
  });
  vp.contentCheck = contentCheck;
  console.log(`  Content: length=${contentCheck.bodyTextLength}, hasNumbers=${contentCheck.hasHolderCountNumbers}, hasPercentages=${contentCheck.hasPercentages}, hasLoading=${contentCheck.hasLoadingSpinner}`);
  if (contentCheck.visibleText.length > 0) {
    console.log(`  First 500 chars of page text:\n    ${contentCheck.visibleText.slice(0, 500).replace(/\n/g, '\n    ')}`);
  }

  // --- SCROLL AND SCREENSHOT ---
  try {
    await page.evaluate(() => window.scrollTo(0, 500));
    await page.waitForTimeout(800);
    const shotS1 = `${viewport.name}-03-scroll500-${ts()}.png`;
    await page.screenshot({ path: path.join(OUT, shotS1), fullPage: false });
    console.log(`  Screenshot: ${shotS1}`);

    await page.evaluate(() => window.scrollTo(0, 1500));
    await page.waitForTimeout(800);
    const shotS2 = `${viewport.name}-04-scroll1500-${ts()}.png`;
    await page.screenshot({ path: path.join(OUT, shotS2), fullPage: false });
    console.log(`  Screenshot: ${shotS2}`);

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(800);
    const shotBottom = `${viewport.name}-05-bottom-${ts()}.png`;
    await page.screenshot({ path: path.join(OUT, shotBottom), fullPage: false });
    console.log(`  Screenshot: ${shotBottom}`);
  } catch (e) {
    console.log(`  Scroll error: ${e.message}`);
  }

  // --- PAGE META ---
  const title = await page.title();
  const h1s = await page.locator('h1').allTextContents().catch(() => []);
  const h2s = await page.locator('h2').allTextContents().catch(() => []);
  vp.title = title;
  vp.h1s = h1s;
  vp.h2s = h2s.slice(0, 10);
  console.log(`  Title: "${title}"`);
  console.log(`  H1s: ${JSON.stringify(h1s)}`);
  console.log(`  H2s: ${JSON.stringify(h2s.slice(0, 5))}`);

  // --- NETWORK REQUESTS SUMMARY ---
  console.log(`  Data fetches: ${JSON.stringify(vp.networkRequests)}`);
  console.log(`  Console errors total: ${vp.consoleMessages.filter(m=>m.type==='error').length}`);
  vp.consoleMessages.filter(m=>m.type==='error').forEach(m => console.log(`    [ERROR] ${m.text}`));

  await page.close();
  report.viewports.push(vp);
}

async function main() {
  const report = { timestamp: new Date().toISOString(), base: BASE, endpoints: [], viewports: [] };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ignoreHTTPSErrors: false,
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });

  console.log('=== LOCAL PRODUCTION BUILD AUDIT ===');
  console.log(`Timestamp: ${report.timestamp}`);
  console.log(`Target: ${BASE} (mirrors holderdistribution.com deployment)`);

  await auditEndpoints(context, report);

  for (const vp of VIEWPORTS) {
    await auditViewport(context, vp, report);
  }

  await browser.close();

  const reportPath = path.join(__dirname, 'local-audit-results.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport: ${reportPath}`);
  console.log(`Screenshots: ${OUT}`);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
