// Tries to break the UI: every language × phone/tablet/desktop width × every page, missing translations,
// weird input (huge, emoji, HTML, RTL), rapid clicks, unknown routes, back/forward. Run: node tests/ui-fuzz.js
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path'); const { execSync } = require('child_process');
const ROOT = process.cwd();
const log = []; const ok = (c, m) => log.push((c ? 'PASS ' : 'FAIL ') + m);
const warn = (m) => log.push('WARN ' + m);

// test copy that exposes the translation table
const tmp = fs.mkdtempSync('/tmp/cuvori-fuzz-');
let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace('const T = {', 'const T = window.__T = {');
fs.writeFileSync(path.join(tmp, 'index.html'), html);
execSync(`python3 ${ROOT}/tools/csp.py ${tmp}/index.html`);
const URL = 'file://' + tmp + '/index.html';
const mock = fs.readFileSync(path.join(ROOT, 'mock-supabase.js'), 'utf8');

// every key the code asks for
const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const used = new Set();
for (const m of src.matchAll(/\bt\("([A-Za-z0-9_]+)"\)/g)) used.add(m[1]);
for (const m of src.matchAll(/data-i18n(?:-placeholder)?="([A-Za-z0-9_]+)"/g)) used.add(m[1]);

(async () => {
  const b = await chromium.launch();
  const LANGS = ['en', 'de', 'ru', 'lt', 'es', 'pl', 'uk'];
  const ROUTES = ['home', 'jobs', 'post-job', 'how', 'join-editor', 'create-account', 'contracts', 'account', 'settings'];
  const WIDTHS = [320, 390, 768, 1400];

  // ---- translations ----
  {
    const ctx = await b.newContext(); await ctx.addInitScript(mock);
    await ctx.route('**/supabase.min.js', r => r.fulfill({ status: 200, body: '/* mocked */', contentType: 'application/javascript' }));
    const p = await ctx.newPage(); await p.goto(URL); await p.waitForTimeout(500);
    const T = await p.evaluate(() => { const o = {}; for (const l in window.__T) o[l] = Object.keys(window.__T[l]); return o; });
    const en = new Set(T.en);
    const missingEn = [...used].filter(k => !en.has(k));
    ok(missingEn.length === 0, `every key used by the code exists in English${missingEn.length ? ' — missing: ' + missingEn.join(', ') : ''}`);
    for (const l of LANGS.slice(1)) {
      const have = new Set(T[l]);
      const miss = [...en].filter(k => !have.has(k) && used.has(k));
      if (miss.length) warn(`${l}: ${miss.length} texts fall back to English (${miss.slice(0, 8).join(', ')}${miss.length > 8 ? ', …' : ''})`);
    }
    // contract clauses must never fall back to English: a contract in German has to be German throughout
    const contractKeys = [...en].filter(k => /^(ct_|k_)/.test(k));
    const badLang = LANGS.slice(1).filter(l => contractKeys.some(k => !new Set(T[l]).has(k)));
    ok(contractKeys.length > 100 && badLang.length === 0, `contract clauses exist in every language${badLang.length ? ' — incomplete: ' + badLang.join(', ') : ` (${contractKeys.length} texts × ${LANGS.length})`}`);
    // the rules and the privacy notice are what people agree to: they must be readable in the language they signed up in
    const profKeys = [...en].filter(k => /^(pf_|sv_|av_)/.test(k));
    const badProf = LANGS.slice(1).filter(l => profKeys.some(k => !new Set(T[l]).has(k)));
    ok(profKeys.length > 30 && badProf.length === 0, `profession, service and availability texts exist in every language${badProf.length ? ' — incomplete: ' + badProf.join(', ') : ` (${profKeys.length} texts × ${LANGS.length})`}`);
    // and every profession, filter and option label carries all seven languages (proper nouns may stay identical)
    const cfg = await p.evaluate(() => window.CUVORI_PROFESSIONS);
    const missing = [];
    for (const pr of cfg.professions) for (const l of LANGS) if (!pr.labels[l]) missing.push(pr.slug + ':' + l);
    for (const f of cfg.filters) { for (const l of LANGS) if (!f.labels[l]) missing.push(f.key + ':' + l); for (const o of f.options) for (const l of LANGS) if (!o.labels[l] && !o.labels.en) missing.push(f.key + '.' + o.key + ':' + l); }
    ok(missing.length === 0, `profession and filter labels exist in every language${missing.length ? ' — missing: ' + missing.slice(0, 8).join(', ') : ''}`);
    const ruleKeys = [...en].filter(k => /^(r_|pv_|ra_)/.test(k));
    const badRules = LANGS.slice(1).filter(l => ruleKeys.some(k => !new Set(T[l]).has(k)));
    ok(ruleKeys.length > 60 && badRules.length === 0, `rules and privacy notice exist in every language${badRules.length ? ' — incomplete: ' + badRules.join(', ') : ` (${ruleKeys.length} texts × ${LANGS.length})`}`);
    await ctx.close();
  }

  // ---- every language × width × page: no errors, no sideways scrolling, no raw keys ----
  for (const lang of LANGS) {
    for (const w of WIDTHS) {
      const ctx = await b.newContext({ viewport: { width: w, height: 800 } });
      await ctx.addInitScript(mock); await ctx.addInitScript(l => localStorage.setItem('cuvoriLanguage', l), lang);
      await ctx.route('**/supabase.min.js', r => r.fulfill({ status: 200, body: '/* mocked */', contentType: 'application/javascript' }));
      const p = await ctx.newPage(); const errs = [];
      p.on('pageerror', e => errs.push(e.message));
      await p.goto(URL); await p.waitForTimeout(300);
      const bad = [];
      for (const r of ROUTES) {
        await p.evaluate(h => { location.hash = h; }, r); await p.waitForTimeout(150);
        const res = await p.evaluate(() => {
          const over = document.scrollingElement.scrollWidth - window.innerWidth;
          const text = document.querySelector('.page.active')?.innerText || '';
          const raw = (text.match(/\b(?:c|es|err|d|a|p|st|rv|dz|pay|ban|f|mib|ct|k)_[A-Za-z]+\b/g) || []).filter(x => !/^(e|a)_mail$/.test(x));
          return { over, raw: [...new Set(raw)].slice(0, 5) };
        });
        if (res.over > 1) bad.push(`${r}: page is ${res.over}px wider than the screen`);
        if (res.raw.length) bad.push(`${r}: raw text keys ${res.raw.join(',')}`);
      }
      ok(!bad.length && !errs.length, `${lang} @${w}px: all pages render${bad.length ? ' — ' + bad.join('; ') : ''}${errs.length ? ' — errors: ' + errs.slice(0, 3).join(' | ') : ''}`);
      await ctx.close();
    }
  }

  // ---- hostile / odd input as signed-in users ----
  {
    const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
    await ctx.addInitScript(mock);
    await ctx.route('**/supabase.min.js', r => r.fulfill({ status: 200, body: '/* mocked */', contentType: 'application/javascript' }));
    const p = await ctx.newPage(); const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    p.on('dialog', d => { errs.push('unexpected dialog: ' + d.message()); d.dismiss(); });
    await p.goto(URL); await p.waitForTimeout(400);
    const NAME = 'Ž💥 <b>Ölçü</b> مرحبا ' + 'x'.repeat(200);
    await p.goto(URL + '#create-account'); await p.waitForTimeout(200);
    await p.fill('#suName', NAME); await p.fill('#suEmail', 'fuzz@test.com'); await p.fill('#suPass', 'password123');
    // the rules box is not ticked yet: nothing may be created
    await p.click('[data-auth-signup]'); await p.waitForTimeout(500);
    ok(await p.evaluate(() => window.__mockdb.profiles.filter(x => x.email === 'fuzz@test.com').length === 0), 'sign-up is refused until the rules are agreed to');
    await p.check('#suAgree');
    await p.click('[data-auth-signup]'); await p.click('[data-auth-signup]').catch(() => {}); await p.waitForTimeout(900);
    ok(await p.evaluate(() => window.__mockdb.profiles.filter(x => x.email === 'fuzz@test.com').length === 1), 'double-click on sign-up creates one account');
    ok(await p.evaluate(() => (window.__mockdb.profiles.find(x => x.email === 'fuzz@test.com') || {}).first_name.length <= 80), 'name field stops at 80 characters');
    ok(await p.evaluate(() => !document.querySelector('b') || !document.body.innerHTML.includes('<b>Ölçü</b>')), 'HTML typed into a name is shown as text');
    // on a phone the language button sits in the header, next to Sign in / the icons, and opens a list
    await p.goto(URL + '#home'); await p.waitForTimeout(400);
    ok(await p.locator('#langBtn').isVisible() && (await p.locator('#langBtn').boundingBox()).y < 60, 'phone header has the language button');
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'signed in, the phone header still fits the screen');
    await p.click('#langBtn'); await p.waitForTimeout(200);
    const pop = await p.locator('#langPop').boundingBox();
    ok(await p.locator('#langPop').isVisible() && pop.width > 300 && await p.locator('#langPop [data-lang]').count() === 7, 'tapping it opens a full-width list of the 7 languages');
    await p.click('#langPop [data-lang="lt"]'); await p.waitForTimeout(300);
    ok((await p.textContent('#langBtn')).includes('LT') && (await p.textContent('h1')).includes('Raskite') && await p.locator('#langPop').evaluate(e => e.classList.contains('hidden')), 'choosing Lietuvių switches the page and closes the list');
    await p.click('#langBtn'); await p.click('#langPop [data-lang="en"]'); await p.waitForTimeout(300);
    await p.goto(URL + '#no-such-page'); await p.waitForTimeout(300);
    ok(await p.evaluate(() => document.querySelector('#page-home').classList.contains('active')), 'unknown address falls back to the home page');
    await p.goto(URL + '#contracts?paid=../../etc'); await p.waitForTimeout(300);
    ok(errs.length === 0, 'malformed payment-return link does not crash');
    // post a job with extreme input
    await p.goto(URL + '#post-job'); await p.waitForTimeout(200);
    await p.click('#jobRoleSearch'); await p.fill('#jobRoleSearch', 'video editor'); await p.waitForTimeout(200);
    await p.click('#jobRoleList .pp-opt[data-slug="video-editor"]'); await p.waitForTimeout(200);
    await p.fill('#jobTitle', 'T'.repeat(500)); await p.fill('#jobDesc', '🎬'.repeat(3000) + '<script>window.__x=1</script>');
    await p.fill('#jobBudget', '€'.repeat(100)); await p.click('#publishJob'); await p.waitForTimeout(700);
    const job = await p.evaluate(() => window.__mockdb.jobs.at(-1));
    ok(job && job.title.length <= 150 && job.budget.length <= 60, 'job form trims to database limits');
    await p.goto(URL + '#jobs'); await p.waitForTimeout(500);
    ok(await p.evaluate(() => window.__x === undefined), 'script typed into a job does not run');
    ok(await p.evaluate(() => document.scrollingElement.scrollWidth <= window.innerWidth + 1), 'a giant unbroken job text does not break the phone layout');
    // rapid language switching + back/forward
    for (const l of ['de', 'ru', 'lt', 'uk', 'en']) await p.evaluate(c => { const b = document.querySelector(`[data-lang="${c}"]`); if (b) b.click(); }, l);
    await p.goto(URL + '#how'); await p.goBack(); await p.goForward(); await p.waitForTimeout(300);
    ok(errs.length === 0, 'fast language switching and back/forward cause no errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
    await ctx.close();
  }
  await b.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(log.join('\n'));
  const f = log.filter(x => x.startsWith('FAIL')).length;
  console.log(`${log.filter(x => x.startsWith('PASS')).length} passed, ${f} failed, ${log.filter(x => x.startsWith('WARN')).length} warnings`);
  process.exit(f ? 1 : 0);
})();
