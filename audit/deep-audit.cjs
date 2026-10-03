/**
 * Deep-dive audit targeting specific issues found in the initial audit.
 */
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const BASE_URL = 'https://holderdistributioncom.netlify.app';
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForNetworkIdle(page, timeout = 15000) {
  try { await page.waitForLoadState('networkidle', { timeout }); } catch {}
}

async function audit() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
  });
  const page = await context.newPage();

  const allConsole = [];
  page.on('console', (msg) => {
    allConsole.push({ type: msg.type(), text: msg.text() });
  });

  const allResponses = [];
  page.on('response', (r) => {
    allResponses.push({ url: r.url(), status: r.status() });
  });

  // ── ISSUE 1: "Feed error — node offline" alert ──────────────────────────────
  console.log('\n=== ISSUE 1: FEED ERROR ALERT ===');
  await page.goto(`${BASE_URL}#holders`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForNetworkIdle(page);
  await sleep(4000); // Let all lazy fetches complete

  // Find the red error alert visible in the Holder Growth chart
  const errorAlerts = await page.locator('[role="alert"], .text-destructive, .text-red-500, [class*="destructive"]').all();
  console.log(`  Error/destructive elements: ${errorAlerts.length}`);
  for (const el of errorAlerts) {
    const text = await el.innerText().catch(() => '');
    const visible = await el.isVisible().catch(() => false);
    if (visible && text.length > 5) {
      console.log(`  VISIBLE ERROR: "${text.slice(0, 200)}"`);
    }
  }

  // Check the specific node-offline / feed error message
  const bodyText = await page.locator('body').innerText();
  const feedErrorMatch = bodyText.match(/feed error[^\n]*/i);
  const nodeOfflineMatch = bodyText.match(/node.{0,10}offline[^\n]*/i);
  const notUpdatedMatch = bodyText.match(/not been updated[^\n]*/i);
  console.log(`  Feed error text: ${feedErrorMatch?.[0] ?? 'NOT FOUND'}`);
  console.log(`  Node offline text: ${nodeOfflineMatch?.[0] ?? 'NOT FOUND'}`);
  console.log(`  Not updated text: ${notUpdatedMatch?.[0] ?? 'NOT FOUND'}`);

  // Screenshot zoomed into the Holder Growth widget
  const holderGrowthEl = await page.locator('text=Holder Growth').first();
  if (await holderGrowthEl.isVisible().catch(() => false)) {
    const box = await holderGrowthEl.boundingBox();
    if (box) {
      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, 'deep-holder-growth.png'),
        clip: { x: 0, y: Math.max(0, box.y - 20), width: 1440, height: 500 },
      });
      console.log(`  Holder Growth screenshot saved`);
    }
  }

  // ── ISSUE 2: Holders sub-panels — check all chart counts per panel ───────────
  console.log('\n=== ISSUE 2: CHARTS PER HOLDER SUB-PANEL ===');
  const subPanelLabels = ['Trends', 'Balances', 'Staking', 'Momentum', 'Flows', 'Exchanges'];
  for (const label of subPanelLabels) {
    const btn = page.locator(`[role="tab"]`).filter({ hasText: label }).first();
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) {
      console.log(`  "${label}": NOT VISIBLE`);
      continue;
    }
    await btn.click();
    await sleep(2000);
    const charts = await page.locator('svg.recharts-surface').count();
    const contentLen = await page.locator('[data-state="active"][role="tabpanel"]').last().innerText().then(t => t.length).catch(() => 0);
    console.log(`  "${label}": ${charts} charts, content=${contentLen} chars`);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, `deep-holders-${label.toLowerCase()}.png`),
      fullPage: false,
    });
  }

  // ── ISSUE 3: Distribution tab — what's in it ──────────────────────────────
  console.log('\n=== ISSUE 3: DISTRIBUTION TAB DETAIL ===');
  await page.goto(`${BASE_URL}#distribution`, { waitUntil: 'domcontentloaded' });
  await waitForNetworkIdle(page);
  await sleep(4000);

  const distCharts = await page.locator('svg.recharts-surface').count();
  const distText = await page.locator('[data-state="active"].mt-0, main').first().innerText().catch(() => '');
  console.log(`  Charts found: ${distCharts}`);
  console.log(`  Panel text preview: "${distText.slice(0, 400)}"`);

  // Check for tier flow diagram (SVG canvas, not recharts)
  const svgTotal = await page.locator('svg').count();
  const canvases = await page.locator('canvas').count();
  console.log(`  Total SVGs: ${svgTotal}, canvases: ${canvases}`);

  // Sub-panels in distribution
  const distSubPanels = await page.locator('[role="tab"]').all();
  console.log(`  Distribution sub-panel tabs: ${distSubPanels.length}`);
  for (const tab of distSubPanels) {
    const text = await tab.innerText().catch(() => '');
    const state = await tab.getAttribute('data-state').catch(() => '');
    if (text.length > 0) console.log(`    "${text}" (${state})`);
  }

  await page.screenshot({
    path: path.join(SCREENSHOTS_DIR, 'deep-distribution.png'),
    fullPage: true,
  });
  console.log(`  Full distribution screenshot saved`);

  // ── ISSUE 4: Supply tab — detail ─────────────────────────────────────────
  console.log('\n=== ISSUE 4: SUPPLY TAB DETAIL ===');
  await page.goto(`${BASE_URL}#supply`, { waitUntil: 'domcontentloaded' });
  await waitForNetworkIdle(page);
  await sleep(3000);

  const supplyCharts = await page.locator('svg.recharts-surface').count();
  const supplyText = await page.locator('main').first().innerText().catch(() => '');
  console.log(`  Charts found: ${supplyCharts}`);
  console.log(`  Panel text preview: "${supplyText.slice(0, 400)}"`);

  const supplySubPanels = await page.locator('[role="tab"]').all();
  console.log(`  Supply sub-panel tabs: ${supplySubPanels.length}`);
  for (const tab of supplySubPanels) {
    const text = await tab.innerText().catch(() => '');
    const state = await tab.getAttribute('data-state').catch(() => '');
    if (text.length > 0) console.log(`    "${text}" (${state})`);
  }

  // Click each supply sub-panel
  const supplySubPanelLabels = ['Breakdown', 'Reconciliation', 'History'];
  for (const label of supplySubPanelLabels) {
    const btn = page.locator(`[role="tab"]`).filter({ hasText: label }).first();
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) { console.log(`  Supply sub-panel "${label}": NOT VISIBLE`); continue; }
    await btn.click();
    await sleep(2000);
    const charts = await page.locator('svg.recharts-surface').count();
    console.log(`  Supply "${label}": ${charts} charts`);
    await page.screenshot({
      path: path.join(SCREENSHOTS_DIR, `deep-supply-${label.toLowerCase()}.png`),
      fullPage: false,
    });
  }

  // ── ISSUE 5: Mobile drawer — empty body ──────────────────────────────────
  console.log('\n=== ISSUE 5: MOBILE DRAWER ===');
  const mobileContext = await browser.newContext({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15',
  });
  const mobilePage = await mobileContext.newPage();
  await mobilePage.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await waitForNetworkIdle(mobilePage);
  await sleep(2000);

  // Open hamburger
  const hamburger = mobilePage.locator('button').filter({ has: mobilePage.locator('svg') }).filter({ hasText: '' }).nth(0);
  // More reliable: find the button that opens the Sheet
  const menuButton = mobilePage.locator('[aria-label="Open menu"], button:has(.lucide-menu)').first();
  const menuBtnVisible = await menuButton.isVisible().catch(() => false);
  console.log(`  Menu button (aria-label): ${menuBtnVisible}`);

  // Try by the sr-only text
  const srButton = mobilePage.locator('button:has(span.sr-only)').first();
  const srVisible = await srButton.isVisible().catch(() => false);
  console.log(`  Menu button (sr-only): ${srVisible}`);
  if (srVisible) {
    await srButton.click();
    await sleep(800);
    const drawerContent = await mobilePage.locator('[data-state="open"]').first().innerText().catch(() => '');
    const sheetContent = await mobilePage.locator('[role="dialog"]').first().innerText().catch(() => '');
    console.log(`  Drawer open state content: "${drawerContent.slice(0, 200)}"`);
    console.log(`  Dialog content: "${sheetContent.slice(0, 200)}"`);
    await mobilePage.screenshot({ path: path.join(SCREENSHOTS_DIR, 'deep-mobile-drawer.png'), fullPage: false });
    console.log(`  Mobile drawer screenshot saved`);
  }

  // Mobile tab visibility check — look for the actual tab text
  console.log('\n-- Mobile tab pill visibility --');
  const tabList = mobilePage.locator('[role="tablist"]').first();
  const tabListVisible = await tabList.isVisible().catch(() => false);
  console.log(`  TabList visible: ${tabListVisible}`);
  if (tabListVisible) {
    const tabListBox = await tabList.boundingBox();
    console.log(`  TabList bounding box: ${JSON.stringify(tabListBox)}`);
    const tabs = await mobilePage.locator('[role="tab"]').all();
    for (const tab of tabs) {
      const text = await tab.innerText().catch(() => '');
      const visible = await tab.isVisible().catch(() => false);
      const box = await tab.boundingBox().catch(() => null);
      console.log(`  Tab "${text}": visible=${visible}, box=${JSON.stringify(box)}`);
    }
  }

  await mobileContext.close();

  // ── ISSUE 6: Check data staleness / dates in the feed error ───────────────
  console.log('\n=== ISSUE 6: DATA STALENESS ===');
  // Re-use the desktop page still open to check
  await page.goto(`${BASE_URL}#holders`, { waitUntil: 'domcontentloaded' });
  await waitForNetworkIdle(page);
  await sleep(4000);

  // Extract dates from the page
  const dateMatches = (await page.locator('body').innerText()).match(/\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{4}|last update[^\n]*/gi);
  if (dateMatches) {
    console.log(`  Date strings found:`);
    [...new Set(dateMatches)].slice(0, 10).forEach(d => console.log(`    ${d}`));
  }

  // Check snapshot generated-at metadata
  const snapshotText = (await page.locator('body').innerText()).match(/snapshot generated[^\n]*/i);
  console.log(`  Snapshot generated: ${snapshotText?.[0] ?? 'NOT FOUND'}`);

  // ── FINAL: All console errors across all page visits ──────────────────────
  console.log('\n=== ALL CONSOLE MESSAGES (errors only) ===');
  const errors = allConsole.filter(m => m.type === 'error');
  if (errors.length === 0) console.log('  None');
  else errors.forEach(e => console.log(`  ${e.text}`));

  // Summary of all response statuses for /data/ fetches
  console.log('\n=== ALL /data/ RESPONSES ===');
  allResponses.filter(r => r.url.includes('/data/')).forEach(r => {
    console.log(`  [${r.status}] ${r.url.split('/data/')[1]}`);
  });

  await context.close();
  await browser.close();
}

audit().catch(err => { console.error(err); process.exit(1); });
