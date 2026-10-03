/**
 * Site audit script for https://holderdistributioncom.netlify.app
 * Runs with: node --experimental-vm-modules audit/site-audit.js
 * Or: npx playwright test audit/site-audit.spec.js
 *
 * Uses raw Playwright API (no test runner) so it can be run as a plain Node script.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE_URL = 'https://holderdistributioncom.netlify.app';
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');

if (!fs.existsSync(SCREENSHOTS_DIR)) {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForNetworkIdle(page, timeout = 10000) {
  try {
    await page.waitForLoadState('networkidle', { timeout });
  } catch {
    // networkidle can timeout on long-polling pages; that's OK
  }
}

async function audit() {
  const browser = await chromium.launch({ headless: true });
  const results = {
    pageLoad: {},
    consoleErrors: [],
    networkErrors: [],
    dataLoading: {},
    navigation: {},
    mobileLayout: {},
    brokenLinks: [],
    screenshots: [],
  };

  // ─── DESKTOP AUDIT ───────────────────────────────────────────────────────────
  console.log('\n=== DESKTOP AUDIT (1440px) ===');
  {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
    });
    const page = await context.newPage();

    // Collect console messages
    const consoleMessages = [];
    page.on('console', (msg) => {
      const type = msg.type();
      const text = msg.text();
      consoleMessages.push({ type, text });
      if (type === 'error' || type === 'warn') {
        console.log(`  [CONSOLE ${type.toUpperCase()}] ${text}`);
      }
    });

    // Collect network failures
    const networkFailures = [];
    page.on('requestfailed', (req) => {
      const failure = { url: req.url(), failure: req.failure()?.errorText };
      networkFailures.push(failure);
      console.log(`  [NET FAIL] ${req.url()} — ${req.failure()?.errorText}`);
    });

    // Collect all responses (to detect 4xx/5xx on data fetches)
    const networkResponses = [];
    page.on('response', (resp) => {
      const status = resp.status();
      const url = resp.url();
      if (status >= 400) {
        networkResponses.push({ url, status });
        console.log(`  [HTTP ${status}] ${url}`);
      }
    });

    // ── 1. Page load ──
    console.log('\n-- 1. Page Load --');
    const navStart = Date.now();
    try {
      const response = await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      results.pageLoad.statusCode = response?.status();
      results.pageLoad.ok = response?.ok();
      console.log(`  HTTP ${response?.status()} — ${response?.ok() ? 'OK' : 'FAIL'}`);
    } catch (e) {
      results.pageLoad.error = e.message;
      console.log(`  ERROR: ${e.message}`);
    }

    await waitForNetworkIdle(page);
    results.pageLoad.timeMs = Date.now() - navStart;
    console.log(`  Load time: ${results.pageLoad.timeMs}ms`);

    // ── 2. Title / basic render ──
    console.log('\n-- 2. Basic Render --');
    const title = await page.title();
    console.log(`  Title: "${title}"`);
    results.pageLoad.title = title;

    const h1Visible = await page.locator('h1').first().isVisible().catch(() => false);
    console.log(`  H1 visible: ${h1Visible}`);

    // Check for React root having content (not just an empty div)
    const rootText = await page.locator('#root').innerText().catch(() => '');
    results.pageLoad.hasContent = rootText.length > 50;
    console.log(`  #root has content: ${results.pageLoad.hasContent} (${rootText.length} chars)`);

    // Check for any visible spinner / loading state after idle
    const spinners = await page.locator('.animate-spin').count();
    console.log(`  Spinning loaders visible after idle: ${spinners}`);
    results.pageLoad.spinnersAfterIdle = spinners;

    // Desktop screenshot — initial load
    const ss1 = path.join(SCREENSHOTS_DIR, 'desktop-initial.png');
    await page.screenshot({ path: ss1, fullPage: false });
    results.screenshots.push({ label: 'Desktop initial (1440px)', file: ss1 });
    console.log(`  Screenshot saved: ${ss1}`);

    // ── 3. Navigation / Tabs ──
    console.log('\n-- 3. Navigation / Tabs --');
    const tabs = ['holders', 'distribution', 'supply'];
    for (const tabId of tabs) {
      console.log(`\n  Tab: #${tabId}`);
      await page.goto(`${BASE_URL}#${tabId}`, { waitUntil: 'domcontentloaded' });
      await waitForNetworkIdle(page);
      await sleep(1500); // allow animations + data fetches

      // Check the trigger is marked active
      const trigger = page.locator(`[data-state="active"][value="${tabId}"]`);
      const triggerVisible = await trigger.isVisible().catch(() => false);
      console.log(`    Trigger active: ${triggerVisible}`);

      // Check the content pane has rendered something (not empty)
      const content = page.locator(`[data-state="active"].mt-0`);
      const contentText = await content.innerText().catch(() => '');
      const hasContent = contentText.length > 30;
      console.log(`    Panel has content: ${hasContent} (${contentText.length} chars)`);

      results.navigation[tabId] = { triggerActive: triggerVisible, hasContent };

      const ssTab = path.join(SCREENSHOTS_DIR, `desktop-tab-${tabId}.png`);
      await page.screenshot({ path: ssTab, fullPage: true });
      results.screenshots.push({ label: `Desktop tab: ${tabId}`, file: ssTab });
      console.log(`    Screenshot saved: ${ssTab}`);
    }

    // ── 4. Sub-panel tabs inside Holders ──
    console.log('\n-- 4. Holders Sub-panels --');
    await page.goto(`${BASE_URL}#holders`, { waitUntil: 'domcontentloaded' });
    await waitForNetworkIdle(page);
    await sleep(2000);

    // Sub-panels: trends / balances / staking / flows
    const subPanels = ['trends', 'balances', 'staking', 'flows'];
    for (const panel of subPanels) {
      const btn = page.locator(`[role="tab"]`).filter({ hasText: new RegExp(panel, 'i') }).first();
      const btnVisible = await btn.isVisible().catch(() => false);
      if (btnVisible) {
        await btn.click();
        await sleep(1200);
        const activeContent = await page.locator('[data-state="active"][role="tabpanel"]').last().innerText().catch(() => '');
        console.log(`    Sub-panel "${panel}": clicked OK, content length = ${activeContent.length}`);
        results.navigation[`holders-${panel}`] = { clickable: true, hasContent: activeContent.length > 20 };
      } else {
        console.log(`    Sub-panel "${panel}": NOT FOUND`);
        results.navigation[`holders-${panel}`] = { clickable: false, hasContent: false };
      }
    }

    // ── 5. Data loading checks ──
    console.log('\n-- 5. Data Loading --');
    await page.goto(`${BASE_URL}#holders`, { waitUntil: 'domcontentloaded' });
    await waitForNetworkIdle(page);
    await sleep(3000); // extra wait for data fetches

    // Check KPI tiles
    const kpiTiles = await page.locator('[data-testid*="kpi"], .kpi-tile, [class*="kpi"]').count();
    console.log(`  KPI-looking elements: ${kpiTiles}`);

    // Check for chart SVGs (Recharts renders SVG)
    const svgCharts = await page.locator('svg.recharts-surface').count();
    console.log(`  Recharts SVGs: ${svgCharts}`);
    results.dataLoading.rechartsCharts = svgCharts;

    // Check for any "no data" / "loading" / "error" text
    const bodyText = await page.locator('body').innerText();
    const hasNoData = /no data|no results|unavailable|failed to load/i.test(bodyText);
    const hasLoadingText = /\bloading\b/i.test(bodyText);
    console.log(`  "No data" text found: ${hasNoData}`);
    console.log(`  "Loading" text found: ${hasLoadingText}`);
    results.dataLoading.hasNoDataText = hasNoData;
    results.dataLoading.hasLoadingText = hasLoadingText;

    // Check for table rows
    const tableRows = await page.locator('tbody tr').count();
    console.log(`  Table rows: ${tableRows}`);
    results.dataLoading.tableRows = tableRows;

    // Desktop full-page screenshot after data load
    const ssData = path.join(SCREENSHOTS_DIR, 'desktop-data-loaded.png');
    await page.screenshot({ path: ssData, fullPage: true });
    results.screenshots.push({ label: 'Desktop full page (data loaded)', file: ssData });
    console.log(`  Screenshot saved: ${ssData}`);

    // ── 6. Distribution tab data ──
    console.log('\n-- 6. Distribution Tab Data --');
    await page.goto(`${BASE_URL}#distribution`, { waitUntil: 'domcontentloaded' });
    await waitForNetworkIdle(page);
    await sleep(3000);
    const distCharts = await page.locator('svg.recharts-surface').count();
    console.log(`  Distribution charts: ${distCharts}`);
    results.dataLoading.distributionCharts = distCharts;

    // ── 7. Supply tab data ──
    console.log('\n-- 7. Supply Tab Data --');
    await page.goto(`${BASE_URL}#supply`, { waitUntil: 'domcontentloaded' });
    await waitForNetworkIdle(page);
    await sleep(3000);
    const supplyCharts = await page.locator('svg.recharts-surface').count();
    console.log(`  Supply charts: ${supplyCharts}`);
    results.dataLoading.supplyCharts = supplyCharts;

    // ── 8. Network errors summary ──
    results.networkErrors = [...networkFailures, ...networkResponses];
    console.log(`\n-- 8. Network Errors Summary --`);
    console.log(`  Failed requests: ${networkFailures.length}`);
    console.log(`  4xx/5xx responses: ${networkResponses.length}`);

    // ── 9. Console errors summary ──
    results.consoleErrors = consoleMessages.filter((m) => m.type === 'error');
    console.log(`\n-- 9. Console Errors Summary --`);
    console.log(`  JS errors: ${results.consoleErrors.length}`);
    results.consoleErrors.forEach((e) => console.log(`    ${e.text}`));

    // ── 10. Layout / visual issues ──
    console.log('\n-- 10. Layout Checks --');
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await waitForNetworkIdle(page);
    await sleep(1500);

    // Check for horizontal scroll (overflow)
    const hasHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    console.log(`  Horizontal scroll at 1440px: ${hasHorizontalScroll}`);
    results.mobileLayout.desktopHorizontalScroll = hasHorizontalScroll;

    // Check for overlapping elements using bounding rects of key sections
    const navHeight = await page.locator('nav').first().boundingBox();
    console.log(`  Nav height: ${navHeight?.height}px`);

    // Check for broken images (img elements with no naturalWidth)
    const brokenImages = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      return imgs.filter(img => img.complete && img.naturalWidth === 0).map(img => img.src);
    });
    console.log(`  Broken images: ${brokenImages.length}`);
    if (brokenImages.length) brokenImages.forEach(src => console.log(`    ${src}`));
    results.pageLoad.brokenImages = brokenImages;

    await context.close();
  }

  // ─── MOBILE AUDIT ────────────────────────────────────────────────────────────
  console.log('\n\n=== MOBILE AUDIT (375px) ===');
  {
    const context = await browser.newContext({
      viewport: { width: 375, height: 812 },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1',
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();

    const mobileConsoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') mobileConsoleErrors.push(msg.text());
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await waitForNetworkIdle(page);
    await sleep(2000);

    // ── Mobile layout checks ──
    console.log('\n-- Mobile Layout --');

    // Check for horizontal scroll
    const mobileHorizontalScroll = await page.evaluate(() => {
      return document.documentElement.scrollWidth > document.documentElement.clientWidth;
    });
    console.log(`  Horizontal scroll at 375px: ${mobileHorizontalScroll}`);
    results.mobileLayout.horizontalScroll = mobileHorizontalScroll;

    if (mobileHorizontalScroll) {
      const overflow = await page.evaluate(() => {
        // Find elements wider than the viewport
        const all = document.querySelectorAll('*');
        const viewport = window.innerWidth;
        const offenders = [];
        for (const el of all) {
          const rect = el.getBoundingClientRect();
          if (rect.right > viewport + 5) {
            offenders.push({
              tag: el.tagName,
              class: el.className.toString().slice(0, 80),
              right: Math.round(rect.right),
            });
          }
        }
        return offenders.slice(0, 10);
      });
      console.log(`  Overflow offenders:`);
      overflow.forEach((o) => console.log(`    <${o.tag} class="${o.class}"> right=${o.right}px`));
      results.mobileLayout.overflowElements = overflow;
    }

    // Mobile screenshot
    const ssMobile = path.join(SCREENSHOTS_DIR, 'mobile-initial.png');
    await page.screenshot({ path: ssMobile, fullPage: false });
    results.screenshots.push({ label: 'Mobile initial (375px)', file: ssMobile });
    console.log(`  Screenshot saved: ${ssMobile}`);

    // Mobile screenshot with navigation hamburger
    console.log('\n-- Mobile Hamburger Menu --');
    const hamburger = page.locator('button[aria-label*="menu"], button svg.lucide-menu').first();
    const hamburgerVisible = await hamburger.isVisible().catch(() => false);
    console.log(`  Hamburger button visible: ${hamburgerVisible}`);

    if (hamburgerVisible) {
      await hamburger.click();
      await sleep(500);
      const ssMobileNav = path.join(SCREENSHOTS_DIR, 'mobile-nav-open.png');
      await page.screenshot({ path: ssMobileNav, fullPage: false });
      results.screenshots.push({ label: 'Mobile nav open', file: ssMobileNav });
      console.log(`  Screenshot saved: ${ssMobileNav}`);
      // Close it
      await page.keyboard.press('Escape');
      await sleep(300);
    }

    // Mobile tab switching
    console.log('\n-- Mobile Tab Navigation --');
    const mobileTabs = ['holders', 'distribution', 'supply'];
    for (const tabId of mobileTabs) {
      const trigger = page.locator(`button[value="${tabId}"], [role="tab"][value="${tabId}"]`).first();
      const isVisible = await trigger.isVisible().catch(() => false);
      if (isVisible) {
        await trigger.click();
        await sleep(1200);
        const ssTab = path.join(SCREENSHOTS_DIR, `mobile-tab-${tabId}.png`);
        await page.screenshot({ path: ssTab, fullPage: false });
        results.screenshots.push({ label: `Mobile tab: ${tabId}`, file: ssTab });
        console.log(`  Tab "${tabId}": clicked OK → screenshot saved`);
        results.mobileLayout[`tab-${tabId}`] = { clickable: true };
      } else {
        console.log(`  Tab "${tabId}": NOT VISIBLE`);
        results.mobileLayout[`tab-${tabId}`] = { clickable: false };
      }
    }

    // Mobile full page
    const ssMobileFull = path.join(SCREENSHOTS_DIR, 'mobile-full.png');
    await page.screenshot({ path: ssMobileFull, fullPage: true });
    results.screenshots.push({ label: 'Mobile full page', file: ssMobileFull });
    console.log(`  Full-page mobile screenshot saved: ${ssMobileFull}`);

    results.mobileLayout.consoleErrors = mobileConsoleErrors;

    await context.close();
  }

  // ─── DATA FETCH AUDIT ─────────────────────────────────────────────────────────
  console.log('\n\n=== DATA FETCH AUDIT ===');
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    const fetchedUrls = [];
    const failedFetches = [];

    page.on('response', (resp) => {
      const url = resp.url();
      if (url.includes('/data/')) {
        const status = resp.status();
        fetchedUrls.push({ url, status });
        if (status >= 400) {
          failedFetches.push({ url, status });
          console.log(`  [FAIL ${status}] ${url}`);
        } else {
          console.log(`  [OK   ${status}] ${url}`);
        }
      }
    });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await waitForNetworkIdle(page);
    await sleep(3000); // give lazy hooks time to fire

    // Trigger all tabs to force-load their data
    for (const hash of ['#holders', '#distribution', '#supply']) {
      await page.goto(`${BASE_URL}${hash}`, { waitUntil: 'domcontentloaded' });
      await waitForNetworkIdle(page);
      await sleep(2000);
    }

    results.brokenLinks = failedFetches;
    console.log(`\n  Total /data/ fetches: ${fetchedUrls.length}`);
    console.log(`  Failed /data/ fetches: ${failedFetches.length}`);

    await context.close();
  }

  // ─── FINAL SUMMARY ───────────────────────────────────────────────────────────
  console.log('\n\n========== AUDIT SUMMARY ==========\n');

  console.log('PAGE LOAD:');
  console.log(`  HTTP status: ${results.pageLoad.statusCode}`);
  console.log(`  Load time: ${results.pageLoad.timeMs}ms`);
  console.log(`  Title: "${results.pageLoad.title}"`);
  console.log(`  Has content: ${results.pageLoad.hasContent}`);
  console.log(`  Spinning loaders after idle: ${results.pageLoad.spinnersAfterIdle}`);
  console.log(`  Broken images: ${results.pageLoad.brokenImages?.length ?? 0}`);

  console.log('\nDATA LOADING:');
  console.log(`  Recharts SVGs (holders tab): ${results.dataLoading.rechartsCharts}`);
  console.log(`  Distribution charts: ${results.dataLoading.distributionCharts}`);
  console.log(`  Supply charts: ${results.dataLoading.supplyCharts}`);
  console.log(`  Table rows visible: ${results.dataLoading.tableRows}`);
  console.log(`  "No data" text: ${results.dataLoading.hasNoDataText}`);
  console.log(`  "Loading" text: ${results.dataLoading.hasLoadingText}`);

  console.log('\nNAVIGATION:');
  Object.entries(results.navigation).forEach(([k, v]) => {
    console.log(`  ${k}: trigger=${v.triggerActive ?? 'n/a'}, hasContent=${v.hasContent}, clickable=${v.clickable ?? 'n/a'}`);
  });

  console.log('\nMOBILE (375px):');
  console.log(`  Horizontal scroll: ${results.mobileLayout.horizontalScroll}`);
  if (results.mobileLayout.overflowElements?.length) {
    console.log(`  Overflow elements: ${results.mobileLayout.overflowElements.length}`);
  }

  console.log('\nNETWORK ERRORS:');
  if (results.networkErrors.length === 0) {
    console.log('  None');
  } else {
    results.networkErrors.forEach((e) => console.log(`  [${e.status ?? 'FAIL'}] ${e.url}`));
  }

  console.log('\nBROKEN /data/ FETCHES:');
  if (results.brokenLinks.length === 0) {
    console.log('  None');
  } else {
    results.brokenLinks.forEach((e) => console.log(`  [${e.status}] ${e.url}`));
  }

  console.log('\nCONSOLE ERRORS:');
  if (results.consoleErrors.length === 0) {
    console.log('  None');
  } else {
    results.consoleErrors.forEach((e) => console.log(`  ${e.text}`));
  }

  console.log('\nSCREENSHOTS:');
  results.screenshots.forEach((s) => console.log(`  ${s.label}: ${s.file}`));

  // Write JSON results
  const resultsFile = path.join(__dirname, 'audit-results.json');
  fs.writeFileSync(resultsFile, JSON.stringify(results, null, 2));
  console.log(`\nFull results written to: ${resultsFile}`);

  await browser.close();
  return results;
}

audit().catch((err) => {
  console.error('Audit failed:', err);
  process.exit(1);
});
