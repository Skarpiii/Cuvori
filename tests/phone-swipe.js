// Check of 21 November: on a phone, one swipe moves one video, however fast the finger is.
// The galleries that show one video at a time (the gallery on each professional's card, and the video viewer) scroll with
// the browser's own swipe and snap to a video. Without "scroll-snap-stop: always" a quick swipe carried on past the next
// video: on GitHub's page of 20 November a fast swipe landed on video 3 or 4 of 6, a flick on 5 or 6, so a client
// swiping through someone's work skipped videos without seeing them (the galleries check failed once on main for this
// reason, when a swipe of the test came out faster than usual). Each swipe below starts on a fresh page and is repeated,
// on two phones, slow, fast and as a flick; a second swipe must move one more video, and the arrows still move one.
// Run: node tests/phone-swipe.js   (TARGET=<folder> checks another copy of Cuvori)
const { chromium, devices } = require('playwright');
const path = require('path');
const root = process.env.TARGET ? path.resolve(process.env.TARGET) : path.resolve(__dirname, '..');   // the copy under test (TARGET), else this one
const url = 'file://' + path.join(root, 'index.html');
const log = []; const ok = (c, m) => log.push((c ? 'PASS ' : 'FAIL ') + m);
const SPEEDS = { slow: { step: 22, wait: 16, moves: 12 }, fast: { step: 44, wait: 8, moves: 6 }, flick: { step: 60, wait: 4, moves: 5 } };
const REPS = 3;
const CARD = '.profile-card:nth-child(1) .card-gallery';

async function swipe(ctx, page, trackSel, speed) {
  const s = SPEEDS[speed];
  await page.locator(trackSel).scrollIntoViewIfNeeded(); await page.waitForTimeout(200);
  const bb = await page.locator(trackSel).boundingBox();
  const cdp = await ctx.newCDPSession(page);
  const x = bb.x + bb.width * 0.85, y = bb.y + bb.height / 2;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= s.moves; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x - i * s.step, y }] }); await page.waitForTimeout(s.wait); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(1300);   // the browser's own glide and snap have ended
  await cdp.detach();
}
const cardAt = async (page) => (await page.textContent(CARD + ' .media-counter')).trim();          // "2 / 6"
const viewerAt = async (page) => (await page.textContent('#viewerCount')).trim();                   // "Video 2 of 6"
const nth = (s) => +((/(\d+) (?:\/|of) \d+/.exec(s) || [])[1] || 0);                                  // which video: 2

(async () => {
  const b = await chromium.launch({ args: ['--touch-events=enabled'] }); const errs = [];
  for (const phone of ['iPhone 13', 'Pixel 7']) {
    const open = async () => {
      const ctx = await b.newContext({ ...devices[phone] }); const page = await ctx.newPage();
      page.on('pageerror', e => errs.push(phone + ': ' + e.message));
      await page.goto(url); await page.waitForTimeout(500);
      return { ctx, page };
    };
    // the gallery on a professional's card
    for (const speed of Object.keys(SPEEDS)) {
      const seen = [];
      for (let r = 0; r < REPS; r++) {
        const { ctx, page } = await open();
        await swipe(ctx, page, CARD + ' .car-track', speed); const first = await cardAt(page);
        await swipe(ctx, page, CARD + ' .car-track', speed); const second = await cardAt(page);
        seen.push(`${first} then ${second}`);
        await ctx.close();
      }
      ok(seen.every(s => s.split(' then ').map(nth).join() === '2,3'), `${phone}, card gallery, ${speed} swipe: each swipe moves one video (${seen.join('; ')}; must be: 2 then 3)`);
    }
    // the video viewer (opened by tapping the first video of a card)
    for (const speed of ['fast', 'flick']) {
      const seen = [];
      for (let r = 0; r < REPS; r++) {
        const { ctx, page } = await open();
        await page.locator(CARD + ' .car-track').scrollIntoViewIfNeeded();
        await page.tap(CARD + ' .car-item[data-i="0"]'); await page.waitForTimeout(600);
        const start = await viewerAt(page);
        await swipe(ctx, page, '#viewerCar .car-track', speed); const first = await viewerAt(page);
        await swipe(ctx, page, '#viewerCar .car-track', speed); const second = await viewerAt(page);
        seen.push(`${start}, ${first}, ${second}`);
        await ctx.close();
      }
      ok(seen.every(s => s.split(', ').map(nth).join() === '1,2,3'), `${phone}, video viewer, ${speed} swipe: each swipe moves one video (${seen.join('; ')}; must be: 1, 2, 3)`);
    }
    // the arrows are not slowed or blocked by it: one tap, one video, also twice in a row
    {
      const { ctx, page } = await open();
      await page.locator(CARD + ' .car-track').scrollIntoViewIfNeeded();
      await page.tap(CARD + ' .car-next'); await page.waitForTimeout(900); const a1 = await cardAt(page);
      await page.tap(CARD + ' .car-next'); await page.waitForTimeout(900); const a2 = await cardAt(page);
      ok(nth(a1) === 2 && nth(a2) === 3, `${phone}, card gallery arrows: one tap, one video (${a1} then ${a2})`);
      await ctx.close();
    }
  }
  // on a computer (wide screen) the arrows, the viewer opened at a later video and the keyboard work as before
  {
    const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } }); const page = await ctx.newPage();
    page.on('pageerror', e => errs.push('desktop: ' + e.message));
    await page.goto(url); await page.waitForTimeout(500);
    await page.click(CARD + ' .car-next'); await page.waitForTimeout(900);
    await page.click(CARD + ' .car-next'); await page.waitForTimeout(900);
    const c = await cardAt(page);
    await page.click(CARD + ' .car-item[data-i="2"]'); await page.waitForTimeout(700);
    const v0 = await viewerAt(page);
    await page.keyboard.press('ArrowRight'); await page.waitForTimeout(900); const v1 = await viewerAt(page);
    await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(900); const v2 = await viewerAt(page);
    ok([c, v0, v1, v2].map(nth).join() === '3,3,4,3', `computer: arrows to video 3 (${c}), the viewer opens at it (${v0}), keyboard right and left (${v1}, ${v2})`);
    await ctx.close();
  }
  ok(errs.length === 0, `no page errors${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);
  await b.close();
  console.log(log.join('\n'));
  const bad = log.filter(l => l.startsWith('FAIL')).length;
  console.log(`\n${log.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('CRASH ' + (e && e.stack || e)); process.exit(1); });
