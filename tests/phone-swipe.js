// Check of 21 November: on a phone, one swipe moves one video, however fast the finger is.
// The galleries that show one video at a time (the gallery on each professional's card, and the video viewer) scroll with
// the browser's own swipe and snap to a video. Without "scroll-snap-stop: always" a quick swipe carried on past the next
// video: on GitHub's page of 20 November a fast swipe landed on video 3 or 4 of 6, a flick on 5 or 6, so a client
// swiping through someone's work skipped videos without seeing them (the galleries check failed once on main for this
// reason, when a swipe of the test came out faster than usual). Each swipe below starts on a fresh page and is repeated,
// on two phones, slow, fast and as a flick; a second swipe must move one more video, and the arrows still move one.
// Check of 24 November: "scroll-snap-stop: always" alone is not enough. It asks the browser to stop a swipe at the next video,
// and the browser does not always: in Chrome 153 a flick on a phone about 390 pixels wide (an iPhone 13's) went on to the
// video after it in some runs and not in others, depending on how fast the touches came. So the page now holds a swipe to
// the next video itself, and the checks below no longer depend on the browser: with that rule switched off (as in a browser
// that ignores it), flicks on four phone sizes must still move one video, and so must a glide that runs on two videos while
// the finger is on the gallery (made by the check itself, so it happens every time), forwards and back, on a card and in the
// viewer, and a quick sideways swipe on a computer's trackpad (which went on two videos too). And what must not change:
// swiping back moves back one, two quick swipes move two, the page still scrolls up and down over a gallery.
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
// a finger on the gallery: from (fx, fy) of its box, moved by (dx, dy) pixels in `moves` steps, `wait` ms apart
async function drag(ctx, page, trackSel, { fx = 0.5, fy = 0.5, dx = 0, dy = 0, moves = 6, wait = 8, settle = 1300 }) {
  await page.locator(trackSel).scrollIntoViewIfNeeded(); await page.waitForTimeout(200);
  const bb = await page.locator(trackSel).boundingBox();
  const cdp = await ctx.newCDPSession(page);
  const x = bb.x + bb.width * fx, y = bb.y + bb.height * fy;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; i <= moves; i++) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + dx * i / moves, y: y + dy * i / moves }] }); await page.waitForTimeout(wait); }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(settle);
  await cdp.detach();
}
// the flick of 21 November, starting just left of the gallery's arrow (on a narrow phone 85% of the way across is the arrow)
async function flick(ctx, page, trackSel) {
  const at = await page.evaluate((s) => { const t = document.querySelector(s), a = t.parentElement.querySelector('.car-next').getBoundingClientRect(), r = t.getBoundingClientRect(); return (a.x - r.x) / r.width - 0.04; }, trackSel);
  await drag(ctx, page, trackSel, { fx: Math.min(0.85, at), dx: -300, moves: 5, wait: 4 });
}
// a glide that runs on two videos while the finger is on the gallery: what a browser that does not stop at the next video
// does after a quick flick. Made here with the gallery's own scroll, so it happens on every run, whatever the browser does.
async function runaway(ctx, page, trackSel, videos) {
  await page.locator(trackSel).scrollIntoViewIfNeeded(); await page.waitForTimeout(200);
  const bb = await page.locator(trackSel).boundingBox(); const cdp = await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 }] });
  await page.evaluate(async ([s, v]) => { const t = document.querySelector(s), w = t.clientWidth, to = t.scrollLeft + v * w;
    for (let i = 1; i <= 12; i++) { t.scrollLeft = t.scrollLeft + (to - t.scrollLeft) / (13 - i); await new Promise(r => requestAnimationFrame(r)); } }, [trackSel, videos]);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(1300); await cdp.detach();
}
// a browser that does not stop at the next video by itself: the page's own "scroll-snap-stop: always" switched off
const NO_STOP = '.car-one .car-item{scroll-snap-stop:normal !important}';
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
  // check of 24 November: one swipe, one video, also where the browser itself would not stop at the next video
  for (const phone of ['iPhone 13', 'Pixel 7', 'iPhone SE', 'Galaxy S24']) {
    const open = async () => {
      const ctx = await b.newContext({ ...devices[phone] }); const page = await ctx.newPage();
      page.on('pageerror', e => errs.push(phone + ': ' + e.message));
      await page.goto(url); await page.addStyleTag({ content: NO_STOP }); await page.waitForTimeout(500);
      return { ctx, page };
    };
    const seen = [];
    for (let r = 0; r < 2; r++) {
      const { ctx, page } = await open();
      await flick(ctx, page, CARD + ' .car-track'); const first = await cardAt(page);
      await flick(ctx, page, CARD + ' .car-track'); const second = await cardAt(page);
      seen.push(`${first} then ${second}`); await ctx.close();
    }
    ok(seen.every(s => s.split(' then ').map(nth).join() === '2,3'), `${phone}, card gallery, flick swipe, the browser not stopping by itself: each swipe moves one video (${seen.join('; ')}; must be: 2 then 3)`);
    {
      const { ctx, page } = await open();
      await runaway(ctx, page, CARD + ' .car-track', 2.4); const a1 = await cardAt(page);
      await runaway(ctx, page, CARD + ' .car-track', 2.4); const a2 = await cardAt(page);
      await runaway(ctx, page, CARD + ' .car-track', -2.4); const a3 = await cardAt(page);
      ok([a1, a2, a3].map(nth).join() === '2,3,2', `${phone}, card gallery, a glide that runs on two videos, forwards twice and back once: one video each time (${a1}, ${a2}, ${a3}; must be: 2, 3, 2)`);
      await ctx.close();
    }
    {
      const { ctx, page } = await open();
      await page.locator(CARD + ' .car-track').scrollIntoViewIfNeeded();
      await page.tap(CARD + ' .car-item[data-i="0"]'); await page.waitForTimeout(600);
      await runaway(ctx, page, '#viewerCar .car-track', 2.4); const v1 = await viewerAt(page);
      await flick(ctx, page, '#viewerCar .car-track'); const v2 = await viewerAt(page);
      ok(nth(v1) === 2 && nth(v2) === 3, `${phone}, video viewer, the browser not stopping by itself: a glide that runs on two videos, then a flick, one video each (${v1}, ${v2}; must be: 2, 3)`);
      await ctx.close();
    }
  }
  // what must not change, on a phone (iPhone 13)
  {
    const phone = 'iPhone 13';
    const open = async () => {
      const ctx = await b.newContext({ ...devices[phone] }); const page = await ctx.newPage();
      page.on('pageerror', e => errs.push(phone + ': ' + e.message));
      await page.goto(url); await page.waitForTimeout(500);
      return { ctx, page };
    };
    let { ctx, page } = await open();
    const sx = [];
    await drag(ctx, page, CARD + ' .car-track', { fx: 0.8, dx: -240 }); sx.push(await cardAt(page));
    await drag(ctx, page, CARD + ' .car-track', { fx: 0.8, dx: -240 }); sx.push(await cardAt(page));
    await drag(ctx, page, CARD + ' .car-track', { fx: 0.2, dx: 240 }); sx.push(await cardAt(page));
    ok(sx.map(nth).join() === '2,3,2', `${phone}: two swipes forward, one back (${sx.join(', ')}; must be: 2, 3, 2)`);
    await ctx.close();
    ({ ctx, page } = await open());
    await drag(ctx, page, CARD + ' .car-track', { fx: 0.8, dx: -240, settle: 350 });
    await drag(ctx, page, CARD + ' .car-track', { fx: 0.8, dx: -240 }); const quick = await cardAt(page);
    ok(nth(quick) === 3, `${phone}: two quick swipes, a third of a second apart, move two videos (${quick}; must be: 3 / 6)`);
    await ctx.close();
    ({ ctx, page } = await open());
    await page.locator(CARD + ' .car-track').scrollIntoViewIfNeeded(); await page.waitForTimeout(300);
    const y0 = await page.evaluate(() => scrollY);
    await drag(ctx, page, CARD + ' .car-track', { fy: 0.6, dy: -220, moves: 8, wait: 16 });
    const y1 = await page.evaluate(() => scrollY), still = await cardAt(page);
    ok(y1 - y0 > 100 && nth(still) === 1, `${phone}: a finger moving up over a gallery scrolls the page (${Math.round(y1 - y0)} pixels) and leaves the gallery (${still}; must be: more than 100, 1 / 6)`);
    await ctx.close();
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
  // on a computer, a quick sideways swipe on a trackpad (one big sideways scroll) over a card's gallery: one video, also back
  {
    const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } }); const page = await ctx.newPage();
    page.on('pageerror', e => errs.push('desktop trackpad: ' + e.message));
    await page.goto(url); await page.waitForTimeout(500);
    const bb = await page.locator(CARD + ' .car-track').boundingBox(); await page.mouse.move(bb.x + bb.width * 0.3, bb.y + bb.height * 0.3);
    const seen = [];
    for (const d of [2.4, 2.4, -2.4]) { await page.mouse.wheel(bb.width * d, 0); await page.waitForTimeout(1200); seen.push(await cardAt(page)); }
    ok(seen.map(nth).join() === '2,3,2', `computer: a quick trackpad swipe over a card's gallery, forwards twice and back once: one video each time (${seen.join(', ')}; must be: 2, 3, 2)`);
    await ctx.close();
  }
  ok(errs.length === 0, `no page errors${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);
  await b.close();
  console.log(log.join('\n'));
  const bad = log.filter(l => l.startsWith('FAIL')).length;
  console.log(`\n${log.length - bad} passed, ${bad} failed`);
  process.exit(bad ? 1 : 0);
})().catch(e => { console.log('CRASH ' + (e && e.stack || e)); process.exit(1); });
