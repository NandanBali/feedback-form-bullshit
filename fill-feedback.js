const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { phrases } = require('./phrases');

const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const TIMEOUT = 60_000;
const NAV_SELECT_SEL = '#\\$ICField100\\$hpage\\$0';

function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function randomIndex(n) { return Math.floor(Math.random() * n); }
function escId(id) { return '#' + id.replace(/\$/g, '\\$'); }

// Find the PeopleSoft content frame — works for classic (TargetContent), Fluid wrappers, and
// during /psp -> /psc redirect chains. Prefer frames hosting actual form/search content.
async function findPSFrameAsync(page) {
  const candidates = page.frames().filter(f => !f.isDetached() && !/^about:/.test(f.url()));
  // First pick: any frame that already has form/search content rendered.
  for (const f of candidates) {
    const has = await f.evaluate(() => {
      return !!document.querySelector('input[id^="Z_STDFED_L3_WRK_CHECKBOX1$"]')
        || !!document.querySelector('textarea[id^="Z_STDFB_O_REPLY_DESCRLONG$"]')
        || !!document.querySelector('input[id^="Z_STDFEED_WRK_ADD_BTN$"]');
    }).catch(() => false);
    if (has) return f;
  }
  // Fallback: frame whose URL points at the feedback components.
  return candidates.find(f => /Z_STDFB|Z_STDFEED/i.test(f.url()))
    || candidates.find(f => f.name() === 'TargetContent' || f.name() === 'main_target_win0')
    || null;
}

// Synchronous-ish version (URL-based only). Kept for backwards compat but prefer findPSFrameAsync.
function findPSFrame(page) {
  return page.frames().find(f => /Z_STDFB|Z_STDFEED/i.test(f.url()) && !f.isDetached())
    || page.frames().find(f => (f.name() === 'TargetContent' || f.name() === 'main_target_win0') && !/^about:/.test(f.url()))
    || null;
}

// Wait until PeopleSoft's loading indicators are hidden.
async function waitForPSReady(frame) {
  await frame.waitForFunction(() => {
    const wait = document.getElementById('WAIT_win0');
    const proc = document.getElementById('processing');
    const visible = el => el && el.offsetParent !== null && getComputedStyle(el).display !== 'none';
    return !visible(wait) && !visible(proc);
  }, null, { timeout: TIMEOUT, polling: 200 });
  // Brief settle — PeopleSoft sometimes paints the new DOM a tick after hiding the spinner.
  await frame.page().waitForTimeout(250);
}

async function getCheckboxGroups(frame) {
  return await frame.evaluate(() => {
    const groups = new Map();
    for (const cb of document.querySelectorAll('input[type=checkbox]')) {
      const tbl = cb.closest('table');
      if (!tbl) continue;
      if (!groups.has(tbl)) groups.set(tbl, []);
      groups.get(tbl).push(cb.id);
    }
    return Array.from(groups.values());
  });
}

async function getTextareaIds(frame) {
  return await frame.evaluate(() =>
    Array.from(document.querySelectorAll('textarea')).map(t => t.id).filter(Boolean)
  );
}

async function fillCurrentPage(frame) {
  await frame.evaluate(() => window.scrollTo(0, 0));

  // --- Checkboxes: one random pick per question group ---
  const groups = await getCheckboxGroups(frame);
  console.log(`  ${groups.length} checkbox group(s) — sizes [${groups.map(g => g.length).join(',')}]`);
  for (let i = 0; i < groups.length; i++) {
    const ids = groups[i];
    const pickId = ids[randomIndex(ids.length)];
    const cb = frame.locator(escId(pickId));
    await cb.scrollIntoViewIfNeeded();
    await cb.waitFor({ state: 'visible', timeout: TIMEOUT });
    await cb.check({ timeout: TIMEOUT });
    await waitForPSReady(frame);
  }

  // --- Textareas ---
  const taIds = await getTextareaIds(frame);
  console.log(`  ${taIds.length} textarea(s)`);
  for (const id of taIds) {
    const ta = frame.locator(escId(id));
    await ta.scrollIntoViewIfNeeded();
    await ta.waitFor({ state: 'visible', timeout: TIMEOUT });
    await ta.fill(pickRandom(phrases), { timeout: TIMEOUT });
    await waitForPSReady(frame);
  }
}

async function getTotalPages(frame) {
  const navCount = await frame.locator(NAV_SELECT_SEL).count();
  if (navCount === 0) return 1; // single-instructor form (no page-nav select)
  return await frame.locator(NAV_SELECT_SEL).locator('option').count();
}

async function clickSaveAndReturn(page) {
  let frame = await findPSFrameAsync(page);
  if (!frame) throw new Error('TargetContent frame missing before Save.');

  console.log('\n--- Saving form ---');
  const saveBtn = frame.locator('[id="#ICSave"]');
  await saveBtn.scrollIntoViewIfNeeded();
  await saveBtn.waitFor({ state: 'visible', timeout: TIMEOUT });
  await saveBtn.click({ timeout: TIMEOUT });
  await waitForPSReady(frame);

  // The post-save confirmation dialog lives in the TOP-LEVEL page, not the iframe.
  // <input id="#ICOK" value="OK" onclick="closeMsg(this);"> appears after a successful save.
  try {
    const ok = page.locator('[id="#ICOK"]');
    await ok.waitFor({ state: 'visible', timeout: 10_000 });
    console.log('  Post-save dialog detected — clicking OK.');
    await ok.click({ timeout: TIMEOUT });
    // Wait until the dialog is gone before continuing.
    await ok.waitFor({ state: 'hidden', timeout: TIMEOUT }).catch(() => { });
    const f2 = findPSFrame(page);
    if (f2) await waitForPSReady(f2);
  } catch {
    // No dialog — save may have completed silently.
  }

  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'saved.png'), fullPage: true });
  console.log(`  Screenshot: ${path.join(SCREENSHOTS_DIR, 'saved.png')}`);

  console.log('\n--- Navigating back to Student Feedback search ---');
  // The "Student Feedback Search" button at the top of the main page.
  // <a id="PT_WORK_PT_BUTTON_BACK" onclick="DoBackClassic();">Student Feedback Search</a>
  const backBtn = page.locator('#PT_WORK_PT_BUTTON_BACK');
  await backBtn.waitFor({ state: 'visible', timeout: TIMEOUT });
  await Promise.all([
    page.waitForLoadState('domcontentloaded', { timeout: TIMEOUT }),
    backBtn.click({ timeout: TIMEOUT }),
  ]);

  await waitForSearchFrame(page);

  await page.screenshot({ path: path.join(SCREENSHOTS_DIR, 'back-to-search.png'), fullPage: true });
  console.log(`  Screenshot: ${path.join(SCREENSHOTS_DIR, 'back-to-search.png')}`);
}

// Wait until the TargetContent iframe is reattached AND showing the search page
// (i.e. it has the "Overall Sem Feedback" Add buttons), then wait for PS to settle.
async function waitForSearchFrame(page, timeout = TIMEOUT) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    // Check all non-detached, non-about: frames including the main frame
    const candidates = page.frames().filter(f => !f.isDetached() && !/^about:/.test(f.url()));
    for (const f of candidates) {
      try {
        const ready = await f.evaluate(() => {
          return !!document.querySelector('input[id^="Z_STDFEED_WRK_ADD_BTN$"]')
            || !!document.querySelector('select[id="$ICField100$hpage$0"]');
        });
        if (ready) {
          await waitForPSReady(f);
          return f;
        }
      } catch {
        // Frame was replaced mid-evaluate — retry.
      }
    }
    await page.waitForTimeout(300);
  }
  throw new Error('Timed out waiting for search-page TargetContent frame.');
}

async function navigateToPage(frame, targetIndex) {
  const nav = frame.locator(NAV_SELECT_SEL);
  await nav.scrollIntoViewIfNeeded();
  await nav.selectOption({ index: targetIndex }, { timeout: TIMEOUT });
  await waitForPSReady(frame);
  const current = await nav.inputValue().catch(() => null);
  console.log(`  Nav now at index: ${current}`);
}

// Fill the currently-open feedback form (all instructor pages), then save and go back.
async function fillOneSubject(page, subjectLabel) {
  let frame = await findPSFrameAsync(page);
  if (!frame) throw new Error('TargetContent frame missing on form page.');
  await waitForPSReady(frame);

  const totalPages = await getTotalPages(frame);
  console.log(`  Found ${totalPages} instructor page(s) for ${subjectLabel}.`);

  for (let i = 0; i < totalPages; i++) {
    console.log(`  --- Instructor page ${i + 1} of ${totalPages} ---`);
    frame = await findPSFrameAsync(page);
    if (!frame) throw new Error(`TargetContent frame missing on page ${i + 1}`);

    if (i > 0) {
      await navigateToPage(frame, i);
      frame = (await findPSFrameAsync(page)) || frame;
    }

    const tag = `${subjectLabel}-instructor-${i + 1}`;
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${tag}-before.png`), fullPage: true });
    await fillCurrentPage(frame);
    await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `${tag}-after.png`), fullPage: true });
    console.log(`  Page ${i + 1} filled.`);
  }

  await clickSaveAndReturn(page);
}

// Find all enabled "Overall Sem Feedback" buttons that haven't been filled yet.
async function getOverallFeedbackButtonIds(frame) {
  return await frame.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('input[id^="Z_STDFEED_WRK_ADD_BTN$"]'));
    return btns
      .filter(b => !b.disabled && !/PSPUSHBUTTONDISABLED/.test(b.className))
      .map(b => b.id);
  });
}

function parseFlags() {
  const flags = { start: 1, count: Infinity };
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--(start|count)=(\d+)$/);
    if (m) flags[m[1]] = parseInt(m[2], 10);
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: node fill-feedback.js [--start=N] [--count=N]');
      console.log('  --start=N  1-based subject index to start from (default 1)');
      console.log('  --count=N  max number of subjects to fill in this run (default: all)');
      process.exit(0);
    }
  }
  return flags;
}

async function main() {
  const { start, count } = parseFlags();
  console.log(`Flags: start=${start} count=${count === Infinity ? 'all' : count}`);
  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const CDP_URL = 'http://127.0.0.1:9222';
  console.log(`Connecting to Chrome on ${CDP_URL} ...`);
  const browser = await chromium.connectOverCDP(CDP_URL);

  // Walk every context + page to find the one hosting the feedback portal.
  // (Windows Chrome sometimes opens a "new tab" page that ends up in contexts[0].)
  const allPages = browser.contexts().flatMap(c => c.pages());
  console.log(`Discovered ${allPages.length} open tab(s):`);
  allPages.forEach((p, i) => console.log(`  [${i}] ${p.url().slice(0, 120)}`));

  // Find the page hosting a frame whose URL points at the feedback component.
  // Fluid UI wraps classic PeopleSoft pages — the outer tab URL stays on the dashboard,
  // and the actual feedback content lives in a nested iframe.
  const isFeedbackUrl = url => /Z_STDFB|Z_STDFEED/i.test(url);
  let page = allPages.find(p => p.frames().some(f => isFeedbackUrl(f.url())))
    || allPages.find(p => isFeedbackUrl(p.url()))
    || allPages.find(p => p.frames().some(f => f.name() === 'TargetContent'));

  if (!page) {
    console.error('\nNo Student Feedback tab found in any open Chrome tab or iframe.');
    console.error('In the debug Chrome window, navigate to: Self Service → Academic Records → Student Feedback');
    console.error('so a tab or iframe URL contains "Z_STDFEED" or "Z_STDFB", then re-run.');
    await browser.close();
    process.exit(1);
  }
  console.log(`\nAttached to page: ${page.url()}`);
  page.setDefaultTimeout(TIMEOUT);
  await page.bringToFront();

  // Wait for a frame whose URL contains the feedback component to appear.
  console.log('Searching for feedback iframe...');
  let frame = null;
  const frameDeadline = Date.now() + TIMEOUT;
  while (Date.now() < frameDeadline) {
    frame = page.frames().find(f => isFeedbackUrl(f.url()))
      || page.frames().find(f => f.name() === 'TargetContent' && !/^about:/.test(f.url()));
    if (frame) break;
    await page.waitForTimeout(500);
  }
  if (!frame) {
    console.error('\nNo feedback iframe found. All frames on this page:');
    page.frames().forEach(f => console.error(`  name="${f.name()}" url=${f.url().slice(0, 140)}`));
    console.error('\nClick into "Student Feedback" inside the SIS dashboard, then re-run.');
    await browser.close();
    process.exit(1);
  }
  console.log(`Using frame: name="${frame.name()}" url=${frame.url().slice(0, 120)}`);
  await waitForPSReady(frame);

  // If we landed directly on a form (page-nav select present), fill just that one and exit.
  const onFormPage = await frame.locator(NAV_SELECT_SEL).count() > 0;
  if (onFormPage) {
    console.log('Detected an open feedback form — filling it, then returning to search.');
    await fillOneSubject(page, 'subject-1');
    console.log('\nDone.');
    await browser.close();
    return;
  }

  // We're on the search page. Iterate by positional index — index always advances,
  // so a stuck/already-filled subject can't loop forever.
  let currentIndex = start - 1;
  let processed = 0;
  let skippedCount = 0;
  while (processed < count) {
    frame = await waitForSearchFrame(page).catch(() => null);
    if (!frame) throw new Error('TargetContent frame missing on search page.');

    const btnIds = await getOverallFeedbackButtonIds(frame);
    console.log(`\nSearch page: ${btnIds.length} enabled button(s); position ${currentIndex + 1}.`);
    if (currentIndex >= btnIds.length) {
      console.log('No more subjects at this position — stopping.');
      break;
    }

    const targetId = btnIds[currentIndex];
    const subjectLabel = `subject-${currentIndex + 1}`;
    console.log(`\n=== ${subjectLabel}: clicking ${targetId} (index ${currentIndex}) ===`);

    try {
      const btn = frame.locator(escId(targetId));
      await btn.scrollIntoViewIfNeeded();
      await btn.waitFor({ state: 'visible', timeout: TIMEOUT });
      await btn.click({ timeout: TIMEOUT });

      // Wait until form fields, OK dialog, or the search page reappears.
      // Fluid clicks redirect through /psp -> /psc, so check ALL frames each iteration.
      console.log('  Waiting for form/dialog after click...');
      const waitDeadline = Date.now() + 90_000;
      let resolution = null;
      let lastState = '';
      while (Date.now() < waitDeadline) {
        // Aggregate state across every frame on the page.
        const summary = { form: false, dialog: false, addBtns: false, frames: [] };
        for (const f of page.frames()) {
          if (f.isDetached()) continue;
          const url = f.url();
          if (/^about:/.test(url)) continue;
          const s = await f.evaluate(() => {
            const has = sel => !!document.querySelector(sel);
            return {
              cb: has('input[id^="Z_STDFED_L3_WRK_CHECKBOX1$"]'),
              ta: has('textarea[id^="Z_STDFB_O_REPLY_DESCRLONG$"]'),
              ok: has('[id="#ICOK"], [id="#ICCancel"]'),
              add: has('input[id^="Z_STDFEED_WRK_ADD_BTN$"]'),
              ready: document.readyState,
            };
          }).catch(err => ({ error: err.message.split('\n')[0] }));
          summary.frames.push({ name: f.name(), url: url.slice(0, 90), ...s });
          if (s && (s.cb || s.ta)) summary.form = true;
          if (s && s.ok) summary.dialog = true;
          if (s && s.add) summary.addBtns = true;
        }

        const stateStr = JSON.stringify(summary);
        if (stateStr !== lastState) {
          console.log(`    ${stateStr}`);
          lastState = stateStr;
        }

        if (summary.form) { resolution = 'form'; break; }
        if (summary.dialog) { resolution = 'dialog'; break; }
        await page.waitForTimeout(700);
      }
      console.log(`  Resolution: ${resolution || '(timeout)'}`);

      frame = await findPSFrameAsync(page);
      const hasForm = !!frame
        && ((await frame.locator('input[id^="Z_STDFED_L3_WRK_CHECKBOX1$"]').count()) > 0
          || (await frame.locator('textarea[id^="Z_STDFB_O_REPLY_DESCRLONG$"]').count()) > 0);
      const hasDialog = !!frame && (await frame.locator('[id="#ICOK"], [id="#ICCancel"]').count()) > 0;

      if (!hasForm && hasDialog) {
        console.log(`  ${subjectLabel}: dialog only (likely already filled). Dismissing.`);
        await frame.locator('[id="#ICOK"], [id="#ICCancel"]').first()
          .click({ timeout: TIMEOUT }).catch(() => { });
        await waitForPSReady(frame);
        skippedCount += 1;
      } else if (!hasForm) {
        console.log(`  ${subjectLabel}: form did not open — skipping.`);
        skippedCount += 1;
      } else {
        await fillOneSubject(page, subjectLabel);
        processed += 1;
      }
    } catch (err) {
      console.error(`  ${subjectLabel} (${targetId}) failed: ${err.message.split('\n')[0]}`);
      skippedCount += 1;
      // Best-effort recovery: navigate back to search if we're stuck on a form.
      const breadcrumb = page.locator('#pthnavbccrefanc_Z_STDFEED_SRCH_CM_GBL').first();
      try {
        if (await breadcrumb.isVisible({ timeout: 2_000 })) {
          await breadcrumb.click({ timeout: TIMEOUT });
          await page.waitForLoadState('domcontentloaded', { timeout: TIMEOUT }).catch(() => { });
          const f2 = findPSFrame(page);
          if (f2) await waitForPSReady(f2);
        }
      } catch {
        console.error('  Recovery navigation failed — aborting loop.');
        break;
      }
    }

    currentIndex += 1; // ALWAYS advance — guarantees forward progress
  }

  console.log(`\nAll done. Filled ${processed} subject(s); skipped ${skippedCount}. Screenshots in ./screenshots/`);
  await browser.close();
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
