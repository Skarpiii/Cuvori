// Post a job: the profession picker you type into, and the options that follow the profession.
// The live database hands groups back as a list ([{slug,labels}]) while the built-in copy in the page
// is a map ({slug: labels}); the picker has to read both, so every check runs twice.
const { chromium } = require('playwright');
const path = require('path');
const log = []; const ok = (c, m) => log.push((c ? 'PASS ' : 'FAIL ') + m);
const url = 'file://' + path.resolve(__dirname, '..') + '/index.html';

(async () => {
  const b = await chromium.launch();
  for (const shape of ['built-in map', 'database list']) {
    const p = await (await b.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
    const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.addInitScript(require('fs').readFileSync(__dirname + '/../mock-supabase.js', 'utf8'));
    if (shape === 'database list') await p.addInitScript(() => {          // reshape the config the way the server sends it
      const iv = setInterval(() => { const c = window.CUVORI_PROFESSIONS;
        if (c && c.groups && !Array.isArray(c.groups)) { c.groups = Object.entries(c.groups).map(([slug, labels]) => ({ slug, labels })); clearInterval(iv); } }, 5);
    });
    await p.route('**/supabase.min.js', r => r.fulfill({ status: 200, body: '/* mocked */', contentType: 'application/javascript' }));
    const S = ' (' + shape + ')';
    try {
      await p.goto(url + '#post-job'); await p.waitForTimeout(1000);
      const opts = () => p.locator('#jobRoleList .pp-opt').allTextContents();
      const type = async q => { await p.fill('#jobRoleSearch', q); await p.waitForTimeout(200); return opts(); };

      ok(errs.length === 0, 'the page starts without an error' + S);
      ok((await p.textContent('#jobSpecs')).includes('Choose who you need') && await p.locator('#jobSpecs .job-opt').count() === 0,
        'no profession chosen: no skills and no software, only a line saying why' + S);

      await p.click('#jobRoleSearch'); await p.waitForTimeout(300);
      ok((await opts()).length >= 25, 'the picker offers every open profession' + S);
      ok((await p.textContent('#jobRoleList .pp-count')).includes('30'), 'the top of the list says how many there are' + S);
      ok(await p.locator('#jobRoleCaret').isVisible(), 'the field carries a chevron, so it reads as a drop-down too' + S);
      ok(await p.locator('#jobRoleList .pp-group').count() >= 5, 'they are grouped by trade, with a heading for each' + S);
      ok(await p.locator('#jobRoleList .pp-opt[data-slug="game-developer"]').count() === 0, 'a profession that is not open yet is not offered' + S);

      const box = await p.locator('#jobRoleList').evaluate(e => ({ client: e.clientHeight, scroll: e.scrollHeight }));
      ok(box.scroll > box.client + 20, 'the list is longer than the box, so it scrolls' + S);
      await p.locator('#jobRoleList').hover();
      const pageBefore = await p.evaluate(() => document.scrollingElement.scrollTop);
      await p.mouse.wheel(0, 500); await p.waitForTimeout(250);
      const inside = await p.locator('#jobRoleList').evaluate(e => e.scrollTop);
      ok(inside > 200, 'the wheel scrolls the list' + S);
      ok(await p.evaluate(() => document.scrollingElement.scrollTop) === pageBefore, '…and the page behind it stays where it was' + S);
      ok((await p.locator('#jobRoleList .pp-opt').last().textContent()) === 'No-code website builder', 'scrolling reaches the last profession' + S);
      await p.locator('#jobRoleList').evaluate(e => e.scrollTop = 0); await p.waitForTimeout(150);

      ok((await type('logo')).join() === 'Brand & logo designer', 'typing "logo" finds the brand designer' + S);
      ok((await type('tłumacz')).join() === 'Translator', 'a Polish word finds the translator' + S);
      ok((await type('монтаж')).includes('Video editor'), 'a Russian word finds the video editor' + S);
      ok((await type('vestuv')).includes('Photographer'), 'the Lithuanian word for weddings finds the photographer, though nobody is called that' + S);
      ok((await type('hochzeit')).includes('Videographer'), '…and so does the German one' + S);
      ok((await type('vaizdas')).length >= 5, 'typing the name of a whole group offers everyone in it' + S);
      ok((await type('zzqqx')).length === 0 && await p.locator('#jobRoleList .pp-none').count() === 1,
        'a word nobody matches says so plainly instead of guessing' + S);

      // keyboard only: down, down, Enter
      await p.fill('#jobRoleSearch', 'design'); await p.waitForTimeout(200);
      const first = (await opts())[0];
      await p.press('#jobRoleSearch', 'ArrowDown'); await p.press('#jobRoleSearch', 'Enter'); await p.waitForTimeout(300);
      ok(await p.inputValue('#jobRoleSearch') === first, 'the picker works from the keyboard alone' + S);

      await p.click('#jobRoleClear'); await p.waitForTimeout(200);
      await p.fill('#jobRoleSearch', 'sound designer'); await p.waitForTimeout(200);
      await p.click('#jobRoleList .pp-opt[data-slug="sound-designer"]'); await p.waitForTimeout(300);
      const labels = await p.locator('#jobSpecs label').allTextContents();
      ok(labels.join('|') === 'Sound for|Audio skills|Audio software', 'the sound designer brings his own work, skills and software' + S);
      ok(await p.locator('#jobSpecs .job-opt[data-k="audio_software"][data-v="pro_tools"]').count() === 1, 'Pro Tools is in the list, Premiere Pro is not' + S);
      ok(await p.locator('#jobSpecs .job-opt[data-k="software"]').count() === 0, '…the video software list stays out of it' + S);

      await p.fill('#jobRoleSearch', 'seo'); await p.waitForTimeout(250);
      await p.click('#jobRoleList .pp-opt[data-slug="seo-specialist"]'); await p.waitForTimeout(300);
      const l2 = await p.locator('#jobSpecs label').allTextContents();
      ok(l2.join('|') === 'SEO work|Marketing skills|Marketing tools' && await p.locator('#jobSpecs .job-opt[data-k="audio_skills"]').count() === 0,
        'switching profession swaps the whole set of options' + S);

      // what the client picked ends up on the job, and only fields this profession owns
      await p.click('#jobSpecs .job-opt[data-k="seo_work"][data-v="local"]');
      await p.click('#jobSpecs .job-opt[data-k="marketing_tools"][data-v="ahrefs"]');
      await p.waitForTimeout(200);
      ok((await p.textContent('#pvTags')).includes('SEO specialist') && (await p.textContent('#pvTags')).includes('Local SEO') && (await p.textContent('#pvTags')).includes('Ahrefs'),
        'the live preview shows the profession and every chip chosen' + S);

      await p.click('#jobRoleSearch'); await p.waitForTimeout(300);
      ok(await p.locator('#jobRoleList .pp-opt').count() >= 25 && await p.inputValue('#jobRole') === 'seo-specialist',
        'clicking the field again shows all of them without losing the one already chosen' + S);
      await p.keyboard.press('Escape'); await p.waitForTimeout(150);
      await p.click('#jobRoleClear'); await p.waitForTimeout(250);
      ok(await p.locator('#jobSpecs .job-opt').count() === 0 && (await p.textContent('#pvTags')).trim() === '',
        'clearing the profession clears its options and the preview' + S);
      ok(errs.length === 0, 'no script error along the way' + S);
    } catch (e) { log.push('CRASH ' + e.message + S); }
    await p.close();
  }
  await b.close();
  console.log(log.join('\n'));
  const f = log.filter(l => !l.startsWith('PASS')).length;
  console.log(`\n${log.length - f}/${log.length} passed`);
  process.exit(f ? 1 : 0);
})();
