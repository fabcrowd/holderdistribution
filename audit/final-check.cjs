/**
 * Final targeted checks.
 */
const { chromium } = require('playwright');
const path = require('path');

const BASE_URL = 'https://holderdistributioncom.netlify.app';
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function waitForIdle(page) {
  try { await page.waitForLoadState('networkidle', { timeout: 12000 }); } catch {}
}

async function run() {
  const browser = await chromium.launch({ headless: true });

  // ── 1. Distribution tab — what IS rendering (39 SVGs, 0 recharts) ──────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE_URL}#distribution`, { waitUntil: 'domcontentloaded' });
    await waitForIdle(page);
    await sleep(4000);

    console.log('=== DISTRIBUTION TAB CONTENT ===');
    // What SVGs exist — class names
    const svgClasses = await page.evaluate(() =>
      Array.from(document.querySelectorAll('svg')).map(s => ({
        class: s.className.baseVal || s.className || '',
        width: s.getAttribute('width') || s.getBoundingClientRect().width,
        height: s.getAttribute('height') || s.getBoundingClientRect().height,
        id: s.id,
      })).filter(s => s.width > 5 || s.height > 5).slice(0, 20)
    );
    console.log('SVG elements (non-icon):');
    svgClasses.forEach(s => console.log(`  class="${s.class}" id="${s.id}" ${s.width}x${s.height}`));

    // Visible text in the Distribution panel
    const distPanel = page.locator('[data-state="active"].mt-0, [role="tabpanel"][data-state="active"]').first();
    const panelText = await distPanel.innerText().catch(() => '');
    console.log(`\nDistribution panel text (first 600 chars):\n"${panelText.slice(0, 600)}"`);

    // Look for the sub-panels inside distribution
    const innerTabs = await page.locator('[role="tablist"]').all();
    console.log(`\nTabLists on page: ${innerTabs.length}`);
    for (const tl of innerTabs) {
      const tlText = await tl.innerText().catch(() => '');
      const tlVisible = await tl.isVisible().catch(() => false);
      if (tlVisible) console.log(`  Visible TabList: "${tlText.slice(0, 100)}"`);
    }

    // Screenshot crop at distribution panel
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'final-distribution-top.png'), clip: { x: 0, y: 80, width: 1440, height: 700 } });
    console.log('Distribution top screenshot saved');

    await ctx.close();
  }

  // ── 2. Mobile: the sub-panel row scrolls off-screen — is the tab bar clipped? ──
  {
    const ctx = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true });
    const page = await ctx.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await waitForIdle(page);
    await sleep(2000);

    console.log('\n=== MOBILE: SUB-PANEL TAB OVERFLOW ===');
    // The sub-panel tabs (Overview, Concentration, Balances, Staking, Momentum, Trends, Flows, Exchanges)
    // reported right edges beyond 375px — are they clipped by overflow-hidden?
    const overflowInfo = await page.evaluate(() => {
      const tabsWithOverflow = [];
      const tabs = document.querySelectorAll('[role="tab"]');
      tabs.forEach(tab => {
        const rect = tab.getBoundingClientRect();
        let el = tab.parentElement;
        let clipped = false;
        while (el && el !== document.body) {
          const style = window.getComputedStyle(el);
          if (style.overflow === 'hidden' || style.overflowX === 'hidden') {
            clipped = true;
            break;
          }
          el = el.parentElement;
        }
        tabsWithOverflow.push({
          text: tab.textContent.trim(),
          x: Math.round(rect.x),
          right: Math.round(rect.right),
          visible: rect.width > 0 && rect.height > 0,
          clipped,
        });
      });
      return tabsWithOverflow;
    });
    console.log('Tabs and clipping:');
    overflowInfo.forEach(t => console.log(`  "${t.text}" x=${t.x} right=${t.right} clipped=${t.clipped}`));

    // Check if the outer scroll container for the sub-panel tabs is there
    const scrollContainers = await page.evaluate(() => {
      const all = document.querySelectorAll('*');
      const scrollers = [];
      for (const el of all) {
        const style = window.getComputedStyle(el);
        if ((style.overflowX === 'auto' || style.overflowX === 'scroll') && el.scrollWidth > el.clientWidth) {
          scrollers.push({
            tag: el.tagName,
            class: el.className.toString().slice(0, 80),
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
          });
        }
      }
      return scrollers.slice(0, 5);
    });
    console.log('\nActual horizontal scroll containers:');
    scrollContainers.forEach(s => console.log(`  <${s.tag} class="${s.class}"> scrollWidth=${s.scrollWidth} clientWidth=${s.clientWidth}`));

    // Screenshot of the sub-panel area on mobile
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'final-mobile-subpanel.png'), clip: { x: 0, y: 460, width: 375, height: 300 } });
    console.log('\nMobile sub-panel screenshot saved');

    await ctx.close();
  }

  // ── 3. Check the sticky hero collapse behavior / KPI tiles ─────────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await waitForIdle(page);
    await sleep(3000);

    console.log('\n=== KPI HERO TILES ===');
    const kpiText = await page.locator('body').innerText();
    const kpiMatches = kpiText.match(/\d{2,3},\d{3}|\d+\.\d+B|\d+\.\d+M/g);
    console.log(`Numeric values on page: ${[...new Set(kpiMatches ?? [])].slice(0, 10).join(', ')}`);

    // Check the 4 KPI tiles are rendered
    const kpiTiles = await page.locator('.grid > div, [class*="tile"], [class*="kpi"]').count();
    console.log(`Grid/tile-like divs: ${kpiTiles}`);

    // Visible numbers
    const retailHolders = await page.locator('text=RETAIL HOLDERS').isVisible().catch(() => false);
    const retailHeld = await page.locator('text=RETAIL HELD').isVisible().catch(() => false);
    const staked = await page.locator('text=STAKED TEL').isVisible().catch(() => false);
    const cexBal = await page.locator('text=CEX BALANCE').isVisible().catch(() => false);
    console.log(`KPI tiles: RETAIL HOLDERS=${retailHolders}, RETAIL HELD=${retailHeld}, STAKED TEL=${staked}, CEX BALANCE=${cexBal}`);

    // Screenshot of hero area
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'final-desktop-hero.png'), clip: { x: 0, y: 110, width: 1440, height: 280 } });
    console.log('Hero tile screenshot saved');

    await ctx.close();
  }

  // ── 4. Check the font 404 — is it causing visible fallback text? ────────────
  {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    let fontFailed = false;
    page.on('requestfailed', r => { if (r.url().includes('gstatic')) fontFailed = true; });

    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await waitForIdle(page);
    await sleep(2000);

    // Check what font is actually applied to body text
    const fontInfo = await page.evaluate(() => {
      const body = document.body;
      const style = window.getComputedStyle(body);
      return {
        fontFamily: style.fontFamily,
        fontWeight: style.fontWeight,
      };
    });
    console.log('\n=== FONT ===');
    console.log(`Body font-family: ${fontInfo.fontFamily}`);
    console.log(`Font 404 occurred: ${fontFailed}`);

    // Check if Inter is loaded via FontFaceSet
    const fontsLoaded = await page.evaluate(async () => {
      await document.fonts.ready;
      const inter = [...document.fonts].filter(f => f.family.includes('Inter'));
      return {
        interFonts: inter.length,
        fontStatuses: inter.map(f => ({ family: f.family, weight: f.weight, status: f.status })),
      };
    });
    console.log(`Inter fonts in FontFaceSet: ${fontsLoaded.interFonts}`);
    fontsLoaded.fontStatuses.forEach(f => console.log(`  ${f.family} w${f.weight}: ${f.status}`));

    await ctx.close();
  }

  await browser.close();
  console.log('\nFinal checks done.');
}

run().catch(err => { console.error(err); process.exit(1); });
