// The new prices on the page (schema v56): the homepage shows the owner's pricing wording only while the database says
// the new prices are in force (pricing_now, plan 2); before v56, or while the switch is off, the page stays exactly as
// today. Under the new prices a delivery needs a link to the work, and the Order screen shows the Order's own days.
// Run: node pricing-page.js   (from the repo folder)
const { chromium } = require('playwright'); const fs = require('fs');
const log = []; const ok = (c, m) => log.push((c ? 'PASS ' : 'FAIL ') + m);
const mock = fs.readFileSync(__dirname + '/mock-supabase.js', 'utf8');
const path = require('path'); const here = (f) => path.join(__dirname, f);   // the files of this copy, wherever it is started from
const url = 'file://' + here('index.html');
const LANGS = ['en', 'de', 'ru', 'lt', 'es', 'pl', 'uk'];
// a text from the page's own tables, exactly as written there: T has today's texts, T_PRICES the new-price ones
const SRC = fs.readFileSync(__dirname + '/index.html', 'utf8');
const textOf = (table, lang, key) => {
  const a = SRC.indexOf(`const ${table} = {`); if (a < 0) return null;
  const block = SRC.slice(a, SRC.indexOf('\n  };', a));
  const starts = LANGS.map(l => [l, block.search(new RegExp(`\\n\\s+${l}:\\{`))]).filter(([, i]) => i >= 0).sort((x, y) => x[1] - y[1]);
  const i = starts.findIndex(([l]) => l === lang); if (i < 0) return null;
  const part = block.slice(starts[i][1], i + 1 < starts.length ? starts[i + 1][1] : block.length);
  const m = part.match(new RegExp(`[{,\\s]${key}:"((?:[^"\\\\]|\\\\.)*)"`)); return m ? JSON.parse('"' + m[1] + '"') : null;
};
// the four homepage texts the prices change, as the page must show them in a language (today's, or the new-price ones)
const homeTexts = (lang, v2) => { const k = (key) => (v2 && textOf('T_PRICES', lang, key + '__p2')) || textOf('T', lang, key);
  return { hero: k('heroTitle') + ' | ' + k('heroSub'), step4: k('step4'), footer: k('footer') }; };
// today's "no commission" claims on the homepage, by language (they must go under the new prices)
const OLD = { en: /commission/i, de: /provision/i, ru: /комисси/i, lt: /komisin/i, es: /comisi/i, pl: /prowizj/i, uk: /комісі/i };
const P1 = { version: 1, commission_bps: 0, min_project_cents: 100, card_costs_paid_by: 'client', review_days: 7, rounding: 'half_up', currency: 'EUR', rules_version: null };
const P2 = { version: 2, commission_bps: 500, min_project_cents: 200, card_costs_paid_by: 'platform', review_days: 14, rounding: 'half_up', currency: 'EUR', rules_version: '2026-11' };

async function open(b, prices, lang, width = 1400, extra, opts = {}) {
  const ctx = await b.newContext({ viewport: { width, height: 900 } });
  await ctx.addInitScript(([pr, lg, cached]) => { try { localStorage.setItem('cuvoriLanguage', lg); if (cached) localStorage.setItem('cuvoriPrices', JSON.stringify(cached)); } catch (e) {} if (pr) window.__mockPrices = pr; }, [prices, lang, opts.cached || null]);
  if (extra) await ctx.addInitScript(extra);
  await ctx.addInitScript(mock);
  // the price lookup takes this long (a slow phone network)
  if (opts.delay) await ctx.addInitScript((ms) => { const mk = window.supabase.createClient; window.supabase.createClient = (...a) => { const c = mk(...a); const rpc = c.rpc.bind(c);
    c.rpc = (fn, args) => fn === 'pricing_now' ? new Promise(r => setTimeout(() => r(rpc(fn, args)), ms)) : rpc(fn, args); return c; }; }, opts.delay);
  await ctx.route('**/supabase.min.js', r => r.fulfill({ status: 200, body: '/* mocked */', contentType: 'application/javascript' }));
  // a clock the test can move forward (time still runs as usual until then)
  if (opts.clock) await ctx.clock.install();
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(url); await p.waitForTimeout(opts.wait ?? 700);
  return { ctx, p, errs };
}
const home = async (p) => p.evaluate(() => ({
  shown: !document.querySelector('#pricingBlock').hidden && document.querySelector('#pricingBlock').offsetHeight > 0,
  block: document.querySelector('#pricingBlock').innerText,
  hero: document.querySelector('[data-i18n="heroTitle"]').textContent + ' | ' + document.querySelector('[data-i18n="heroSub"]').textContent,
  step4: document.querySelector('[data-i18n="step4"]').textContent, footer: document.querySelector('[data-i18n="footer"]').textContent,
  wide: document.documentElement.scrollWidth - document.documentElement.clientWidth }));

(async () => {
  // every new-price text exists in all 7 languages (a missing one would show today's claim, or English)
  {
    const src = fs.readFileSync(here('index.html'), 'utf8'), a = src.indexOf('const T_PRICES = {'), z = src.indexOf('for(const code in T_PRICES)');
    const block = a >= 0 && z > a ? src.slice(a, z) : '';
    const keys = [...new Set([...block.matchAll(/([A-Za-z0-9_]+):"/g)].map(m => m[1]))];
    const short = keys.filter(k => (block.match(new RegExp('[{ ,]' + k + ':"', 'g')) || []).length !== 7);
    ok(keys.length >= 12 && !short.length && LANGS.every(l => block.includes('\n    ' + l + ':{')), `the new-price texts: ${keys.length} keys, each in all 7 languages${short.length ? ' — not in every language: ' + short.join(', ') : ''}`);
    // each language's part of the block: from "\n    xx:{" to the next language (or the end), and its texts by key
    const lines = Object.fromEntries(LANGS.map(l => { const i = block.indexOf('\n    ' + l + ':{'); const next = LANGS.map(o => block.indexOf('\n    ' + o + ':{')).filter(x => x > i).sort((x, y) => x - y)[0]; return [l, i < 0 ? '' : block.slice(i, next)]; }));
    const texts = Object.fromEntries(LANGS.map(l => [l, Object.fromEntries([...(lines[l] || '').matchAll(/([A-Za-z0-9_]+):"([^"]*)"/g)].map(m => [m[1], m[2]]))]));
    // the phrases corrected in the review of update 34 (checked by Claude against the English, not by a native speaker:
    // a native speaker should read the new texts before the switch, SETUP.md Part 20)
    const want = [['es', 'apruebe la entrega (o pasen'], ['es', 'costes del pago con tarjeta'], ['pl', 'dodawanie zleceń'], ['pl', 'pobiera {pct}% prowizji'], ['de', 'Provision ein und trägt'],
      ['ru', 'берёт на себя расходы на оплату картой.'], ['uk', 'бере на себе витрати на оплату карткою.'], ['lt', 'padengia kortelių mokėjimų mokesčius'],
      ['de', 'bevor die Arbeit beginnt'], ['ru', 'до начала работы'], ['es', 'antes de empezar el trabajo'], ['pl', 'przed rozpoczęciem pracy'],
      // Ukrainian: a job post is "робота" on this site ("Опублікувати роботу"); "замовлення" is an Order
      ['uk', 'hp_clientsText:"Публікація робіт безкоштовна.'], ['uk', 'heroSub__p2:"Публікація робіт безкоштовна.']];
    const miss = want.filter(([l, w]) => !(lines[l] || '').includes(w)).map(([l, w]) => `${l}: "${w}"`);
    // every text carries the same placeholders as the English one, and none is left in English
    const off = [];
    for (const l of LANGS.filter(x => x !== 'en')) for (const k of Object.keys(texts.en)) {
      const en = texts.en[k], s = texts[l][k] || '';
      const ph = (x) => (x.match(/\{[a-z]+\}/g) || []).sort().join('');
      if (ph(en) !== ph(s)) off.push(`${l}.${k}: placeholders ${ph(s) || 'none'} (English ${ph(en) || 'none'})`);
      if (s === en) off.push(`${l}.${k}: still English`);
    }
    // the proposal note under the new prices says when the days start: after a valid delivery, with no dispute opened
    const valid = { en: 'after a valid delivery', de: 'nach einer gültigen Lieferung', ru: 'после надлежащей сдачи', lt: 'po tinkamo pristatymo', es: 'desde una entrega válida', pl: 'od prawidłowej dostawy', uk: 'після належної здачі' };
    for (const l of LANGS) if (!(texts[l].es_proposeNote__p2 || '').includes(valid[l])) miss.push(`${l}: es_proposeNote__p2 without "${valid[l]}"`);
    // every event v56 writes into an Order's history has its text in all 7 languages (otherwise the history shows its code)
    const v56src = fs.readFileSync(here('supabase/schema_v56.sql'), 'utf8');
    const events = new Set([...v56src.matchAll(/order_log\([^,]+,\s*'([a-z_]+)'/g)].map(m => m[1]));
    if (!events.size) miss.push('no history event found in schema v56 (the check would prove nothing)');
    for (const ev of events)
      if ((src.match(new RegExp('[{ ,]o_ev_' + ev + ':"', 'g')) || []).length < 7) miss.push(`history text o_ev_${ev} not in all 7 languages`);
    // the "rules changed" message says what is true: the page asks the person clicking right away (it promises no "next time")
    const nextTime = { en: /next time/, de: /beim nächsten/, ru: /при следующем/, lt: /kitą kartą/, es: /próxima vez/, pl: /przy następnym/, uk: /наступного/ };
    for (const l of LANGS) { const m = block.match(new RegExp(`\\n    ${l}:\\{[\\s\\S]*?err_rulesNotAccepted:"([^"]*)"`)); if (!m) miss.push(`${l}: no err_rulesNotAccepted`); else if (nextTime[l].test(m[1])) miss.push(`${l}: err_rulesNotAccepted promises "next time"`); }
    // a price change redraws only the data-i18n texts and the homepage block (applyPriceTexts): every "__p2" text must be
    // one of those, or the proposal note (built each time the new-Order form opens), or it would stay old until a reload
    for (const k of [...new Set([...src.matchAll(/([A-Za-z0-9_]+)__p2:"/g)].map(m => m[1]))])
      if (k !== 'es_proposeNote' && !src.includes(`data-i18n="${k}"`)) miss.push(`${k}__p2 is not redrawn when the prices change (not a data-i18n text)`);
    ok(!miss.length && !off.length, `the new-price texts: the 14 corrected phrases are in place, and every text has the English one's placeholders and is translated${miss.length ? ' — missing: ' + miss.join('; ') : ''}${off.length ? ' — ' + off.join('; ') : ''}`);
  }
  // the notes say what is true (SETUP.md, PRODUCT_SPEC.md, README.md, the top of schema v56)
  {
    const read = (f) => fs.readFileSync(here(f), 'utf8');
    const setup = read('SETUP.md'), spec = read('PRODUCT_SPEC.md'), readme = read('README.md'), v56 = read('supabase/schema_v56.sql'), page = read('index.html');
    const part20 = setup.slice(setup.indexOf('## Part 20'), setup.indexOf('## Part 21'));
    const step = (n) => { const m = part20.split('**Turning the new prices on')[1] || ''; const a = m.indexOf('\n' + n + '. '); const ends = [m.indexOf('\n' + (n + 1) + '. ', a + 1), m.indexOf('\n\n', a + 1)].filter(i => i >= 0); return a < 0 ? '' : m.slice(a, ends.length ? Math.min(...ends) : undefined); };
    const heroEn = (page.match(/heroTitle:"([^"]*)"/) || [])[1] || '?';
    const todayQuoted = [['README.md', readme], ['PRODUCT_SPEC.md', spec]].map(([f, s]) => [f, (s.match(/[Hh]eadline today: \*\*([^*]+)\*\*/) || [])[1] || '?']);
    const wrongHead = todayQuoted.filter(([, q]) => q !== heroEn).map(([f, q]) => `${f} says today's headline is "${q}"`);
    const afterPart = (s, from, to) => { const a = s.indexOf(from); const z = to ? s.indexOf(to, a + 1) : -1; return a < 0 ? '' : s.slice(a, z < 0 ? undefined : z); };
    const goBack = afterPart(part20, '**Going back**', '**Undoing v56'), undo = afterPart(part20, '**Undoing v56', '**Decisions');
    const mistaken = afterPart(part20, 'If you turn the switch on before steps 1 and 2', '**Going back**');
    const problems = [
      ...wrongHead,
      /page description|line 8/i.test(step(3)) ? 'SETUP step 3 changes the page description before the switch' : '',
      !/description/i.test(step(6)) ? 'SETUP step 6 does not change the page description' : '',
      /page description/i.test(((spec.split('\n').find(l => /Every other "no commission" text/.test(l)) || '').match(/Every other "no commission" text \(([^)]*)\)/) || [])[1] || '') ? 'PRODUCT_SPEC lists the page description among the texts rewritten before the switch' : '',
      !/PRICES_ASSUMED|step 6/.test(goBack) ? 'SETUP "Going back" does not undo the step 6 page update' : '',
      !/PRICES_ASSUMED|step 6/.test(undo) ? 'SETUP "Undoing v56" does not undo the step 6 page update' : '',
      /send back a late payment that never went into the Order/.test(part20 + v56) ? 'SETUP or schema v56 says old code still sends back late payments on new-price Orders' : '',
      // the older parts of SETUP describe today's prices; where the new prices change what they say, they point to Part 20
      ...[[/AUTO_RELEASE_DAYS/, 'Part 6 (the 7 days in three places)'], [/processing cost on top of the Order price/, 'Part 7 (who pays the card costs, "no fees")'],
          [/or 7 days pass after delivery/, 'Part 5 (when the money is paid out)'], [/Cuvori fee \(€0\)/, 'Part 13 (the payment box)']]
        .map(([re, where]) => { const line = setup.slice(0, setup.indexOf('## Part 20')).split('\n').find(l => re.test(l)) || ''; return !line ? `SETUP ${where}: line not found` : !/Part 20/.test(line) ? `SETUP ${where} says nothing about the new prices` : ''; }),
      !/under the new prices/i.test((spec.split('## 32.')[1] || '').split('\n## ')[0]) ? 'PRODUCT_SPEC section 32 states the new prices as if they were today\'s' : '',
      // README's core message is today's: under the new prices Cuvori keeps 5%
      !/Core message today/.test(readme) ? 'README gives "Cuvori does not take your money" without "today"' : '',
      // the 5% is on projects paid through Cuvori only; projects paid directly pay none
      ...[['README.md', readme], ['SETUP.md', setup], ['PRODUCT_SPEC.md', spec], ['CLAUDE.md', read('CLAUDE.md')]]
        .filter(([, s]) => /5% commission\*{0,2} on paid projects/.test(s)).map(([f]) => `${f} says the 5% is on "paid projects", not on projects paid through Cuvori`),
      // PRODUCT_SPEC's list of texts rewritten before the switch includes the Order screen's payment box and notes
      !/Order screen/.test(((spec.split('\n').find(l => /Every other "no commission" text/.test(l)) || '').match(/Every other "no commission" text \(([^)]*)\)/) || [])[1] || '') ? 'PRODUCT_SPEC\'s list of texts rewritten before the switch leaves out the Order screen' : '',
      // the pause for parts during a dispute covers Orders paid through Cuvori only (direct Orders have no held money)
      /on every Order, nothing is paid out for a part/.test(part20) ? 'SETUP says the pause for parts covers every Order, not only Orders paid through Cuvori' : '',
      // the database records a payout with a wrong commission and lists it: a cent's difference can also come from a
      // mistake in the payment code, so no note may say it "can only" come from a line added afterwards
      ...[...part20.matchAll(/[^.;(]*(?:can only come from a payout line|Only a payout line added afterwards)[^.;)]*/g)].filter(m => !/working right/.test(m[0]))
        .map(m => `SETUP says a cent's difference can only come from a line added afterwards: "${m[0].trim().slice(0, 70)}…"`),
      /native speaker checked|native-speaker check corrected/i.test(setup + spec + readme) ? 'a note claims a native speaker checked the texts' : '',
    ].filter(Boolean);
    ok(!problems.length, `the notes match the page and each other (today's headline "${heroEn}", the page description only right after the switch, going back undoes it)${problems.length ? ' — ' + problems.join('; ') : ''}`);
    // what the owner does by hand: nothing in the notes may lead him into a step that breaks payments or hides money
    const line = (s, re) => s.split('\n').find(l => re.test(l)) || '';
    const claude = read('CLAUDE.md'), runV56 = afterPart(part20, '**Running v56', '**Turning the new prices on');
    const part = (n) => { const a = setup.indexOf('## Part ' + n + ' '); const z = setup.indexOf('\n## Part ', a + 1); return a < 0 ? '' : setup.slice(a, z < 0 ? undefined : z); };
    const ledgerRule = line(part20, /The ledger holds the truth about the money/);
    const runStep = (n) => { const a = runV56.indexOf('\n' + n + '. '), z = runV56.indexOf('\n' + (n + 1) + '. ', a + 1); return a < 0 ? '' : runV56.slice(a, z < 0 ? undefined : z); };
    const upload = afterPart(part20, '**Getting this update onto GitHub', '**Running v56');
    const steps = [
      // the fee table never makes Cuvori carry the card costs: payer "platform" pauses every payment in today's code
      /the table can make Cuvori absorb it/.test(setup) || !/pauses every payment/.test(line(part(7), /processing cost on top of the Order price/)) ? 'SETUP Part 7 suggests the fee table can make Cuvori carry the card costs (it pauses every payment)' : '',
      // the page of this update goes live only by merging pricing-v2 into main, after v56 has run
      !/Merge pull request/.test(runV56) || !/compare\/main\.\.\.pricing-v2/.test(runV56) ? 'SETUP "Running v56" has no step that merges pricing-v2 into main' : '',
      /it is now "Garso editorius" on the page/.test(part(21)) ? 'SETUP Part 21 says the new word is on the page before the page is live' : '',
      // a card fee charged in error is not refunded from the Stripe dashboard (that would be booked as Order money)
      /refund them to the client/.test(line(part20, /client_charged_card_fee/)) || !/ask for help/.test(line(part20, /client_charged_card_fee/)) ? 'SETUP tells the owner to refund a wrongly charged card fee without a safe way' : '',
      // undo only before the payment code for the new prices is live
      !/before the payment code for the new prices/.test(afterPart(part20, '**Undoing v56', '**Decisions')) ? 'SETUP "Undoing v56" does not say it must come before the new payment code' : '',
      // going back also brings back the rules
      !/rules/.test(afterPart(part20, '**Going back**', '**Undoing v56')) ? 'SETUP "Going back" forgets the published rules' : '',
      // step 6 changes every old claim written into the page, by its words
      !['does not take your money', 'Cuvori takes no commission', 'No marketplace commission'].every(w => step(6).includes(w)) ? 'SETUP step 6 does not name every old claim built into the page' : '',
      // older parts that describe today's prices say so
      !/Today's prices throughout this part/.test(part(5)) ? 'SETUP Part 5 does not say it describes today\'s prices' : '',
      !/stay free/.test(line(part(16), /posting_plans/)) ? 'SETUP Part 16 still plans paid job posts or monthly plans without your decision' : '',
      !/review_days/.test(line(part(6), /AUTO_RELEASE_DAYS/)) ? 'SETUP Part 6 item 5 misses the 7 days of plan 1 in the price plans' : '',
      // the refused lines, all of them
      !/succeeded/.test(ledgerRule) || !/below 0/.test(ledgerRule) ? 'SETUP\'s list of refused ledger lines is incomplete' : '',
      // small wording
      /ledger lines can no longer be edited/.test(part20) ? 'SETUP says ledger lines can no longer be edited at all' : '',
      /An agreed Order can also never be set back to a proposal/.test(part20) ? 'SETUP says every agreed Order (also from before v56) can never be set back to a proposal' : '',
      /keeps saying 7 days, also after the switch/.test(part20) ? 'SETUP\'s rules-page note is confusing' : '',
      /the proposal and payment notes on the Order screen/.test(part20) ? 'SETUP step 3 lists the proposal note, which switches by itself' : '',
      /you can delete the `cuvori-update33` folder on your computer\./.test(part20) ? 'SETUP says to delete the update 33 folder before v56 has run' : '',
      // refunds of payments that cannot go into an Order: as the code does them
      /fee included/.test(setup.slice(0, setup.indexOf('## Part 20'))) ? 'SETUP says today\'s code refunds late or second payments "fee included" (it keeps Stripe\'s card fee)' : '',
      !/refunded in full/.test(step(1)) ? 'SETUP step 1 does not say a payment that cannot go into its Order is refunded in full under the new prices' : '',
      // directly paid projects: what the code does, and that keeping them is still open
      ...[['CLAUDE.md', line(claude, /\*\*Prices \(final/)], ['PRODUCT_SPEC.md', spec], ['README.md', readme]]
        .filter(([, s]) => { const said = (s.match(/[^.]*paid directly[^.]*\.[^.]*\./) || [''])[0]; return !said || !/not decided|still open/.test(said); })
        .map(([f]) => `${f} states direct payments as decided (or leaves them out)`),
      // references
      (() => { const sec = (readme.match(/Security review before public launch[^\n]*section (\d+)/) || [])[1]; return sec && !new RegExp('^## ' + sec + '\\. Security', 'm').test(spec) ? `README points to PRODUCT_SPEC section ${sec} for the security review` : ''; })(),
      !fs.existsSync(here('cuvori-index.html')) && !/not in this repository/.test(claude + readme) && !/grew into/.test(claude + readme) ? 'CLAUDE.md and README describe cuvori-index.html as if it were here' : '',
      // an old copy of the prototype is inside the zip: the notes say where it is, not that it is gone
      fs.existsSync(here('cuvori-repo-files.zip')) && (/not in this repository/.test(claude + readme) || !/cuvori-repo-files\.zip/.test(claude) || !/cuvori-repo-files\.zip/.test(readme)) ? 'CLAUDE.md or README says the prototype is gone, while a copy is in cuvori-repo-files.zip' : '',
      /The prototype contains the full translation table/.test(spec) ? 'PRODUCT_SPEC section 27 says the translations are in the prototype (they are in index.html)' : '',
      !/at once when the client approves/.test(line(claude, /\*\*Prices \(final/)) ? 'CLAUDE.md\'s price rule leaves out that approval pays out at once' : '',
      !fs.existsSync(here('cuvori-index.html')) && /It contains a complete 7-language translation table/.test(claude) ? 'CLAUDE.md tells AI tools to reuse strings from a file that is not here' : '',
      /original plan/.test(readme) && /Follow the order in `README\.md`\./.test(claude) ? 'CLAUDE.md says to follow README\'s build order, which README calls the original plan' : '',
      // the files of this update reach GitHub on their own branch, never straight onto main (main is what cuvori.io shows)
      !['github.com/Skarpiii/Cuvori/upload/main', 'Create a new branch', 'github.com/Skarpiii/Cuvori/upload/pricing-v2', 'Commit directly to the'].every(w => upload.includes(w)) ? 'SETUP Part 20 does not say how the files of this update get onto pricing-v2' : '',
      !/Can.t automatically merge/.test(runStep(5)) || !/Delete branch/.test(runStep(5)) ? 'SETUP "Running v56" step 5 leaves the merge page\'s pitfalls out' : '',
      !/production/.test(runStep(5)) || !/15 credits/.test(runStep(5)) ? 'SETUP "Running v56" step 5 does not say Netlify production needs nothing for this update' : '',
      !/Run this query/.test(runStep(3)) ? 'SETUP "Running v56" step 3 does not prepare the owner for Supabase\'s warning about the query' : '',
      !/compare\/production\.\.\.main/.test(line(part(3), /merge `main` into `production`/)) || !/Merge pull request/.test(line(part(3), /merge `main` into `production`/)) ? 'SETUP Part 3 item 7 gives no clicks for merging main into production' : '',
      // the fee table: Part 13 says what Part 7 says
      /makes Cuvori absorb/.test(part(13)) || !/pauses every payment/.test((part(13).match(/[^.]*payer to \*\*platform\*\*[^.]*\./) || [''])[0]) ? 'SETUP Part 13 says a "platform" card row makes Cuvori carry the card cost (it pauses every payment)' : '',
      // a payment that comes too late: the card is only held, the hold is let go and nothing is charged
      !/hold/.test((part(13).match(/A payment that arrives after its Order[^.]*\./) || [''])[0]) || !/nothing is charged/.test((part(13).match(/A payment that arrives after its Order[^.]*\./) || [''])[0]) ? 'SETUP Part 13 says a late payment is refunded minus the card fee (today its hold is let go, nothing is charged)' : '',
      // every old claim written into the page (English, before it has loaded, and what Google reads) is in step 6
      ...(() => { const need = {}; for (const m of page.slice(0, page.indexOf('heroTitle:"')).matchAll(/data-i18n="\w+"[^>]*>([^<]+)</g)) for (const f of m[1].split(/[.;?!—]+/).map(x => x.trim()).filter(x => /commission|never takes a cut|Keep 100%|take your money|percentage|free for clients and editors|takes no fee/i.test(x))) need[f] = (need[f] || 0) + 1;
        const left = Object.entries(need).filter(([f, n]) => step(6).split(f).length - 1 < n).map(([f]) => `"${f}"`); return left.length ? [`SETUP step 6 leaves out old claims written into the page: ${left.join(', ')}`] : []; })(),
      !/"0%"/.test(step(3)) || !/"0%" badge/.test(step(6)) ? 'SETUP step 3 or step 6 forgets the "0%" badge on How it works (it has no text key, and it is written into the page)' : '',
      !/Create a free account/.test(step(3)) || /Post a job and its pop-up/.test(step(3)) ? 'SETUP step 3 does not name the sign-up pop-up ("Cuvori takes no commission")' : '',
      !/pop-up/.test(((spec.split('\n').find(l => /Every other "no commission" text/.test(l)) || '').match(/Every other "no commission" text \(([^)]*)\)/) || [])[1] || '') ? 'PRODUCT_SPEC\'s list of texts rewritten before the switch leaves out the sign-up pop-up' : '',
      // the freelancers' email: where the addresses come from, and the day in the rules; the rules version checked before the switch
      !/auth\.users/.test(step(4)) || !/Bcc/.test(step(4)) || !/day you do step 5/.test(step(4)) ? 'SETUP step 4 does not say where the freelancers\' addresses come from, or that the rules\' day is the switch day' : '',
      !/select version, rules_version from public\.pricing_plans/.test(step(5)) ? 'SETUP step 5 has no way to check the rules version before switching' : '',
      // the open decision on direct payments is asked, not stated
      !/\?/.test(line(afterPart(part20, '**Decisions', '**Where it lives'), /paid directly/)) || !/before the switch/.test(line(afterPart(part20, '**Decisions', '**Where it lives'), /paid directly/)) || !/`k_pay_direct`/.test(line(afterPart(part20, '**Decisions', '**Where it lives'), /paid directly/)) ? 'SETUP Part 20 never asks the open question on direct payments' : '',
      // small ones
      // outside its two numbered lists, Part 20 names a step with its list (steps 1 to 5 are in both)
      ...(() => { const outside = part20.replace(runV56, '').replace(afterPart(part20, '**Turning the new prices on', '\n\nIf you turn'), '');
        const vague = [...outside.matchAll(/\bsteps? [1-5](?: and [1-5])?(?! and [1-5])(?! of ")/g)].map(m => `"…${outside.slice(Math.max(0, m.index - 30), m.index + 12)}…"`);
        return vague.length ? [`SETUP Part 20 names steps without saying which list: ${vague.join(', ')}`] : []; })(),
      /what the client pays \(the agreed price\)/.test(part20) ? 'SETUP says the breakdown gives "the agreed price" as what the client pays, also for Orders at today\'s prices' : '',
      !/payout fee/.test(line(part(5), /Today's prices throughout this part/)) || /the client pays the card costs on top, 7 days/.test(part20) ? 'SETUP Part 5 or Part 20 leaves the payout fee out of today\'s prices' : '',
      !/ESCROW/.test(line(part(6), /AUTO_RELEASE_DAYS/)) || !/six places/.test(line(part(6), /AUTO_RELEASE_DAYS/)) ? 'SETUP Part 6 item 5 misses the page\'s own 7 days (ESCROW in index.html)' : '',
      /hiding it there is a page change/.test(part20) ? 'SETUP says hiding Stripe\'s fee from the Order\'s two sides is a page change (the database lets them read it)' : '',
      !/`main`/.test(undo) ? 'SETUP "Undoing v56" points only to pricing-v2, also after it is merged' : '',
      // every page text that makes a price claim today has its new-price version, or a switch step that names it
      ...(() => {
        const claim = /commission|no cut|no fee|Keep 100%|€0\b|\b0%|full amount goes to|receives for the work|payment fee|card fee|card cost|processing cost|on top of the price|never takes|percentage of the project|take your money/i;
        const decisions = afterPart(part20, '**Decisions', '**Where it lives');
        const has = (where, w) => where.includes(w);
        const COVER = {
          heroTitle: 'p2', heroSub: 'p2', step4: 'p2', footer: 'p2', es_proposeNote: 'p2',
          clientStep4Desc: [step(3), 'How it works page'], editorStep4Desc: [step(3), 'How it works page'], p_val1Title: [step(3), 'How it works page'],
          p_val1Desc: [step(3), 'How it works page'], p_faq1Q: [step(3), 'its questions'], p_faq1A: [step(3), 'its questions'],
          noCommissionTitle: [step(3), 'the Contracts page'], noCommissionDesc: [step(3), 'the Contracts page'], p_join1: [step(3), 'the Join page'],
          p_acc1: [step(3), 'Create account'], p_freeToPost: [step(3), 'Post a job'], jp_free: [step(3), '"Create a free account" pop-up'],
          noCommissionNote: [step(3), "every profile's price card"], o_priceHint: [step(3), 'price hint of the new-Order form'],
          o_processing: [step(3), 'card-fee lines on the Order screen'], o_connectHint: [step(3), 'card-fee lines on the Order screen'],
          o_cuvoriZero: [step(3), 'card-fee lines on the Order screen'], o_quoteFailed: [step(3), 'card-fee lines on the Order screen'],
          o_ev_late_payment_refunded: [step(3), 'history line for a late payment'],
          k_pay_escrow: [step(3), '`k_pay_escrow`'], k_entire: [step(3), '`k_entire`'], k_dispute: [step(3), '`k_dispute`'], r_s1: [step(3), 'the site rules'],
          k_pay_direct: [decisions, '`k_pay_direct`'],     // true of direct payments: it goes with that decision
          pay_desc: [step(3), '"Payout details" note'],  // above the Stripe payout box: rewritten whatever the decision
          o_ev_fee_refunded: 'plan 1', o_ev_fee_exact: 'plan 1',                                     // only an Order whose client paid a card fee has them
          paymentNotice: 'unused', c_noFee: 'unused', es_payDesc: 'unused',
        };
        const defs = {}; for (const m of page.matchAll(/([A-Za-z_]\w*):"((?:[^"\\]|\\.)*)"/g)) (defs[m[1]] = defs[m[1]] || []).push(m[2]);
        const found = Object.keys(defs).filter(k => k.length > 2 && defs[k].length % 7 === 0 && !/__p2$|^hp_/.test(k) && defs[k].some(t => claim.test(t)));   // a text key: one text per language, 7 (or 14 when in two tables)
        const out = [];
        for (const k of Object.keys(defs).filter(k => k.length > 2 && defs[k].length % 7 !== 0 && defs[k].some(t => claim.test(t) && /[a-z] [a-z]/i.test(t)) && !/__p2$|^hp_/.test(k)))
          out.push(`page text ${k} makes a price claim but is not in all 7 languages (${defs[k].length} copies)`);
        for (const k of found) {
          const c = COVER[k], en = (defs[k][0] || '').slice(0, 70);
          if (!c) out.push(`page text ${k} ("${en}…") makes a price claim and no switch step names it`);
          else if (c === 'p2' && (defs[k + '__p2'] || []).length < 7) out.push(`page text ${k} has no new-price version in all 7 languages`);
          else if (c === 'unused' && page.split(k).length - 1 !== defs[k].length) out.push(`page text ${k} is marked unused but the page uses it`);
          else if (Array.isArray(c) && !has(c[0], c[1])) out.push(`page text ${k} ("${en}…"): SETUP no longer names "${c[1]}"`);
        }
        for (const k of Object.keys(COVER)) if (!found.includes(k)) out.push(`page text ${k} is listed here but no longer makes a price claim: take it off the list`);
        return out;
      })(),
      !/pause/.test(step(1)) ? 'SETUP step 1 does not ask the new payment code to keep a way to pause payments (Part 5, item 10)' : '',
      // Part 3: production only for the payment code; credits are not only deploys
      !/only when an upload changed the payment code/.test(line(part(3), /merge `main` into `production`/)) || /so about 20 a month/.test(part(3)) ? 'SETUP Part 3 item 7 does not say when production needs a merge, or counts only deploys as using credits' : '',
      !/Create draft pull request/.test(line(part(3), /merge `main` into `production`/)) || !/Create draft pull request/.test(runStep(5)) ? 'SETUP\'s merge steps don\'t warn about the draft pull request' : '',
      /people's own steps \(deliver, dispute, approve a part\), work exactly as before/.test(part20) ? 'SETUP says approving a part works as before on new-price Orders (it is a payment step)' : '',
      !/plan 2/.test(line(part20, /`commission_cents` and `payout_cents`/)) ? 'SETUP\'s table says every payout line records the commission (only plan 2 lines do)' : '',
      !/the amounts charged are on/.test(line(part20, /order_price_breakdown\('/)) ? 'SETUP\'s breakdown note leads the owner to look for fee amounts the breakdown does not give' : '',
      // credits: Netlify pauses the whole team's projects when they run out (its help page), not only production deploys
      !/pauses every project/.test(line(part(3), /merge `main` into `production`/)) || /about 20 deploys a month|only when going live, by merging/.test(setup) ? 'SETUP says running out of credits only stops production deploys, or still counts 20 deploys a month / one merge at going live' : '',
      !/wait until it has finished/.test(line(part(3), /merge `main` into `production`/)) ? 'SETUP Part 3 item 7 does not say to wait for Netlify\'s check before merging' : '',
      !/`fee_cents`/.test(line(part20, /order_price_breakdown\('/)) ? 'SETUP\'s breakdown note does not say where the fee amounts are (the fund lines)' : '',
      !/follow each Order's own prices/.test(step(3)) || !/by each Order's own price plan/.test(line(spec, /Every other "no commission" text/)) ? 'SETUP step 3 or PRODUCT_SPEC lets the Order screen and contract texts switch for every Order (they follow each Order\'s prices)' : '',
      !/unless the client's bank asks/.test(step(1)) ? 'SETUP step 1 says today\'s code always keeps the card fee back (it refunds it when the bank asks)' : '',
      // the upload: every file of this update, by folder, and Claude confirms each one before the merge
      !['`professions/`', '`config.json`', '`seed.js`', '`professions_seed.sql`', '`schema_v56.sql`', '`undo_v56.sql`', '`index.html`', '`mock-supabase.js`', 'ask Claude to confirm'].every(w => upload.includes(w)) ? 'SETUP\'s upload steps do not list every file of this update by folder' : '',
      !/Claude has confirmed each one arrived exactly as tested/.test(runStep(5)) ? 'SETUP "Running v56" step 5 does not say who checks the files before the merge' : '',
      /looks exactly as today/.test(runStep(5)) || !/wait until it has finished/.test(runStep(5)) ? 'SETUP "Running v56" step 5 says the page looks exactly as today, or leaves out Netlify\'s check' : '',
      // the rules version: where to read it, and that a typo can no longer be fixed once Orders use plan 2
      !/rules page shows at its top/.test(step(5)) || !/typo/.test(step(3)) || !/`already`/.test(step(5)) ? 'SETUP steps 3 and 5 do not guard the rules version against a typo, or leave out the answer "already"' : '',
      !/Retry without cache with latest branch commit/.test((line(part(3), /\*\*After a pause ends\*\*/).match(/\*\*After a pause ends\*\*[^]*?\*\*When a value in Netlify was changed\*\*/) || [''])[0]) ? 'SETUP Part 3 item 7 rebuilds only production after a pause (branch deploys pause too)' : '',
      /needed only when the payment code changes,/.test(setup) ? 'SETUP Part 15 gives one reason for a production deploy where Part 3 gives three' : '',
      /the contract clauses and the rules\)/.test(spec) || !/new version, published before the switch/.test(spec) ? 'PRODUCT_SPEC says the rules switch with the prices (they are a new version published before the switch)' : '',
      !/steps 3 and 6 of "Turning the new prices on"/.test(spec) ? 'PRODUCT_SPEC points to Part 20 steps 3 and 6 without saying which list' : '',
      /\(deliver, dispute, approve a part\), work exactly as before/.test(v56) ? 'schema v56\'s header says approving a part works as before (it is a payment step)' : '',
      !/merged into `main`/.test(step(1)) || !/Published/.test(step(2)) ? 'SETUP steps 1-2 do not say the new code must be on main first, or how to see production runs it' : '',
      !/ask for it before you switch/.test(step(6)) ? 'SETUP step 6 does not say to order its page update in advance' : '',
      !/fills Supabase's logs/.test(undo) ? 'SETUP "Undoing v56" forgets the live page asking for prices that are gone' : '',
      /the hourly run adds it from Stripe's record/.test(part20) ? 'SETUP says today\'s hourly run adds every missing line (it adds only some kinds)' : '',
      /\("Cuvori fee €0"\)/.test(setup) ? 'SETUP quotes the Contracts page without its colon ("Cuvori fee: €0")' : '',
      !/today €1/.test(line(afterPart(part20, '**Decisions', '**Where it lives'), /€2/)) || !/today €1/.test(line(spec, /costs at least €2/)) ? 'SETUP or PRODUCT_SPEC lets the €2 minimum read as today\'s (today it is €1)' : '',
      !/Table Editor/.test(afterPart(part20, '**Reading:**', '- `select')) ? 'SETUP\'s reading queries do not say where to find an Order id' : '',
      !/no row/.test(part(21)) ? 'SETUP Part 21 does not say what an empty answer means' : '',
      !/with a normal change/.test(part20) || !/after refunds and chargebacks/.test(part20) || !/only the payment code for the new prices can book it/.test(part20) ? 'SETUP Part 20 overstates a rule (SQL editor, paid more than agreed, dashboard refunds)' : '',
      // PRODUCT_SPEC's technical plan, the zip and the prototype's demo systems, CLAUDE.md's price rule
      /→ Vercel \(web\)/.test(spec) ? 'PRODUCT_SPEC section 34 still says the site runs on Vercel' : '',
      !/do not unzip it into the repository/.test(claude) || !/do not unzip it into the repository/.test(readme) ? 'CLAUDE.md or README sends AI tools to a zip whose old notes would overwrite the new ones' : '',
      /^The prototype has \*\*no backend\*\*/m.test(claude) ? 'CLAUDE.md reads as if index.html\'s systems were demo' : '',
      !/as soon as v56 runs/.test(line(claude, /\*\*Prices \(final/)) || !/keep them for good/.test(line(claude, /\*\*Prices \(final/)) ? 'CLAUDE.md\'s price rule says everything waits for the switch, or forgets that older Orders keep today\'s prices' : '',
      !/`T_…` tables/.test(claude) ? 'CLAUDE.md names only one of the page\'s text tables' : '',
      !/Cuvori's own decision on a dispute still goes through/.test(line(claude, /\*\*Prices \(final/)) ? 'CLAUDE.md\'s v56 rule would stop Cuvori\'s own dispute payouts' : '',
      !/editorius/.test(runStep(5)) || !/skipped or canceled is fine/.test(runStep(5)) ? 'SETUP "Running v56" step 5 leaves out the Lithuanian texts that change, or what a skipped Netlify check means' : '',
      !/marked \*\*Demo \/ test\*\*/.test(step(4)) || !/Cmd\+C/.test(step(4)) ? 'SETUP step 4 says all test accounts are left out of the e-mail list (only those marked Demo / test are)' : '',
      /the hourly run adds it from Stripe's record/.test(v56) ? 'schema v56\'s header says today\'s hourly run adds every missing line' : '',
      /GitHub \(private\)|this repo, private/.test(spec + readme) ? 'PRODUCT_SPEC or README calls the repository private (GitHub shows it as public)' : '',
      !/Three rules start as soon as v56 runs/.test(line(claude, /\*\*Prices \(final/)) || !/never be set back to a proposal/.test(line(claude, /\*\*Prices \(final/)) || !/payment line/.test(line(claude, /\*\*Prices \(final/)) ? 'CLAUDE.md names one of the three rules that start with v56' : '',
      !/can be read by anyone/.test(upload) || !/not hidden/.test(upload) ? 'SETUP reads as if pricing-v2 were hidden (the repository is public)' : '',
      !/before the switch/.test(line(afterPart(part20, '**Decisions', '**Where it lives'), /€2/)) || !/before the switch/.test(line(spec, /costs at least €2/)) ? 'SETUP or PRODUCT_SPEC gives the €2 minimum no deadline (plan 2 is frozen once used)' : '',
      !/review_window_days/.test(part20.slice(0, part20.indexOf('**What the database'))) || !/not the 14 days/.test(line(part(19), /review_window_days/)) ? 'SETUP lets the reviews\' 14 days be mistaken for the 14 days before a payout' : '',
      !/"0%" badge/.test(line(spec, /Every other "no commission" text/)) || !/late-payment line/.test(line(spec, /Every other "no commission" text/)) ? 'PRODUCT_SPEC\'s list misses the "0%" badge or the late-payment history line' : '',
      !/\*\*Failed\*\*/.test(step(2)) || !/\*\*Failed\*\*/.test(line(part(3), /merge `main` into `production`/)) ? 'SETUP does not say what to do when a production deploy fails' : '',
      !/a few of the files that are at the top level/.test(upload) ? 'SETUP\'s first upload says all top-level files, the list says a few at a time' : '',
      !/View pull request/.test(runStep(5)) ? 'SETUP "Running v56" step 5 does not cover a pull request that is already open' : '',
      !/v56 NOT undone/.test(undo) ? 'SETUP "Undoing v56" does not say what to do when it is not undone' : '',
      !/can be older than the page/.test(line(part(6), /contracts-i18n/)) || !/can be older than the page/.test(line(part(8), /rules-i18n/)) ? 'SETUP Part 8 calls the rules working copies the source, though they can be older than the page' : '',
      // the next update is built from these notes: contract wording by price plan, no second 5%, a second switch-on, chargeback fees
      !/goes with each Order's price plan/.test(step(3)) || !/price plan/.test(line(part(6), /clauses_version/)) ? 'SETUP lets the new contract wording follow the day an Order was made, not its price plan' : '',
      !/keeps nothing again/.test(line(spec, /5% of every amount paid out/)) || !/keeps nothing again/.test(step(1)) ? 'PRODUCT_SPEC or SETUP step 1 would let a re-payment after a won chargeback keep 5% again' : '',
      !/new plan/.test(goBack) || !/new email/.test(goBack) ? 'SETUP "Going back" lets the new prices be switched on again without a new plan, rules and notice' : '',
      /the freelancer is charged commission on money they did not keep/.test(setup) || !/paid by nobody/.test(setup) ? 'SETUP frames the lost-chargeback decision wrongly' : '',
      !/applies only to Orders agreed from the switch date/.test(step(3)) ? 'SETUP step 3 does not say each new rule applies only to Orders agreed from the switch date' : '',
      !/dispute fee/.test(line(part20, /admin_pricing_report\('/)) ? 'SETUP\'s report note hides that Stripe\'s dispute fees are not in it' : '',
      !/README\.md/.test(step(6)) || !/own branch/.test(line(claude, /\*\*On "fix it":\*\*/)) ? 'SETUP step 6 leaves the notes\' "today" lines, or CLAUDE.md sends fixes to main while an update waits on its branch' : '',
      /admin_set_setting\('review_window_days'/.test(part(19)) ? 'SETUP Part 19 gives a command that answers "forbidden" in the SQL editor' : '',
      /do what it says, or ask/.test(runStep(4)) ? 'SETUP "Running v56" step 4 says to run older files (the live database should be at v55)' : '',
      !/by mistake/.test(upload) ? 'SETUP does not say what to do if the first upload lands on main' : '',
      !/Ready for review/.test(line(part(3), /merge `main` into `production`/)) || !/has conflicts/.test(line(part(3), /merge `main` into `production`/)) ? 'SETUP Part 3 item 7 misses a draft or conflicting pull request' : '',
      /check(ed)? by hand/.test(afterPart(part20, 'admin_pricing_check();`', '"to_decide"')) || /each Order listed is checked by hand/.test(v56) ? 'SETUP or schema v56 gives the owner a ledger check to do by hand' : '',
      !/paid through Cuvori and agreed from the switch on/.test(line(part(7), /processing cost on top of the Order price/)) ? 'SETUP Part 7 says 5% applies to every Order (directly paid ones pay none)' : '',
      !/a bigger one is listed as/.test(part20) ? 'SETUP\'s commission_without_money example is off' : '',
      !/under "For clients"/.test(spec) ? 'PRODUCT_SPEC rewords the homepage price block' : '',
      !/Credit balance/.test(part(3)) ? 'SETUP never says where Netlify shows the credits left' : '',
      !/does not call it/.test(step(1)) ? 'SETUP step 1 lets a re-payment go through pricing_next_commission (it would keep 5%)' : '',
      !/no money moves/.test(line(afterPart(part20, '**Decisions', '**Where it lives'), /chargeback lost after the payout/)) || !/rules and contract/.test(line(afterPart(part20, '**Decisions', '**Where it lives'), /chargeback lost after the payout/)) ? 'SETUP\'s lost-chargeback options leave out that booking back moves no money, or that a further pull-back needs the rules first' : '',
      !/today too/.test(line(part20, /admin_pricing_report\('/)) || !/dashboard\.stripe\.com\/disputes/.test(line(part20, /admin_pricing_report\('/)) ? 'SETUP says dispute fees are new under the new prices, or gives an unsure dashboard path' : '',
      !/has conflicts/.test(runStep(5)) ? 'SETUP "Running v56" step 5 misses an open pull request with conflicts' : '',
      !/urgent fix/.test(line(claude, /\*\*On "fix it":\*\*/)) ? 'CLAUDE.md does not say where an urgent live fix goes while an update waits' : '',
      !/base: main/.test(upload) ? 'SETUP\'s "by mistake" check would stop the owner at the pull-request page (it always shows base: main)' : '',
      /pays no commission\) \(/.test(setup) ? 'SETUP Part 7 has two brackets in a row' : '',
      // production kept back on purpose; the check after a pause; Part 19 and undo; small facts
      !/kept on its 13 October code for now/.test(line(part(3), /merge `main` into `production`/)) ? 'SETUP Part 3 does not record that production is kept back on purpose (it would send you to merge)' : '',
      /answers with the same fields as the branch address/.test(setup) ? 'SETUP\'s check after a pause compares production with main (it can never pass while production is kept back)' : '',
      !/returning key, value/.test(part(19)) || !/Orders that have no review yet/.test(part(19)) ? 'SETUP Part 19\'s command shows no proof, or hides that a shorter window applies at once' : '',
      !/switch history/.test(undo) ? 'SETUP "Undoing v56" does not say it deletes the switch history' : '',
      /only once you have approved it/.test(part20) ? 'SETUP says "once you have approved it" without saying what' : '',
      !/empty \(NULL\)/.test(afterPart(part20, '**Reading:**', '- `select')) ? 'SETUP does not say what an empty answer to a reading query means' : '',
      // the next update: what step 1 must spell out
      !/never counts the 5% as still held/.test(step(1)) ? 'SETUP step 1 does not say how the counters work with 95% transfers' : '',
      !/at most what the freelancer received from that payment/.test(step(1)) ? 'SETUP step 1 does not cap a chargeback pull-back at what the freelancer received' : '',
      !/`chargeback_won <dispute id>`/.test(step(1)) || !/finds both forms/.test(step(1)) ? 'SETUP step 1 does not say how re-payment lines are written and found' : '',
      !/Part 5, item 10 is rewritten/.test(step(1)) ? 'SETUP step 1 does not say how payments are paused under the new prices' : '',
      !/v56 does not store it yet/.test(step(3)) ? 'SETUP step 3 hides that the contract version needs a database step' : '',
      // the owner's decision of 30 October: in a divided dispute decision the 5% comes out of the freelancer's share
      /divided dispute decision under the new prices/.test(afterPart(part20, '**Decisions', '**Where it lives')) || !/your decision of 30 October/.test(step(1)) ? 'SETUP still asks how a divided dispute decision is counted, or step 1 does not carry the decision' : '',
      !/never out of the client's refund/.test(spec) || !/never out of the client's refund/.test(line(claude, /\*\*Prices \(final/)) ? 'PRODUCT_SPEC or CLAUDE.md leaves out who pays the 5% in a divided dispute decision' : '',
      !/up to a cent for each/.test(part20) ? 'SETUP says rounding leaves at most one cent' : '',
      !/cost no credits to build/.test(setup) ? 'SETUP says branch deploys cost nothing at all (their function calls use credits)' : '',
      !/on an Order paid through Cuvori, a delivery/.test(part20) ? 'SETUP says every plan 2 delivery needs a link (only Orders paid through Cuvori)' : '',
      /accepted the new rules on the page, not that they read them/.test(part20) ? 'SETUP says the rules check proves the page sent the acceptance' : '',
      !/min_project_cents/.test(line(afterPart(part20, '**Decisions', '**Where it lives'), /€2/)) ? 'SETUP gives no command to change the undecided €2 minimum' : '',
      // older lines that would mislead at go-live
      !/old copies the page does not load/.test(line(part(13), /orders-ui\.js/)) ? 'SETUP Part 13 points to orders-ui.js / orders-i18n.js as the Order screens (the page does not load them)' : '',
      /the production address later/.test(setup) ? 'SETUP Part 15 moves the Stripe webhook to the production address (Stripe uses the branch address)' : '',
      !/does not add a missing payment line from Stripe's record/.test(line(part(3), /merge `main` into `production`/)) || !/not while production is kept back/.test(line(part(5), /go by themselves/)) ? 'SETUP names only the late refund among what the kept-back hourly job does not do' : '',
      !/second side of an Order where only one side has reviewed/.test(part(19)) ? 'SETUP Part 19 understates who a changed review window affects' : '',
      !/share of what is still held/.test(step(1)) ? 'SETUP\'s divided-dispute question works from the price (the share is of what is still held)' : '',
      !/the database demands both forms/.test(step(1)) || !/a pull-back whose line doesn't read `chargeback <dispute id>`/.test(ledgerRule) ? 'SETUP does not say the database demands the pull-back note too (it does since the third full check)' : '',
      /functionsUrl: "https:\/\/<your-site>\.netlify\.app"/.test(setup) ? 'SETUP gives the production address for functionsUrl (the page uses main--cuvori.netlify.app)' : '',
      /among them page code \(`orders-ui\.js`/.test(setup) ? 'SETUP Part 6 calls orders-ui.js page code' : '',
      !/the step 6 page update then uses it too/.test(line(afterPart(part20, '**Decisions', '**Where it lives'), /€2/)) ? 'SETUP\'s €2 command forgets the page update of step 6' : '',
      // the full check of 30 October: a mistaken switch-on, card holds, the ledger check's new item, the lock
      /That is safe, but those Orders cannot be paid until the new code is live/.test(part20) || !/Cancel them and ask both people to propose again/.test(mistaken) ? 'SETUP calls a switch-on before the new payment code safe (its Orders get stuck)' : '',
      // the full check of 30 October, second round: what a mistaken switch-on leaves behind, and the steps around it
      !/made, changed or accepted by one side while the switch was on/.test(mistaken) || !/returns to today's prices by itself/.test(mistaken) ? 'SETUP\'s mistaken switch-on covers only new Orders (older proposals accepted or changed meanwhile get the new prices too)' : '',
      !/while the first query lists any Order, plan 2's €2 minimum and its rules version can't be changed/.test(mistaken) || !/stays on it for good/.test(mistaken) ? 'SETUP\'s mistaken switch-on does not say plan 2 is then fixed (its €2 minimum and rules version)' : '',
      !/two refunds in today's code take a key that names the payment instead/.test(line(part20, /Payment code that does not know plan 2/)) ? 'SETUP says today\'s code always takes an Order-named key before it moves money (two refunds do not)' : '',
      !/a pull-back `trr_…`/.test(ledgerRule) || !/`pyr_…`/.test(ledgerRule) ? 'SETUP\'s list of refused ledger lines leaves out a line naming another kind of Stripe object' : '',
      !/written any ledger line/.test(undo) ? 'SETUP\'s undo does not say it refuses once the new payment code has written a line' : '',
      // the third full check of 30 October
      !/Until then their Order screen shows 14 days/.test(mistaken) || !/the chat gets the usual cancelled card/.test(mistaken) || !/v56 can no longer be undone/.test(mistaken) || !/keeps seeing them until the page next reaches the database/.test(mistaken) ? 'SETUP\'s mistaken switch-on misses what stays on screen, the chat card, or that v56 can no longer be undone' : '',
      /at once if Postgres finds a deadlock/.test(v56.replace(/\n\s*--\s*/g, ' ')) || !/rarely one step fails at that moment/.test(runStep(3)) ? 'v56 or SETUP says a deadlock stops v56 at once (Postgres takes about a second), or leaves out the click that can fail' : '',
      !/when someone comes back to the tab/.test(runStep(1)) ? 'SETUP says the page asks for the prices only on every visit (also on coming back to the tab and opening the form)' : '',
      !/a refund that fails at Stripe after its line was written/.test(step(1)) || !/whose pull-back failed/.test(step(1)) ? 'SETUP step 1 misses the failed refund or the failed pull-back the new payment code must record' : '',
      // the seventh full check of 30 October
      /or switch back\./.test(mistaken) || !/[Ss]witching back does not help the Orders already agreed/.test(mistaken) || !/the same day/.test(mistaken) ? 'SETUP says switching back helps when step 1 is live without step 2 (only production getting the new code helps the Orders already agreed)' : '',
      /v56 gives way: it stops/.test(runStep(3)) || !/usually just waits a moment and goes through/.test(runStep(3)) ? 'SETUP says v56 gives way to a payment (usually the payment just waits a moment)' : '',
      /the database refuses its copy/.test(part20) || !/writes no ledger line for it/.test(part20) ? 'SETUP says the database refuses the copy of a pull-back made by hand in Stripe (today\'s code writes none)' : '',
      !/when it opens and when you send it/.test(runStep(5)) ? 'SETUP says only opening the new-Order form may wait for the prices (Send waits too)' : '',
      // the sixth full check of 30 October
      !/card cost not covered/.test(step(1)) || !/keeps each chargeback's amount and result/.test(step(1)) || !/pays what was pulled back again as a re-payment/.test(step(1)) ? 'SETUP step 1 misses the admin panel\'s card-cost note, each chargeback\'s own record, or re-paying what was pulled back (no second 5%)' : '',
      !/If step 1 of "Turning the new prices on" is live but step 2 of "Turning the new prices on" is not/.test(mistaken) || !/7 days in its payment notes and 14 in its contract text/.test(mistaken) || !/Every Order that carries the new prices/.test(mistaken) ? 'SETUP\'s mistaken switch-on misses step 1 live without step 2, the old page\'s 7 and 14 days, or labels the query wrongly' : '',
      !/close on a tap/.test(runStep(5)) ? 'SETUP step 5 of "Running v56" leaves out that messages now close on a tap (visible with the switch off)' : '',
      !/only the Order's latest chargeback is checked/.test(part20) || !/Don't pull money back from a freelancer by hand in the Stripe dashboard/.test(part20) || !/A refund that fails at Stripe later can't be recorded yet/.test(part20) || !/stay listed/.test(part20) ? 'SETUP does not say what the ledger check can\'t see or record' : '',
      /this file is the one that gives up, not the other side/.test(v56.replace(/\n\s*--\s*/g, ' ')) ? 'v56 says it always gives way in a deadlock (not guaranteed)' : '',
      ...[...new Set([...v56.matchAll(/'item', '([a-z_]+)'/g)].map(m => m[1]))].filter(k => !part20.includes('`' + k + '`') && !part20.includes('"' + k + '"')).map(k => `SETUP Part 20 does not explain the ledger check's item to decide ${k}`),
      // the fifth full check of 30 October
      /still_held_cents/.test(part20) || /can complete with that money still at Cuvori/.test(setup) ? 'SETUP still has the query for money held on finished Orders (it lists every Order with a chargeback open) or the claim behind it (not true of today\'s code)' : '',
      /hourly run adds most missing lines/.test(setup + v56.replace(/\n\s*--\s*/g, ' ')) ? 'SETUP or v56 says the hourly run adds missing lines (the live hourly job, the 13 October code, does not)' : '',
      !/Orders paid directly that were agreed in those minutes keep plan 2 for good too/.test(mistaken) || !/o_ev_prices_changed/.test(mistaken) ? 'SETUP\'s mistaken switch-on misses the direct Orders that keep plan 2, or the history line the old page shows as a code' : '',
      !/saves the "chargeback won" event/.test(step(1)) || !/an Order with a top-up and one with several payouts/.test(step(1)) ? 'SETUP step 1 misses saving the won-chargeback event, or testing Orders with a top-up and several payouts' : '',
      ...[...new Set([...v56.matchAll(/'problem', '([a-z_]+)'/g)].map(m => m[1]))].filter(k => !part20.includes('`' + k + '`')).map(k => `SETUP Part 20 does not explain the ledger check's problem ${k} (the database lists it)`),
      // the fourth full check of 30 October
      /still shows the new prices \(5%, 14 days\)/.test(mistaken) || !/the 5% appears on the Order screen only with step 1/.test(mistaken) || /The Order then shows the prices in force/.test(part20) ? 'SETUP says the Order screen shows an Order\'s 5% (it shows only its days until step 1)' : '',
      !/in the freelancer's name/.test(mistaken) ? 'SETUP does not say the cancel line\'s chat card shows as sent by the freelancer' : '',
      !/a payment step's database write/.test(v56.replace(/\n\s*--\s*/g, ' ')) || !/Don't make a refund in the Stripe dashboard while it runs/.test(runStep(3)) ? 'v56 or SETUP leaves out that a deadlock can stop a payment step\'s write (and the dashboard refund it can lose)' : '',
      !/pays again per dispute/.test(step(1)) || !/before it works out the next 5%/.test(step(1)) ? 'SETUP step 1 misses re-paying per dispute, or adding missing payout lines before the next 5%' : '',
      !/not marked succeeded/.test(v56.slice(0, v56.indexOf('-- ---------- 0.'))) || !/not from Stripe/.test(v56.slice(0, v56.indexOf('-- ---------- 0.'))) ? 'v56\'s header leaves refused lines out of its list' : '',
      !/Nothing to release right now/.test(step(1)) || /handles Accept's new answer/.test(step(1)) ? 'SETUP step 1 leaves the approval that meets a dispute to a general error, or still asks for Accept\'s answers the page already shows' : '',
      /plan 2 Orders finish under plan 2\./.test(part20) ? 'SETUP says plan 2 Orders finish under plan 2 after going back (not without the new code)' : '',
      !/x-cuvori-pricing: 3/.test(goBack) ? 'SETUP does not say a second switch-on needs the payment code to name the new plan' : '',
      /That also stops it from letting go of a second card hold/.test(part20) || !/can still let go of a card hold/.test(part20) ? 'SETUP says old code can never let go of a card hold on a new-price Order' : '',
      !/money_left_at_cuvori/.test(part20) ? 'SETUP\'s list of the ledger check\'s problems misses money_left_at_cuvori' : '',
      !/lock timeout/.test(runStep(4)) || !/deadlock detected/.test(runStep(4)) || !/trr_/.test(step(1)) ? 'SETUP "Running v56" step 4 does not say what a lock timeout means' : '',
      /from its 5%/.test(setup) ? 'SETUP says Cuvori pays the fees "from its 5%" (on small projects they cost more)' : '',
      !/card fee too/.test(line(part(13), /arrives after its Order/)) ? 'SETUP Part 13 leaves out the full refund when the client\'s bank asks' : '',
      // the eighth full check of 30 October: step 1 live without step 2 also closes payment pages; a lost chargeback's line in full
      !/payment page/.test(line(mistaken, /If step 1 of "Turning the new prices on" is live but step 2/)) || !/top-up/.test(line(mistaken, /If step 1 of "Turning the new prices on" is live but step 2/)) ? 'SETUP\'s step 1 live without step 2 leaves out that the hourly job closes the client\'s open payment page (a top-up) on overdue new-price Orders' : '',
      !/also when the pull-back worked/.test(step(1)) ? 'SETUP step 1 asks for the lost chargeback\'s full line only when the pull-back failed (today\'s code writes 95% also when it worked)' : '',
      // the eleventh full check of 31 October
      !/never publish two versions in the same month/.test(part(8)) || !/takes the month after plan 2's rules version/.test(part(8)) ? 'SETUP Part 8 leaves a rules change before the switch, or a second one in a month, without a version that works' : '',
      !/it clears the Order's whole note, the other notes on it included/.test(part(5)) ? 'SETUP Part 5 says the notes stay until handled while production\'s 13 October job still clears them' : '',
      !/up to 10 seconds for the payment check/.test(runStep(5)) || !/one paid directly is sent/.test(runStep(5)) ? 'SETUP "Running v56" step 5 leaves out the payment check\'s wait, or that an Order paid directly is sent' : '',
      !/`STRIPE_WEBHOOK_SECRET` or the Supabase key/.test(line(part20, /Direct payments under the new prices/)) || !/stays direct when it is changed or accepted/.test(line(part20, /Direct payments under the new prices/)) ? 'SETUP\'s direct-payment risk names the wrong settings, or leaves out old direct proposals' : '',
      !/If the rules were never changed back/.test(goBack) ? 'SETUP "Going back" always asks for a new plan, also after a switch-on by mistake' : '',
      !/is on any other line than its payment's/.test(part20) || !/a part refunded leaves the rest listed/.test(part20) ? 'SETUP\'s list of refused lines leaves out the card-fee refund rule, or says a part refund clears the listing' : '',
      !/replaces 24 newer files/.test(setup) ? 'SETUP Part 6 gives the wrong number of files the test kit would replace' : '',
      !/accepted below €2/.test(part20) || !/Plan 2 Orders paid through Cuvori can't be made, given a lower price/.test(v56) ? 'SETUP or v56 says the €2 holds after any change (a change keeping the price keeps it until Accept)' : '',
      !/never together with step 5's switch/.test(step(3)) ? 'SETUP step 3 does not say to run the plan change on its own' : '',
      !/adds only the lines of the steps it retries/.test(v56) || !/the lines of those; production's 13 October hourly job adds only the last of these/.test(step(1)) ? 'SETUP or v56 says the hourly job adds no lines (its retries do)' : '',
      // the tenth full check of 31 October
      /Today the page offers both ways/.test(part20) || !/The page offers no choice between the two ways/.test(part20) ? 'SETUP\'s direct-payment question says the page lets people choose a direct payment (it doesn\'t: protected payments on or off decides)' : '',
      !/the rules for the new prices take the version plan 2 names/.test(part(8)) ? 'SETUP Part 8 forbids a rules version named after a later month, also the one plan 2 names (Part 20 does that)' : '',
      !/card fee charged by mistake/.test(line(part20, /A plan 2 line can no longer be changed/)) || !/stops being listed/.test(line(part20, /`client_charged_card_fee`/)) ? 'SETUP says a plan 2 line can never take a card-fee refund, or not that the check then stops listing it' : '',
      /today's code adds only payment, payout, part and re-payment lines/.test(step(1)) || /does not retry a late-payment refund that failed, adds missing payment lines/.test(part(3)) ? 'SETUP overstates what today\'s hourly job adds from Stripe\'s record' : '',
      /an agreed Order never becomes a proposal again/.test(v56.slice(0, v56.indexOf('-- ---------- 0.'))) || /those Orders are agreements/.test(read('supabase/undo_v56.sql')) ? 'v56\'s or undo\'s header overstates which Orders can\'t become proposals again, or which block undo' : '',
      !/o_ev_prices_changed/.test(undo) || !/"New Order — /.test(mistaken) ? 'SETUP leaves out a "prices changed" history line or chat card that an older page shows wrongly' : '',
      /turning the new prices on later needs a new plan with its own rules version, as under Going back/.test(part20) ? 'SETUP says a mistaken switch-on always needs a new plan later (only a changed €2 or rules version does)' : '',
      !/deadlock detected/.test(undo) ? 'SETUP "Undoing v56" names only the lock timeout as safe to run again' : '',
      /if they can't be read then, it sends nothing and says so/.test(runStep(5)) ? 'SETUP says the form sends nothing when the prices can\'t be read at Send (it uses an answer from the last minute)' : '',
      /what Stripe charged Cuvori is for the admin only/.test(v56) ? 'schema v56 says Stripe\'s fee is for the admin only (both people can read their payment lines)' : '',
      // the ninth full check of 31 October
      !/refund total \(`refunded_cents`\) takes only what Cuvori still held/.test(step(1)) ? 'SETUP step 1 asks for the full chargeback line without saying the Order\'s refund total takes only what was held (a full one is refused)' : '',
      !/needs a small database step for it too/.test(step(1)) ? 'SETUP step 1 asks the payment code to record a failed refund that v56 has no kind of line for' : '',
      !/of every kind, from Stripe's record/.test(step(1)) ? 'SETUP step 1 never asks the hourly run to add every kind of missing line (line_missing says it does)' : '',
      !/month you publish it in/.test(part(8)) ? 'SETUP Part 8 does not say how to name a new rules version (a future month would stop people agreeing Orders)' : '',
      /including its note/.test(part20) ? 'SETUP says visitors can read your note on the switch (they no longer can)' : '',
      !/order_create_at_prices/.test(part20) ? 'SETUP Part 20 does not say a proposal is refused when the switch moved after its form read the prices' : '',
      !/shows such a card as "New Order — €…"/.test(undo) ? 'SETUP "Undoing v56" leaves out the "prices changed" chat cards that stay' : '',
      !/while the payment code for the new prices is not live yet, can't be paid/.test(mistaken) ? 'SETUP\'s mistaken switch-on says agreed Orders can\'t be paid also once step 1 is live' : '',
      /lists each Order with a lost chargeback after a payout under/.test(part20) ? 'SETUP\'s Decisions say every lost chargeback after a payout is under to_decide (only pulled-back ones are)' : '',
      // PRODUCT_SPEC: what switches by itself, and the new-price versions shown only from the switch
      !/the headline, the line under it, step 4/.test(line(spec, /switch by themselves/)) || /is rewritten before the switch/.test(spec) ? 'PRODUCT_SPEC\'s list of texts that switch by themselves, or its "rewritten before the switch", is wrong' : '',
      !/price card/.test(line(spec, /Every other "no commission" text/)) || !/price hint/.test(line(spec, /Every other "no commission" text/)) || !/contract clauses/.test(line(spec, /Every other "no commission" text/)) ? 'PRODUCT_SPEC\'s list leaves out the profile price card, the price hint or the other contract clauses' : '',
    ].filter(Boolean);
    // the privacy notice names the prices the browser now keeps (cuvoriPrices), in all 7 languages
    {
      const pv = [...page.matchAll(/pv_s6:"([^"]*)"/g)].map(m => m[1]);
      const words = ['prices', 'Preise', 'цены', 'kainas', 'precios', 'ceny', 'ціни'];
      const missing = words.filter(w => !pv.some(t => t.includes(w)));
      if (/cuvoriPrices/.test(page) && (pv.length !== 7 || missing.length)) steps.push(`the privacy notice does not say the browser keeps the prices it last showed (${missing.join(', ') || pv.length + ' languages'})`);
    }
    ok(!steps.length, `the notes never lead the owner into a wrong step (the notes checked against each other and against the code's words; the database and page checks test the code itself)${steps.length ? ' — ' + steps.join('; ') : ''}`);
  }
  // Lithuanian: "editorius", never "montuotojas" — the page, the built-in professions and the professions seed
  {
    const files = ['index.html', 'professions/config.json', 'professions/seed.js', 'supabase/professions_seed.sql'];
    const found = files.map(f => [f, (fs.readFileSync(here(f), 'utf8').match(/montuotoj/gi) || []).length]).filter(([, n]) => n);
    ok(!found.length, `no "montuotojas" anywhere the site shows text${found.length ? ' — ' + found.map(([f, n]) => `${f}: ${n}`).join(', ') : ''}`);
  }
  const b = await chromium.launch();
  try {
    // 1. before v56 (no pricing_now in the database) and with the switch off: the homepage is today's, in every language
    for (const [label, prices] of [['before v56', null], ['switch off', P1]]) {
      const bad = [];
      for (const lang of LANGS) {
        const { ctx, p, errs } = await open(b, prices, lang);
        const h = await home(p);
        if (h.shown) bad.push(lang + ': the new pricing block shows');
        if (!OLD[lang].test(h.hero + h.step4 + h.footer)) bad.push(lang + ': today\'s homepage text changed: ' + h.hero);
        { const want = homeTexts(lang, false); for (const k of ['hero', 'step4', 'footer']) if (h[k] !== want[k]) bad.push(`${lang}: the ${k} shows "${h[k]}", not today's text "${want[k]}"`); }
        if (errs.length) bad.push(lang + ': page error ' + errs[0]);
        await ctx.close();
      }
      ok(!bad.length, `${label}: the homepage stays as today in all 7 languages, no pricing block${bad.length ? ' — ' + bad.join('; ') : ''}`);
    }
    // 2. the new prices in force: the owner's wording, exactly, in English
    {
      const { ctx, p, errs } = await open(b, P2, 'en');
      const h = await home(p);
      const want = ['Pricing', 'For clients', 'Free job posts. No platform fees.', 'For freelancers', '5% commission. We cover the card processing fees.', 'Free to join and browse. No subscriptions. No hidden platform fees.'];
      const missing = want.filter(w => !h.block.includes(w));
      ok(h.shown && !missing.length && !errs.length, `new prices, English: the pricing block shows the agreed wording${missing.length ? ' — missing: ' + missing.join(' / ') : ''}${errs.length ? ' — page error ' + errs[0] : ''}`);
      ok(!OLD.en.test(h.hero + h.step4 + h.footer) && /Free job posts/.test(h.hero) && /No hidden platform fees/.test(h.footer),
        `new prices, English: no "commission-free" claim left on the homepage -> ${h.hero} / ${h.step4} / ${h.footer}`);
      // the rules are a text people accepted under its version: the switch does not change them. They keep saying 7 days
      // until the new rules (14 days, and 7 for Orders agreed before the switch) are published under a new version
      await p.goto(url + '#rules'); await p.waitForTimeout(500);
      // the rules page itself (never the whole page: another text on it could say "7 days" too)
      const rules = await p.evaluate(() => { const r = document.querySelector('#page-rules'); return r && r.offsetHeight > 0 ? r.innerText : ''; });
      ok(/automatically 7 days after delivery/.test(rules) && !/automatically 14 days/.test(rules), `new prices: the rules (same version) still say what was accepted -> ${(rules.match(/automatically \d+ days after delivery/) || ['?'])[0]} (must be 7 days, never changed by the switch alone)`);
      await ctx.close();
      const { ctx: c1, p: p1 } = await open(b, P1, 'en');
      await p1.goto(url + '#rules'); await p1.waitForTimeout(500);
      const rules1 = await p1.evaluate(() => { const r = document.querySelector('#page-rules'); return r && r.offsetHeight > 0 ? r.innerText : ''; });
      ok(/automatically 7 days after delivery/.test(rules1), 'switch off: the rules still say 7 days');
      await c1.close();
    }
    // 3. the new prices in every language: the block, the 5%, no "{pct}" left, no old claim, Lithuanian words right
    {
      const bad = [];
      for (const lang of LANGS) {
        const { ctx, p, errs } = await open(b, P2, lang);
        const h = await home(p);
        if (!h.shown) bad.push(lang + ': no pricing block');
        if (!/5\s?%/.test(h.block)) bad.push(lang + ': the 5% is missing: ' + h.block.slice(0, 120));
        if (/\{|\}|__p2|hp_/.test(h.block + h.hero + h.step4 + h.footer)) bad.push(lang + ': a placeholder or key shows');
        if (OLD[lang].test(h.hero + h.step4 + h.footer)) bad.push(lang + ': an old "no commission" claim is left: ' + h.hero + ' / ' + h.step4 + ' / ' + h.footer);
        if (lang === 'lt' && /montuotoj/i.test(h.block + h.hero)) bad.push('lt: "montuotojas" used');
        // exactly the new-price texts of that language (not only "no commission word": an old claim worded otherwise is caught)
        { const want = homeTexts(lang, true); for (const k of ['hero', 'step4', 'footer']) if (h[k] !== want[k]) bad.push(`${lang}: the ${k} shows "${h[k]}", not the new-price text "${want[k]}"`); }
        // ... and each new-price text really is a new one (a copy of today's claim, or today's text set to the new one, would pass the above)
        for (const key of ['heroTitle', 'heroSub', 'step4', 'footer']) { const today = textOf('T', lang, key), next = textOf('T_PRICES', lang, key + '__p2');
          if (!today || !next || today === next) bad.push(`${lang}: ${key} has ${!next ? 'no new-price text' : 'the same text today and under the new prices: "' + next + '"'}`); }
        if (errs.length) bad.push(lang + ': page error ' + errs[0]);
        await ctx.close();
      }
      ok(!bad.length, `new prices: the pricing block in all 7 languages${bad.length ? ' — ' + bad.join('; ') : ''}`);
    }
    // 4. on a phone the block fits the screen
    {
      const { ctx, p } = await open(b, P2, 'de', 390);
      const h = await home(p);
      ok(h.shown && h.wide <= 0, `new prices on a 390px phone: the pricing block shows and the page does not scroll sideways (${h.wide}px too wide)`);
      await ctx.close();
    }
    // 5. the Order screen: a funded plan 2 Order says 14 days and needs a link; a plan 1 Order says 7 and does not
    for (const plan of [2, 1]) {
      const { ctx, p, errs } = await open(b, P2, 'en');
      // a freelancer signs up; an Order already paid in waits for the delivery
      await p.evaluate(async () => {
        const sb = window.__sb; await sb.auth.signUp({ email: 'fl@test.com', password: 'password123', options: { data: { first_name: 'Tom' } } });
        await sb.auth.signInWithPassword({ email: 'fl@test.com', password: 'password123' });
      });
      await p.waitForTimeout(600);
      await p.evaluate((pl) => {
        const db = window.__mockdb; const me = db.profiles.find(x => x.email === 'fl@test.com'); me.role = 'editor'; me.rules_version = '2026-11';
        const cl = '99999999-9999-4999-8999-999999999999';
        db.profiles.push({ id: cl, email: 'cl@test.com', first_name: 'Lina', role: 'client', is_admin: false, banned: false, created_at: new Date().toISOString() });
        const conv = { id: '88888888-8888-4888-8888-888888888888', user_a: [me.id, cl].sort()[0], user_b: [me.id, cl].sort()[1], created_at: new Date().toISOString() };
        db.conversations.push(conv);
        db.contracts.push({ id: '77777777-7777-4777-8777-777777777777', conversation_id: conv.id, editor: me.id, client: cl, proposed_by: cl, title: 'Product film', description: 'Edit a film',
          price: 100, currency: 'EUR', pricing: 'project', amount_cents: 10000, funded_cents: 10000, released_cents: 0, refunded_cents: 0, payment_mode: 'escrow', status: 'funded',
          revisions: 1, changes_used: 0, has_milestones: false, terms_version: 1, client_accepted_version: 1, freelancer_accepted_version: 1, accepted_at: new Date().toISOString(),
          pricing_version: pl, commission_bps: pl >= 2 ? 500 : 0, commission_cents: 0, auto_days: pl >= 2 ? 14 : 7, created_at: new Date().toISOString() });
      }, plan);
      await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); });
      await p.goto(url + '#contracts'); await p.waitForTimeout(900);
      await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });   // the welcome / rules pop-up of a new account
      await p.locator('.c-row').first().click(); await p.waitForTimeout(800);
      const deliver = p.locator('[data-caction="deliver"]');
      const hasDeliver = await deliver.count() === 1;
      if (hasDeliver) { await deliver.click(); await p.waitForTimeout(400); }
      const desc = hasDeliver ? await p.locator('#modalRoot').innerText() : '';
      if (hasDeliver) { await p.click('#onGo'); await p.waitForTimeout(500); }
      const toast = await p.evaluate(() => [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | '));
      const status = await p.evaluate(() => window.__mockdb.contracts[0].status);
      if (plan === 2) ok(hasDeliver && /14 days/.test(desc) && /Add a link to the work first/.test(toast) && status === 'funded' && !errs.length,
        `plan 2 Order: the deliver dialog says ${(desc.match(/\d+ days/) || ['?'])[0]}; sending it without a link -> ${toast.slice(-60) || 'no message'}, the Order stays ${status} (must be 14 days, "Add a link to the work first.", funded)`);
      else ok(hasDeliver && /7 days/.test(desc) && status === 'delivered' && !errs.length,
        `plan 1 Order: the deliver dialog says ${(desc.match(/\d+ days/) || ['?'])[0]}; sending it without a link -> the Order is ${status} (must be 7 days and delivered, as today)${errs.length ? ' — page error ' + errs[0] : ''}`);
      if (plan === 2 && hasDeliver) {
        await p.fill('#onUrl', 'https://drive.google.com/file/d/1'); await p.click('#onGo'); await p.waitForTimeout(500);
        const st = await p.evaluate(() => window.__mockdb.contracts[0].status);
        ok(st === 'delivered', `plan 2 Order: with a link the delivery goes through -> ${st}`);
      }
      await ctx.close();
    }
    // 6. a visitor who has been here before sees the new prices at once, also while the lookup is still on its way;
    //    and if the switch was turned back, the page follows the database
    {
      const { ctx, p, errs: e1 } = await open(b, P1, 'en', 390, null, { cached: P2, delay: 6000, wait: 400 });   // the database's (late) answer is today's prices: what shows first can only come from the browser
      const early = await home(p);
      await ctx.close();
      const { ctx: c2, p: p2, errs: e2 } = await open(b, P1, 'en', 390, null, { cached: P2, wait: 1200 });
      const back = await home(p2);
      await c2.close();
      // v56 taken out again (undo): the database has no prices at all, and the remembered new prices are forgotten
      const { ctx: c3, p: p3, errs: e3 } = await open(b, null, 'en', 390, null, { cached: P2, wait: 1200 });
      const gone = await home(p3); const kept = await p3.evaluate(() => { try { return localStorage.getItem('cuvoriPrices'); } catch (e) { return 'n/a'; } });
      await c3.close();
      const errs = [...e1, ...e2, ...e3];
      ok(/^Find your freelancer\. \|/.test(early.hero) && early.shown && /Commission-Free/.test(back.hero) && !back.shown && /Commission-Free/.test(gone.hero) && !gone.shown && kept === null && !errs.length,
        `a returning visitor, new prices, lookup still loading -> "${early.hero}", block ${early.shown ? 'shown' : 'hidden'}; the switch turned back since the last visit -> "${back.hero}", block ${back.shown ? 'shown' : 'hidden'}; the database has no prices any more -> "${gone.hero}", remembered prices ${kept === null ? 'forgotten' : 'still kept'}${errs.length ? ' — page error ' + errs[0] : ''}`);
    }
    // 7. the Order screen of an agreed plan 2 Order: the payment box says 14 days, and a change can't take it below €2
    {
      const { ctx, p, errs } = await open(b, P2, 'en');
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl@test.com', password: 'password123' }); });
      await p.waitForTimeout(600);
      await p.evaluate(() => { const db = window.__mockdb; const me = db.profiles.find(x => x.email === 'cl@test.com'); me.rules_version = '2026-11'; const fl = '99999999-9999-4999-8999-999999999999';
        db.profiles.push({ id: fl, email: 'fl@test.com', first_name: 'Tom', role: 'editor', is_admin: false, banned: false, created_at: new Date().toISOString() });
        const conv = { id: '88888888-8888-4888-8888-888888888888', user_a: [me.id, fl].sort()[0], user_b: [me.id, fl].sort()[1], created_at: new Date().toISOString() }; db.conversations.push(conv);
        db.contracts.push({ id: '77777777-7777-4777-8777-777777777777', conversation_id: conv.id, editor: fl, client: me.id, proposed_by: fl, title: 'Product film', description: 'Edit a film', price: 5, currency: 'EUR', pricing: 'project',
          amount_cents: 500, funded_cents: 0, released_cents: 0, refunded_cents: 0, payment_mode: 'escrow', status: 'accepted', revisions: 1, changes_used: 0, has_milestones: false, terms_version: 1, client_accepted_version: 1,
          freelancer_accepted_version: 1, accepted_at: new Date().toISOString(), pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14, created_at: new Date().toISOString() }); });
      await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); });
      await p.goto(url + '#contracts'); await p.waitForTimeout(900); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.locator('.c-row').first().click(); await p.waitForTimeout(1000);
      const screen = await p.evaluate(() => document.querySelector('#modalRoot').innerText);
      const days = (screen.match(/or (\d+) days after a delivery/) || [])[1] || '?';
      let toast = '', toast2 = '', amended = '?';
      if (await p.locator('[data-caction="amend"]').count()) {
        await p.click('[data-caction="amend"]'); await p.waitForTimeout(400);
        await p.fill('#amNote', 'less work'); await p.fill('#amDelta', '-3.5'); await p.click('#amGo'); await p.waitForTimeout(600);
        toast = await p.evaluate(() => [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | '));
        // a change to €0.50: one message, the plan's €2 (not first "at least €1", then "at least €2")
        await p.evaluate(() => document.querySelectorAll('.toast').forEach(x => x.remove()));
        await p.fill('#amDelta', '-4.5'); await p.click('#amGo'); await p.waitForTimeout(600);
        toast2 = await p.evaluate(() => [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | '));
        amended = await p.evaluate(() => String((window.__mockdb.order_amendments || []).length));
      }
      ok(days === '14' && /at least €2/.test(toast) && /at least €2/.test(toast2) && amended === '0' && !errs.length,
        `plan 2 Order screen: the payment box says ${days} days (must be 14); a change to €1.50 -> ${toast.slice(-80) || 'no message'}; to €0.50 -> ${toast2.slice(-80) || 'no message'}; changes sent: ${amended} (must say "at least €2" both times and send nothing)`);
      await ctx.close();
    }
    // 8. the new-Order form under the new prices: the contract preview says 14 days
    {
      const PRO = '11111111-1111-4111-8111-111111111111';
      const seed = `window.__MOCK_SEED = { profiles: [{ id: '${PRO}', email: 'pro@test.com', first_name: 'Pro', role: 'editor', is_admin: false, banned: false, visibility: 'public', created_at: new Date().toISOString() }],
        editor_profiles: [{ id: '${PRO}', display_name: 'Pro Editor', role_label: 'editor', city: 'Vilnius', country: 'Lithuania', languages: ['English'], specializations: ['catShorts'], tools: [], bio: '', rate_amount: 30, rate_unit: 'hour', is_public: true, responds_hours: 24, turnaround_days: 5, revisions: 2, availability: 'open', availability_set_at: new Date().toISOString(), created_at: new Date().toISOString() }],
        services: [{ id: '22222222-2222-4222-8222-222222222222', profile_id: '${PRO}', profession_slug: 'video-editor', rate_amount: 30, rate_unit: 'hour', headline: '', values: { video_specialty: ['catShorts'] }, is_public: true, sort_order: 0, created_at: new Date().toISOString() }] };`;
      const { ctx, p, errs } = await open(b, P2, 'en', 1400, seed);
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl2@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl2@test.com', password: 'password123' }); });
      await p.waitForTimeout(700);
      await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); document.querySelector('#modalRoot').innerHTML = ''; });
      await p.goto(url + '#home'); await p.waitForTimeout(700); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.click('.real-card .message-person'); await p.waitForTimeout(900);
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900);
      await p.fill('#oTitle', 'Small cut'); await p.fill('#oScope', 'One short edit'); await p.fill('#oDeliv', 'MP4');
      // €0.50: one message, the plan's €2 (not first "at least €1"), and no Order is sent
      await p.fill('#oPrice', '0.50'); await p.click('#oSend'); await p.waitForTimeout(600);
      const tooLow = await p.evaluate(() => [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | '));
      const made = await p.evaluate(() => window.__mockdb.contracts.length);
      // €1.50: above today's €1, below the plan's €2: the plan's minimum, and nothing sent
      await p.evaluate(() => document.querySelectorAll('.toast').forEach(x => x.remove()));
      await p.fill('#oPrice', '1.50'); await p.click('#oSend'); await p.waitForTimeout(600);
      const between = await p.evaluate(() => [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | '));
      const made2 = await p.evaluate(() => window.__mockdb.contracts.length);
      ok(/at least €2/.test(between) && made2 === 0 && !errs.length, `the new-Order form under the new prices: €1.50 -> ${between.slice(-70) || 'no message'} (Orders sent: ${made2}) (must say "at least €2" and send nothing)`);
      await p.fill('#oPrice', '50');
      await p.evaluate(() => { const d = document.querySelector('.modal details'); if (d) d.open = true; }); await p.waitForTimeout(300);
      const preview = await p.evaluate(() => (document.querySelector('#oTermsPreview') || {}).innerText || '');
      const days = (preview.match(/automatically (\d+) days after delivery/) || [])[1] || '?';
      ok(days === '14' && /at least €2/.test(tooLow) && !/at least €1\b/.test(tooLow) && made === 0 && !errs.length,
        `the new-Order form under the new prices: €0.50 -> ${tooLow.slice(-70) || 'no message'} (Orders sent: ${made}); the contract preview says ${days} days (must be one "at least €2" message, nothing sent, and 14)${errs.length ? ' — page error ' + errs[0] : ''}`);
      await ctx.close();
    }
    // 9. the page still has today's prices (it opened before the switch, or the lookup failed) and sends a €1.50
    //     Order: the database refuses it with its minimum, and the page says that minimum
    {
      const PRO = '11111111-1111-4111-8111-111111111111';
      const seed = `window.__mockDbMinCents = 200; window.__MOCK_SEED = { profiles: [{ id: '${PRO}', email: 'pro@test.com', first_name: 'Pro', role: 'editor', is_admin: false, banned: false, visibility: 'public', created_at: new Date().toISOString() }],
        editor_profiles: [{ id: '${PRO}', display_name: 'Pro Editor', role_label: 'editor', city: 'Vilnius', country: 'Lithuania', languages: ['English'], specializations: ['catShorts'], tools: [], bio: '', rate_amount: 30, rate_unit: 'hour', is_public: true, responds_hours: 24, turnaround_days: 5, revisions: 2, availability: 'open', availability_set_at: new Date().toISOString(), created_at: new Date().toISOString() }],
        services: [{ id: '22222222-2222-4222-8222-222222222222', profile_id: '${PRO}', profession_slug: 'video-editor', rate_amount: 30, rate_unit: 'hour', headline: '', values: { video_specialty: ['catShorts'] }, is_public: true, sort_order: 0, created_at: new Date().toISOString() }] };`;
      const { ctx, p, errs } = await open(b, P1, 'en', 1400, seed);
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl4@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl4@test.com', password: 'password123' }); });
      await p.waitForTimeout(700);
      await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); document.querySelector('#modalRoot').innerHTML = ''; });
      await p.goto(url + '#home'); await p.waitForTimeout(700); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.click('.real-card .message-person'); await p.waitForTimeout(900);
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900);
      await p.fill('#oTitle', 'Small cut'); await p.fill('#oScope', 'One short edit'); await p.fill('#oDeliv', 'MP4'); await p.fill('#oPrice', '1.50');
      await p.click('#oSend'); await p.waitForTimeout(700);
      const said = await p.evaluate(() => [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | '));
      ok(/at least €2/.test(said) && !/between 0 and/.test(said) && !errs.length, `the database refuses a €1.50 Order with its €2 minimum -> the page says: ${said.slice(-80) || 'nothing'} (must name the €2 minimum)`);
      await ctx.close();
    }
    // 10. Accept answers "bad_price" (a proposal below €2 from before the switch): the page names the €2 minimum
    {
      const { ctx, p, errs } = await open(b, P2, 'en', 1400, 'window.__mockAcceptAnswer = "bad_price";');
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl5@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl5@test.com', password: 'password123' }); });
      await p.waitForTimeout(600);
      await p.evaluate(() => { const db = window.__mockdb; const me = db.profiles.find(x => x.email === 'cl5@test.com'); me.rules_version = '2026-11'; const fl = '99999999-9999-4999-8999-999999999999';
        db.profiles.push({ id: fl, email: 'fl@test.com', first_name: 'Tom', role: 'editor', is_admin: false, banned: false, created_at: new Date().toISOString() });
        const conv = { id: '88888888-8888-4888-8888-888888888888', user_a: [me.id, fl].sort()[0], user_b: [me.id, fl].sort()[1], created_at: new Date().toISOString() }; db.conversations.push(conv);
        db.contracts.push({ id: '77777777-7777-4777-8777-777777777777', conversation_id: conv.id, editor: fl, client: me.id, proposed_by: fl, title: 'Small cut', description: 'One short edit', price: 1.5, currency: 'EUR', pricing: 'project',
          amount_cents: 150, funded_cents: 0, released_cents: 0, refunded_cents: 0, payment_mode: 'escrow', status: 'proposed', revisions: 1, changes_used: 0, has_milestones: false, terms_version: 2, client_accepted_version: null,
          freelancer_accepted_version: 2, pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14, created_at: new Date().toISOString() }); });
      await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); });
      await p.goto(url + '#contracts'); await p.waitForTimeout(900); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.locator('.c-row').first().click(); await p.waitForTimeout(900);
      let said = '(no Accept button)';
      if (await p.locator('[data-caction="accept"]').count()) {
        await p.click('[data-caction="accept"]'); await p.waitForTimeout(700);
        said = await p.evaluate(() => [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | '));
      }
      ok(/at least €2/.test(said) && !/between 0 and/.test(said) && !errs.length, `Accept answers "bad_price" on a €1.50 Order under the new prices -> the page says: ${said.slice(-80) || 'nothing'} (must name the €2 minimum)`);
      await ctx.close();
    }
    // 11. a proposal made at today's prices, changed after the switch: the preview shows the days it will get (14)
    {
      const { ctx, p, errs } = await open(b, P2, 'en');
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl3@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl3@test.com', password: 'password123' }); });
      await p.waitForTimeout(600);
      await p.evaluate(() => { const db = window.__mockdb; const me = db.profiles.find(x => x.email === 'cl3@test.com'); me.rules_version = '2026-11'; const fl = '99999999-9999-4999-8999-999999999999';
        db.profiles.push({ id: fl, email: 'fl@test.com', first_name: 'Tom', role: 'editor', is_admin: false, banned: false, created_at: new Date().toISOString() });
        const conv = { id: '88888888-8888-4888-8888-888888888888', user_a: [me.id, fl].sort()[0], user_b: [me.id, fl].sort()[1], created_at: new Date().toISOString() }; db.conversations.push(conv);
        db.contracts.push({ id: '77777777-7777-4777-8777-777777777777', conversation_id: conv.id, editor: fl, client: me.id, proposed_by: me.id, title: 'Product film', description: 'Edit a film', price: 100, currency: 'EUR', pricing: 'project',
          amount_cents: 10000, funded_cents: 0, released_cents: 0, refunded_cents: 0, payment_mode: 'escrow', status: 'proposed', revisions: 1, changes_used: 0, has_milestones: false, terms_version: 1, client_accepted_version: 1,
          freelancer_accepted_version: null, pricing_version: 1, commission_bps: 0, commission_cents: 0, auto_days: 7, created_at: new Date().toISOString() }); });
      await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); });
      await p.goto(url + '#contracts'); await p.waitForTimeout(900); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.locator('.c-row').first().click(); await p.waitForTimeout(900);
      let days = '?';
      if (await p.locator('[data-caction="edit"]').count()) {
        await p.click('[data-caction="edit"]'); await p.waitForTimeout(900);
        await p.evaluate(() => { const d = document.querySelector('.modal details'); if (d) d.open = true; }); await p.waitForTimeout(300);
        const preview = await p.evaluate(() => (document.querySelector('#oTermsPreview') || {}).innerText || '');
        days = (preview.match(/automatically (\d+) days after delivery/) || [])[1] || '?';
      }
      ok(days === '14' && !errs.length, `a proposal made at today's prices, changed after the switch: the contract preview says ${days} days (must be 14, as it will be saved)`);
      await ctx.close();
    }
    // 12. a tab opened at today's prices stays open while the switch moves (or the visitor comes back to it later): when
    //     the visitor returns to the tab the homepage shows the prices in force, and opening the new-Order form asks the
    //     database again, so its note says the prices the Order will get (the database stamps those anyway)
    {
      const PRO = '11111111-1111-4111-8111-111111111111';
      const seed = `window.__MOCK_SEED = { profiles: [{ id: '${PRO}', email: 'pro@test.com', first_name: 'Pro', role: 'editor', is_admin: false, banned: false, visibility: 'public', created_at: new Date().toISOString() }],
        editor_profiles: [{ id: '${PRO}', display_name: 'Pro Editor', role_label: 'editor', city: 'Vilnius', country: 'Lithuania', languages: ['English'], specializations: ['catShorts'], tools: [], bio: '', rate_amount: 30, rate_unit: 'hour', is_public: true, responds_hours: 24, turnaround_days: 5, revisions: 2, availability: 'open', availability_set_at: new Date().toISOString(), created_at: new Date().toISOString() }],
        services: [{ id: '22222222-2222-4222-8222-222222222222', profile_id: '${PRO}', profession_slug: 'video-editor', rate_amount: 30, rate_unit: 'hour', headline: '', values: { video_specialty: ['catShorts'] }, is_public: true, sort_order: 0, created_at: new Date().toISOString() }] };`;
      // back to the tab
      let back = '?';
      {
        const { ctx, p, errs } = await open(b, P1, 'en');
        const before = (await home(p)).shown;
        await p.evaluate((pr) => { window.__mockPrices = pr; document.dispatchEvent(new Event('visibilitychange')); }, P2); await p.waitForTimeout(600);
        const h = await home(p); back = `${before ? 'shown' : 'hidden'} -> ${h.shown ? 'shown' : 'hidden'}`;
        ok(!before && h.shown && /5% commission/.test(h.block) && !errs.length, `a tab opened at today's prices, the switch moved, the visitor comes back to it -> the new-price block ${back} (must be shown)`);
        await ctx.close();
      }
      // the new-Order form
      {
        const { ctx, p, errs } = await open(b, P1, 'en', 1400, seed);
        await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl6@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl6@test.com', password: 'password123' }); });
        await p.waitForTimeout(700);
        await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); document.querySelector('#modalRoot').innerHTML = ''; });
        await p.goto(url + '#home'); await p.waitForTimeout(700); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
        await p.evaluate((pr) => { window.__mockPrices = pr; }, P2);
        await p.click('.real-card .message-person'); await p.waitForTimeout(900);
        await p.click('.chat-window .open-contract'); await p.waitForTimeout(900);
        const note = await p.evaluate(() => (document.querySelector('#oModeNote') || {}).textContent || '');
        ok(/5% commission/.test(note) && /14 days/.test(note) && !/no commission/.test(note) && !errs.length, `the switch moved while the tab was open, then the new-Order form opens -> its note: ${note.slice(0, 120) || 'none'} (must say 5% and 14 days)`);
        await ctx.close();
      }
    }
    // 13. Accept answers "rules_not_accepted" (the new prices need the new rules, and one side has not agreed to them
    //     yet), and Accept answers "bad_price" while the page still has today's prices: each time the page says why
    for (const [answer, start, want, label] of [['rules_not_accepted', P2, /agreed to Cuvori's new rules/, "says the new rules must be agreed to"], ['bad_price', P1, /at least €2/, 'names the €2 minimum']]) {
      const { ctx, p, errs } = await open(b, start, 'en', 1400, `window.__mockAcceptAnswer = "${answer}";`);
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl7@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl7@test.com', password: 'password123' }); });
      await p.waitForTimeout(600);
      await p.evaluate(() => { const db = window.__mockdb; const me = db.profiles.find(x => x.email === 'cl7@test.com'); me.rules_version = '2026-11'; const fl = '99999999-9999-4999-8999-999999999999';
        db.profiles.push({ id: fl, email: 'fl@test.com', first_name: 'Tom', role: 'editor', is_admin: false, banned: false, created_at: new Date().toISOString() });
        const conv = { id: '88888888-8888-4888-8888-888888888888', user_a: [me.id, fl].sort()[0], user_b: [me.id, fl].sort()[1], created_at: new Date().toISOString() }; db.conversations.push(conv);
        db.contracts.push({ id: '77777777-7777-4777-8777-777777777777', conversation_id: conv.id, editor: fl, client: me.id, proposed_by: fl, title: 'Small cut', description: 'One short edit', price: 1.5, currency: 'EUR', pricing: 'project',
          amount_cents: 150, funded_cents: 0, released_cents: 0, refunded_cents: 0, payment_mode: 'escrow', status: 'proposed', revisions: 1, changes_used: 0, has_milestones: false, terms_version: 2, client_accepted_version: null,
          freelancer_accepted_version: 2, pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14, created_at: new Date().toISOString() }); });
      await p.evaluate(async (pr) => { window.__mockPrices = pr; window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); }, P2);
      await p.goto(url + '#contracts'); await p.waitForTimeout(900); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.evaluate((pr) => { window.__mockPrices = pr; }, P2);
      await p.locator('.c-row').first().click(); await p.waitForTimeout(900);
      let said = '(no Accept button)';
      if (await p.locator('[data-caction="accept"]').count()) {
        await p.click('[data-caction="accept"]'); await p.waitForTimeout(800);
        said = await p.evaluate(() => [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | '));
      }
      ok(want.test(said) && !/Something went wrong|between 0 and/.test(said) && !errs.length, `Accept answers "${answer}"${start === P1 ? ' while the page still has today\'s prices' : ''} -> the page says: ${said.slice(-110) || 'nothing'} (must say why: ${label})`);
      // a long message stays long enough to be read (30 words need more than a short "Saved")
      if (answer === 'rules_not_accepted') {
        await p.waitForTimeout(4200);
        const still = await p.evaluate(() => [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | '));
        ok(want.test(still), `the "rules changed" message, 5 seconds after it appeared -> ${want.test(still) ? 'still there' : 'gone'} (must still be there: about 30 words)`);
        // ... and it closes on a tap (it covers the top of the screen, pop-ups too)
        const n = await p.locator('#toastWrap .toast').count();
        if (n) await p.locator('#toastWrap .toast').first().click({ force: true });
        await p.waitForTimeout(200);
        const left = await p.locator('#toastWrap .toast').count();
        ok(n >= 1 && left === n - 1, `tapping the long message -> ${n} message(s) before, ${left} after (must close the one tapped)`);
      }
      await ctx.close();
    }
    // 14. Accept answers "order_changed" because the switch moved: the page asks for the prices again too (the homepage
    //     shows the prices in force without waiting for the next visit)
    {
      const { ctx, p, errs } = await open(b, P1, 'en', 1400, 'window.__mockAcceptAnswer = "order_changed";');
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl8@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl8@test.com', password: 'password123' }); });
      await p.waitForTimeout(600);
      await p.evaluate(() => { const db = window.__mockdb; const me = db.profiles.find(x => x.email === 'cl8@test.com'); me.rules_version = '2026-11'; const fl = '99999999-9999-4999-8999-999999999999';
        db.profiles.push({ id: fl, email: 'fl@test.com', first_name: 'Tom', role: 'editor', is_admin: false, banned: false, created_at: new Date().toISOString() });
        const conv = { id: '88888888-8888-4888-8888-888888888888', user_a: [me.id, fl].sort()[0], user_b: [me.id, fl].sort()[1], created_at: new Date().toISOString() }; db.conversations.push(conv);
        db.contracts.push({ id: '77777777-7777-4777-8777-777777777777', conversation_id: conv.id, editor: fl, client: me.id, proposed_by: fl, title: 'Product film', description: 'Edit a film', price: 100, currency: 'EUR', pricing: 'project',
          amount_cents: 10000, funded_cents: 0, released_cents: 0, refunded_cents: 0, payment_mode: 'escrow', status: 'proposed', revisions: 1, changes_used: 0, has_milestones: false, terms_version: 1, client_accepted_version: null,
          freelancer_accepted_version: 1, pricing_version: 1, commission_bps: 0, commission_cents: 0, auto_days: 7, created_at: new Date().toISOString() }); });
      await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); });
      await p.goto(url + '#contracts'); await p.waitForTimeout(900); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.evaluate((pr) => { window.__mockPrices = pr; }, P2);
      await p.locator('.c-row').first().click(); await p.waitForTimeout(900);
      const hasAccept = await p.locator('[data-caction="accept"]').count();
      if (hasAccept) { await p.click('[data-caction="accept"]'); await p.waitForTimeout(900); }
      await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.goto(url + '#home'); await p.waitForTimeout(500);
      const h = await home(p);
      ok(hasAccept && h.shown && !errs.length, `Accept answers "order_changed" after the switch moved -> the homepage's new-price block is ${h.shown ? 'shown' : 'still hidden'} (must be shown)`);
      await ctx.close();
    }
    // 15. the prices change while someone is typing in Settings: what they typed (not saved yet) stays
    {
      const { ctx, p, errs } = await open(b, P1, 'en');
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl9@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl9@test.com', password: 'password123' }); });
      await p.waitForTimeout(600); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.goto(url + '#settings'); await p.waitForTimeout(600);
      const typed = await p.evaluate(() => { const f = document.querySelector('#profileFirstName'); if (!f) return '(no field)'; f.value = 'Linas'; f.dispatchEvent(new Event('input', { bubbles: true })); return f.value; });
      await p.evaluate((pr) => { window.__mockPrices = pr; document.dispatchEvent(new Event('visibilitychange')); }, P2); await p.waitForTimeout(700);
      const after = await p.evaluate(() => ({ name: (document.querySelector('#profileFirstName') || {}).value, hero: (document.querySelector('[data-i18n="heroTitle"]') || {}).textContent }));
      ok(typed === 'Linas' && after.name === 'Linas' && after.hero === 'Find your freelancer.' && !errs.length, `the switch moved while "Linas" was typed into Settings (not saved) -> the field says ${after.name}, the headline ${after.hero} (must keep "Linas"; the new headline)`);
      await ctx.close();
    }
    // 16. a part of a plan 2 Order handed in without a link: the page asks for the link first; a plan 1 Order's part goes as today
    for (const plan of [2, 1]) {
      const { ctx, p, errs } = await open(b, P2, 'en');
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'fm@test.com', password: 'password123', options: { data: { first_name: 'Tom' } } }); await sb.auth.signInWithPassword({ email: 'fm@test.com', password: 'password123' }); });
      await p.waitForTimeout(600);
      await p.evaluate((pl) => {
        const db = window.__mockdb; const me = db.profiles.find(x => x.email === 'fm@test.com'); me.role = 'editor'; me.rules_version = '2026-11';
        const cl = '99999999-9999-4999-8999-999999999999';
        db.profiles.push({ id: cl, email: 'cl@test.com', first_name: 'Lina', role: 'client', is_admin: false, banned: false, created_at: new Date().toISOString() });
        const conv = { id: '88888888-8888-4888-8888-888888888888', user_a: [me.id, cl].sort()[0], user_b: [me.id, cl].sort()[1], created_at: new Date().toISOString() }; db.conversations.push(conv);
        const id = '77777777-7777-4777-8777-777777777777';
        db.contracts.push({ id, conversation_id: conv.id, editor: me.id, client: cl, proposed_by: cl, title: 'Product film', description: 'Edit a film',
          price: 100, currency: 'EUR', pricing: 'project', amount_cents: 10000, funded_cents: 10000, released_cents: 0, refunded_cents: 0, payment_mode: 'escrow', status: 'funded',
          revisions: 1, changes_used: 0, has_milestones: true, terms_version: 1, client_accepted_version: 1, freelancer_accepted_version: 1, accepted_at: new Date().toISOString(),
          pricing_version: pl, commission_bps: pl >= 2 ? 500 : 0, commission_cents: 0, auto_days: pl >= 2 ? 14 : 7, created_at: new Date().toISOString() });
        db.order_milestones.push({ id: '66666666-6666-4666-8666-666666666666', order_id: id, position: 1, title: 'Part 1', amount_cents: 4000, status: 'pending', created_at: new Date().toISOString() },
                                 { id: '66666666-6666-4666-8666-666666666667', order_id: id, position: 2, title: 'Part 2', amount_cents: 6000, status: 'pending', created_at: new Date().toISOString() });
      }, plan);
      await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); });
      await p.goto(url + '#contracts'); await p.waitForTimeout(900); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.locator('.c-row').first().click(); await p.waitForTimeout(800);
      const submit = p.locator('[data-msact="submit"]').first(); const has = await p.locator('[data-msact="submit"]').count() > 0;
      if (has) { await submit.click(); await p.waitForTimeout(400); await p.click('#onGo'); await p.waitForTimeout(500); }
      const toast = await p.evaluate(() => [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | '));
      const st = await p.evaluate(() => window.__mockdb.order_milestones[0].status);
      if (plan === 2) ok(has && /Add a link to the work first/.test(toast) && st === 'pending' && !errs.length, `plan 2 Order: a part handed in without a link -> ${toast.slice(-60) || 'no message'}, the part stays ${st} (must be "Add a link to the work first.", pending)`);
      else ok(has && st === 'submitted' && !errs.length, `plan 1 Order: a part handed in without a link -> the part is ${st} (must be submitted, as today)${errs.length ? ' — page error ' + errs[0] : ''}`);
      await ctx.close();
    }
    // 17. the prices change during a visit: only the price texts are redrawn. The results heading of a filtered list and
    //     the Post-a-job preview being typed keep what they show
    {
      const { ctx, p, errs } = await open(b, P1, 'en');
      await p.evaluate(() => { document.querySelector('#resultsTitle').textContent = 'Video editors'; document.querySelector('#pvTitle').textContent = 'Wedding film edit'; });
      await p.evaluate((pr) => { window.__mockPrices = pr; document.dispatchEvent(new Event('visibilitychange')); }, P2); await p.waitForTimeout(700);
      const r = await p.evaluate(() => ({ results: document.querySelector('#resultsTitle').textContent, preview: document.querySelector('#pvTitle').textContent, hero: document.querySelector('[data-i18n="heroTitle"]').textContent }));
      ok(r.results === 'Video editors' && r.preview === 'Wedding film edit' && r.hero === 'Find your freelancer.' && !errs.length, `the prices change while a list is filtered and a job is being written -> heading "${r.results}", preview "${r.preview}", headline "${r.hero}" (must keep both; the new headline)`);
      await ctx.close();
    }
    // 18. the prices change while the new-Order form is open (the visitor came back to the tab): its note follows
    {
      const PRO = '11111111-1111-4111-8111-111111111111';
      const seed = `window.__MOCK_SEED = { profiles: [{ id: '${PRO}', email: 'pro@test.com', first_name: 'Pro', role: 'editor', is_admin: false, banned: false, visibility: 'public', created_at: new Date().toISOString() }],
        editor_profiles: [{ id: '${PRO}', display_name: 'Pro Editor', role_label: 'editor', city: 'Vilnius', country: 'Lithuania', languages: ['English'], specializations: ['catShorts'], tools: [], bio: '', rate_amount: 30, rate_unit: 'hour', is_public: true, responds_hours: 24, turnaround_days: 5, revisions: 2, availability: 'open', availability_set_at: new Date().toISOString(), created_at: new Date().toISOString() }],
        services: [{ id: '22222222-2222-4222-8222-222222222222', profile_id: '${PRO}', profession_slug: 'video-editor', rate_amount: 30, rate_unit: 'hour', headline: '', values: { video_specialty: ['catShorts'] }, is_public: true, sort_order: 0, created_at: new Date().toISOString() }] };`;
      const { ctx, p, errs } = await open(b, P1, 'en', 1400, seed);
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl10@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl10@test.com', password: 'password123' }); });
      await p.waitForTimeout(700);
      await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); document.querySelector('#modalRoot').innerHTML = ''; });
      await p.goto(url + '#home'); await p.waitForTimeout(700); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.click('.real-card .message-person'); await p.waitForTimeout(900);
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900);
      const before = await p.evaluate(() => (document.querySelector('#oModeNote') || {}).textContent || '');
      await p.evaluate((pr) => { window.__mockPrices = pr; document.dispatchEvent(new Event('visibilitychange')); }, P2); await p.waitForTimeout(700);
      const after = await p.evaluate(() => (document.querySelector('#oModeNote') || {}).textContent || '');
      ok(/no commission/.test(before) && /5% commission/.test(after) && /14 days/.test(after) && !errs.length, `the new-Order form is open when the prices change -> its note: ${after.slice(0, 110) || 'none'} (must now say 5% and 14 days)`);
      await ctx.close();
    }
    // 19. Accept answers "bad_price" and the page can't reach the database to learn the minimum: it says the price is below
    //     the minimum, never "between 0 and 1,000,000"
    {
      const { ctx, p, errs } = await open(b, P1, 'en', 1400, 'window.__mockAcceptAnswer = "bad_price";');
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl11@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl11@test.com', password: 'password123' }); });
      await p.waitForTimeout(600);
      await p.evaluate(() => { const db = window.__mockdb; const me = db.profiles.find(x => x.email === 'cl11@test.com'); me.rules_version = '2026-11'; const fl = '99999999-9999-4999-8999-999999999999';
        db.profiles.push({ id: fl, email: 'fl@test.com', first_name: 'Tom', role: 'editor', is_admin: false, banned: false, created_at: new Date().toISOString() });
        const conv = { id: '88888888-8888-4888-8888-888888888888', user_a: [me.id, fl].sort()[0], user_b: [me.id, fl].sort()[1], created_at: new Date().toISOString() }; db.conversations.push(conv);
        db.contracts.push({ id: '77777777-7777-4777-8777-777777777777', conversation_id: conv.id, editor: fl, client: me.id, proposed_by: fl, title: 'Small cut', description: 'One short edit', price: 1.5, currency: 'EUR', pricing: 'project',
          amount_cents: 150, funded_cents: 0, released_cents: 0, refunded_cents: 0, payment_mode: 'escrow', status: 'proposed', revisions: 1, changes_used: 0, has_milestones: false, terms_version: 2, client_accepted_version: null,
          freelancer_accepted_version: 2, pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14, created_at: new Date().toISOString() }); });
      await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); });
      await p.goto(url + '#contracts'); await p.waitForTimeout(900); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; window.__mockPricesFail = true; });
      await p.locator('.c-row').first().click(); await p.waitForTimeout(900);
      let said = '(no Accept button)';
      if (await p.locator('[data-caction="accept"]').count()) { await p.click('[data-caction="accept"]'); await p.waitForTimeout(800); said = await p.evaluate(() => [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | ')); }
      ok(/below the minimum/.test(said) && !/between 0 and/.test(said) && !errs.length, `Accept answers "bad_price" and the prices can't be read -> the page says: ${said.slice(-100) || 'nothing'} (must say the price is below the minimum)`);
      await ctx.close();
    }
    // 20. the price lookup hangs (Supabase very slow): the new-Order form still opens within a few seconds; and pressing
    //     Send again and again shows at most 3 messages at a time
    {
      const PRO = '11111111-1111-4111-8111-111111111111';
      const seed = `window.__MOCK_SEED = { profiles: [{ id: '${PRO}', email: 'pro@test.com', first_name: 'Pro', role: 'editor', is_admin: false, banned: false, visibility: 'public', created_at: new Date().toISOString() }],
        editor_profiles: [{ id: '${PRO}', display_name: 'Pro Editor', role_label: 'editor', city: 'Vilnius', country: 'Lithuania', languages: ['English'], specializations: ['catShorts'], tools: [], bio: '', rate_amount: 30, rate_unit: 'hour', is_public: true, responds_hours: 24, turnaround_days: 5, revisions: 2, availability: 'open', availability_set_at: new Date().toISOString(), created_at: new Date().toISOString() }],
        services: [{ id: '22222222-2222-4222-8222-222222222222', profile_id: '${PRO}', profession_slug: 'video-editor', rate_amount: 30, rate_unit: 'hour', headline: '', values: { video_specialty: ['catShorts'] }, is_public: true, sort_order: 0, created_at: new Date().toISOString() }] };`;
      const { ctx, p, errs } = await open(b, P1, 'en', 1400, seed);
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl12@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl12@test.com', password: 'password123' }); });
      await p.waitForTimeout(700);
      await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); document.querySelector('#modalRoot').innerHTML = ''; });
      await p.goto(url + '#home'); await p.waitForTimeout(700); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; window.__mockPricesHang = true; });
      await p.click('.real-card .message-person'); await p.waitForTimeout(900);
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(4200);
      const opened = await p.locator('#oTitle').count();
      let most = 0;
      if (opened) { for (let i = 0; i < 6; i++) { await p.click('#oSend'); await p.waitForTimeout(80); most = Math.max(most, await p.locator('#toastWrap .toast').count()); } }
      ok(opened === 1 && most >= 1 && most <= 3 && !errs.length, `the price lookup hangs, then the new-Order form is opened -> ${opened ? 'open after 4 s' : 'still loading after 4 s'}; Send pressed 6 times without a title -> at most ${most} messages at once (must open; at most 3)`);
      await ctx.close();
    }
    // 21. a freelancer delivers through a progress report on a plan 2 Order: without a link or a video the page asks for the link
    {
      const { ctx, p, errs } = await open(b, P2, 'en');
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'fr@test.com', password: 'password123', options: { data: { first_name: 'Tom' } } }); await sb.auth.signInWithPassword({ email: 'fr@test.com', password: 'password123' }); });
      await p.waitForTimeout(600);
      await p.evaluate(() => {
        const db = window.__mockdb; const me = db.profiles.find(x => x.email === 'fr@test.com'); me.role = 'editor'; me.rules_version = '2026-11';
        const cl = '99999999-9999-4999-8999-999999999999';
        db.profiles.push({ id: cl, email: 'cl@test.com', first_name: 'Lina', role: 'client', is_admin: false, banned: false, created_at: new Date().toISOString() });
        const conv = { id: '88888888-8888-4888-8888-888888888888', user_a: [me.id, cl].sort()[0], user_b: [me.id, cl].sort()[1], created_at: new Date().toISOString(), last_message_at: new Date().toISOString() }; db.conversations.push(conv);
        db.messages.push({ id: '55555555-5555-4555-8555-555555555555', conversation_id: conv.id, sender: cl, kind: 'text', body: 'Hi Tom', created_at: new Date().toISOString() });
        db.contracts.push({ id: '77777777-7777-4777-8777-777777777777', conversation_id: conv.id, editor: me.id, client: cl, proposed_by: cl, title: 'Product film', description: 'Edit a film',
          price: 100, currency: 'EUR', pricing: 'project', amount_cents: 10000, funded_cents: 10000, released_cents: 0, refunded_cents: 0, payment_mode: 'escrow', status: 'funded',
          revisions: 1, changes_used: 0, has_milestones: false, terms_version: 1, client_accepted_version: 1, freelancer_accepted_version: 1, accepted_at: new Date().toISOString(),
          pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14, created_at: new Date().toISOString() });
      });
      // signed in again, the page loads the conversation and the Order (as after a visit)
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signOut(); await sb.auth.signInWithPassword({ email: 'fr@test.com', password: 'password123' }); });
      await p.waitForTimeout(1500); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      let said = '(no conversation)', st = '?';
      if (await p.locator('#contactList .contact').count()) {
        await p.locator('#contactList .contact').first().click(); await p.waitForTimeout(900);
        if (await p.locator('.chat-window .send-report').count()) {
          await p.click('.chat-window .send-report'); await p.waitForTimeout(900);
          if (await p.locator('#rFinal').count()) { await p.check('#rFinal'); await p.click('#sendProgress'); await p.waitForTimeout(600); said = await p.evaluate(() => [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | ')); }
          else said = '(no "this is the delivery" box)';
        } else said = '(no Send update button)';
      }
      st = await p.evaluate(() => (window.__mockdb.contracts[0] || {}).status);
      ok(/Add a link to the work first/.test(said) && st === 'funded' && !errs.length, `plan 2 Order: a progress report sent as the delivery without a link or video -> ${said.slice(-70)}, the Order stays ${st} (must be "Add a link to the work first.", funded)`);
      await ctx.close();
    }
    // 22. an amendment the page lets through but the database refuses for the €2 minimum (the page still had today's
    //     prices): the page names the database's minimum
    {
      const { ctx, p, errs } = await open(b, P1, 'en', 1400, 'window.__mockDbMinCents = 200;');
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl13@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl13@test.com', password: 'password123' }); });
      await p.waitForTimeout(600);
      await p.evaluate(() => { const db = window.__mockdb; const me = db.profiles.find(x => x.email === 'cl13@test.com'); me.rules_version = '2026-11'; const fl = '99999999-9999-4999-8999-999999999999';
        db.profiles.push({ id: fl, email: 'fl@test.com', first_name: 'Tom', role: 'editor', is_admin: false, banned: false, created_at: new Date().toISOString() });
        const conv = { id: '88888888-8888-4888-8888-888888888888', user_a: [me.id, fl].sort()[0], user_b: [me.id, fl].sort()[1], created_at: new Date().toISOString() }; db.conversations.push(conv);
        db.contracts.push({ id: '77777777-7777-4777-8777-777777777777', conversation_id: conv.id, editor: fl, client: me.id, proposed_by: fl, title: 'Small cut', description: 'One short edit', price: 2.5, currency: 'EUR', pricing: 'project',
          amount_cents: 250, funded_cents: 0, released_cents: 0, refunded_cents: 0, payment_mode: 'escrow', status: 'accepted', revisions: 1, changes_used: 0, has_milestones: false, terms_version: 1, client_accepted_version: 1,
          freelancer_accepted_version: 1, accepted_at: new Date().toISOString(), pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14, created_at: new Date().toISOString() }); });
      await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); });
      await p.goto(url + '#contracts'); await p.waitForTimeout(900); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.locator('.c-row').first().click(); await p.waitForTimeout(900);
      let said = '(no Propose a change button)';
      if (await p.locator('[data-caction="amend"]').count()) {
        await p.click('[data-caction="amend"]'); await p.waitForTimeout(600);
        if (await p.locator('#amDelta').count()) { await p.fill('#amDelta', '-1'); await p.fill('#amNote', 'Shorter cut'); await p.click('#amGo'); await p.waitForTimeout(700); said = await p.evaluate(() => [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | ')); }
        else said = '(no price field)';
      }
      ok(/at least €2/.test(said) && !errs.length, `an amendment taking a plan 2 Order from €2.50 to €1.50, the page still on today's prices -> ${said.slice(-80)} (must name the €2 minimum)`);
      await ctx.close();
    }
    // 23-25. the new-Order form and the prices, around a switch: a helper that opens the form at today's prices
    const PRO2 = '11111111-1111-4111-8111-111111111111';
    const seed2 = `window.__MOCK_SEED = { profiles: [{ id: '${PRO2}', email: 'pro@test.com', first_name: 'Pro', role: 'editor', is_admin: false, banned: false, visibility: 'public', created_at: new Date().toISOString() }],
      editor_profiles: [{ id: '${PRO2}', display_name: 'Pro Editor', role_label: 'editor', city: 'Vilnius', country: 'Lithuania', languages: ['English'], specializations: ['catShorts'], tools: [], bio: '', rate_amount: 30, rate_unit: 'hour', is_public: true, responds_hours: 24, turnaround_days: 5, revisions: 2, availability: 'open', availability_set_at: new Date().toISOString(), created_at: new Date().toISOString() }],
      services: [{ id: '22222222-2222-4222-8222-222222222222', profile_id: '${PRO2}', profession_slug: 'video-editor', rate_amount: 30, rate_unit: 'hour', headline: '', values: { video_specialty: ['catShorts'] }, is_public: true, sort_order: 0, created_at: new Date().toISOString() }] };`;
    const formAt = async (email, opts = {}, extra = '') => {
      const o = await open(b, P1, 'en', 1400, seed2 + extra, opts);
      await o.p.evaluate(async (em) => { const sb = window.__sb; await sb.auth.signUp({ email: em, password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: em, password: 'password123' }); }, email);
      await o.p.waitForTimeout(700);
      await o.p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); document.querySelector('#modalRoot').innerHTML = ''; });
      await o.p.goto(url + '#home'); await o.p.waitForTimeout(700); await o.p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await o.p.click('.real-card .message-person'); await o.p.waitForTimeout(900);
      return o;
    };
    // 23. someone reads the terms in the form, leaves the tab and comes back (prices unchanged): the terms stay where they were
    {
      const { ctx, p, errs } = await formAt('cl14@test.com');
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900);
      await p.fill('#oTitle', 'Product film'); await p.fill('#oScope', 'Edit a 60-second film'); await p.fill('#oPrice', '100');
      const r = await p.evaluate(async () => { const d = document.querySelector('.modal details'); if (d) d.open = true; await new Promise(x => setTimeout(x, 300));
        const box = document.querySelector('#oTermsPreview'); if (!box) return { top: -1 }; box.scrollTop = 200; const was = box.scrollTop;
        document.dispatchEvent(new Event('visibilitychange')); await new Promise(x => setTimeout(x, 700)); return { was, top: document.querySelector('#oTermsPreview').scrollTop }; });
      ok(r.was > 0 && r.top === r.was && !errs.length, `the terms scrolled to ${r.was}px, the tab left and back with the same prices -> ${r.top}px (must stay where they were)`);
      await ctx.close();
    }
    // 24. the switch moves while the form is open (and the tab never left): Send checks the prices first; the note changes,
    //     the page says so, and nothing is sent until the person sends again
    {
      const { ctx, p, errs } = await formAt('cl15@test.com');
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900);
      await p.fill('#oTitle', 'Product film'); await p.fill('#oScope', 'Edit a 60-second film'); await p.fill('#oDeliv', 'MP4'); await p.fill('#oPrice', '100');
      const n0 = await p.evaluate((pr) => { window.__mockPrices = pr; return window.__mockdb.contracts.length; }, P2);
      await p.click('#oSend'); await p.waitForTimeout(900);
      const r = await p.evaluate(() => ({ n: window.__mockdb.contracts.length, note: (document.querySelector('#oModeNote') || {}).textContent || '', said: [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | ') }));
      ok(r.n === n0 && /5% commission/.test(r.note) && /prices changed while this form was open/.test(r.said) && !errs.length, `the switch moved while the form was open, then Send -> Orders sent: ${r.n - n0}; the note: ${r.note.slice(0, 60)}; the page says: ${r.said.slice(-90) || 'nothing'} (must send nothing, show the new note and say why)`);
      await ctx.close();
    }
    // 25. a form closed while the prices were slow to load does not take over the next form: the next one still follows a switch
    {
      const { ctx, p, errs } = await formAt('cl16@test.com');
      await p.evaluate(() => { window.__mockPricesHang = true; });
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(300);
      await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; window.__mockPricesHang = false; });
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(3600);   // the first form's 3-second wait ends meanwhile
      await p.evaluate((pr) => { window.__mockPrices = pr; document.dispatchEvent(new Event('visibilitychange')); }, P2); await p.waitForTimeout(700);
      const note = await p.evaluate(() => (document.querySelector('#oModeNote') || {}).textContent || '');
      ok(/5% commission/.test(note) && !errs.length, `a form closed while loading, a second one opened, then the switch moved -> the open form's note: ${note.slice(0, 70) || 'none'} (must follow: 5%)`);
      await ctx.close();
    }
    // 26. Accept answers "bad_price" and the price lookup hangs: the answer comes within a few seconds anyway
    {
      const { ctx, p, errs } = await open(b, P1, 'en', 1400, 'window.__mockAcceptAnswer = "bad_price";');
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl17@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl17@test.com', password: 'password123' }); });
      await p.waitForTimeout(600);
      await p.evaluate(() => { const db = window.__mockdb; const me = db.profiles.find(x => x.email === 'cl17@test.com'); me.rules_version = '2026-11'; const fl = '99999999-9999-4999-8999-999999999999';
        db.profiles.push({ id: fl, email: 'fl@test.com', first_name: 'Tom', role: 'editor', is_admin: false, banned: false, created_at: new Date().toISOString() });
        const conv = { id: '88888888-8888-4888-8888-888888888888', user_a: [me.id, fl].sort()[0], user_b: [me.id, fl].sort()[1], created_at: new Date().toISOString() }; db.conversations.push(conv);
        db.contracts.push({ id: '77777777-7777-4777-8777-777777777777', conversation_id: conv.id, editor: fl, client: me.id, proposed_by: fl, title: 'Small cut', description: 'One short edit', price: 1.5, currency: 'EUR', pricing: 'project',
          amount_cents: 150, funded_cents: 0, released_cents: 0, refunded_cents: 0, payment_mode: 'escrow', status: 'proposed', revisions: 1, changes_used: 0, has_milestones: false, terms_version: 2, client_accepted_version: null,
          freelancer_accepted_version: 2, pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14, created_at: new Date().toISOString() }); });
      await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); });
      await p.goto(url + '#contracts'); await p.waitForTimeout(900); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; window.__mockPricesHang = true; });
      await p.locator('.c-row').first().click(); await p.waitForTimeout(900);
      let said = '(no Accept button)';
      if (await p.locator('[data-caction="accept"]').count()) { await p.click('[data-caction="accept"]'); await p.waitForTimeout(4500); said = await p.evaluate(() => [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | ')); }
      ok(/below the minimum|at least €/.test(said) && !errs.length, `Accept answers "bad_price" while the price lookup hangs -> after 4 s the page says: ${said.slice(-80) || 'nothing'} (must say the minimum)`);
      await ctx.close();
    }
    // 27. Send pressed twice quickly while the price check is slow: one Order, no error
    {
      const { ctx, p, errs } = await formAt('cl18@test.com');
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900);
      await p.fill('#oTitle', 'Product film'); await p.fill('#oScope', 'Edit a 60-second film'); await p.fill('#oDeliv', 'MP4'); await p.fill('#oPrice', '100');
      const n0 = await p.evaluate(() => { window.__mockPricesDelayMs = 1500; return window.__mockdb.contracts.length; });
      await p.click('#oSend'); await p.waitForTimeout(150); await p.click('#oSend', { force: true }).catch(() => {}); await p.waitForTimeout(2500);
      const r = await p.evaluate(() => ({ n: window.__mockdb.contracts.length, said: [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | ') }));
      ok(r.n - n0 === 1 && !/already|went wrong/i.test(r.said) && !errs.length, `Send pressed twice while the price check takes 1.5 s -> ${r.n - n0} Order(s) sent; the page says: ${r.said.slice(-90) || 'nothing'} (must send one Order, no error)`);
      await ctx.close();
    }
    // 28. the prices can't be checked at Send (Supabase answers with an error) and the last answer is more than a minute
    //     old: nothing is sent, and the page says why
    {
      const { ctx, p, errs } = await formAt('cl19@test.com', { clock: true });
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900);
      await p.fill('#oTitle', 'Product film'); await p.fill('#oScope', 'Edit a 60-second film'); await p.fill('#oDeliv', 'MP4'); await p.fill('#oPrice', '100');
      await p.clock.fastForward(65000);
      const n0 = await p.evaluate(() => { window.__mockPricesFail = true; return window.__mockdb.contracts.length; });
      await p.click('#oSend'); await p.waitForTimeout(900);
      const r = await p.evaluate(() => ({ n: window.__mockdb.contracts.length, said: [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | '), btn: document.querySelector('#oSend') && !document.querySelector('#oSend').disabled }));
      ok(r.n === n0 && /could not be checked/.test(r.said) && r.btn && !errs.length, `the prices can't be checked at Send, the last answer 65 s old -> Orders sent: ${r.n - n0}; the page says: ${r.said.slice(-90) || 'nothing'}; Send usable again: ${r.btn} (must send nothing and say so)`);
      await ctx.close();
    }
    {
      const { ctx, p, errs } = await formAt('cl19b@test.com', {}, 'window.__mockPricesFail = true;');
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900);
      await p.fill('#oTitle', 'Product film'); await p.fill('#oScope', 'Edit a 60-second film'); await p.fill('#oDeliv', 'MP4'); await p.fill('#oPrice', '100');
      const n0 = await p.evaluate(() => window.__mockdb.contracts.length);
      await p.click('#oSend'); await p.waitForTimeout(900);
      const r = await p.evaluate(() => ({ n: window.__mockdb.contracts.length, said: [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | ') }));
      ok(r.n === n0 && /could not be checked/.test(r.said) && !errs.length, `the prices were never known on this page (every lookup failed) -> Orders sent: ${r.n - n0}; the page says: ${r.said.slice(-90) || 'nothing'} (must send nothing and say so)`);
      await ctx.close();
    }
    // 29. two price lookups answer in the wrong order (the older one last): the page keeps the newer answer
    {
      const { ctx, p, errs } = await open(b, P1, 'en');
      await p.evaluate(([p1, p2]) => { window.__mockPricesSeq = [{ p: p1, ms: 1200 }, { p: p2, ms: 100 }]; document.dispatchEvent(new Event('visibilitychange')); setTimeout(() => document.dispatchEvent(new Event('visibilitychange')), 50); }, [P1, P2]);
      await p.waitForTimeout(1800);
      const h = await home(p);
      ok(h.shown && !errs.length, `an older price answer (today's prices) arrives after a newer one (the new prices) -> the new-price block is ${h.shown ? 'shown' : 'hidden'} (must stay shown: the newer answer counts)`);
      await ctx.close();
    }
    // 30. Accept at the very moment the switch moves: the database answers "pricing_changed"; the page asks to read the Order again
    {
      const { ctx, p, errs } = await open(b, P1, 'en', 1400, 'window.__mockAcceptError = "pricing_changed";');
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl20@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl20@test.com', password: 'password123' }); });
      await p.waitForTimeout(600);
      await p.evaluate(() => { const db = window.__mockdb; const me = db.profiles.find(x => x.email === 'cl20@test.com'); me.rules_version = '2026-11'; const fl = '99999999-9999-4999-8999-999999999999';
        db.profiles.push({ id: fl, email: 'fl@test.com', first_name: 'Tom', role: 'editor', is_admin: false, banned: false, created_at: new Date().toISOString() });
        const conv = { id: '88888888-8888-4888-8888-888888888888', user_a: [me.id, fl].sort()[0], user_b: [me.id, fl].sort()[1], created_at: new Date().toISOString() }; db.conversations.push(conv);
        db.contracts.push({ id: '77777777-7777-4777-8777-777777777777', conversation_id: conv.id, editor: fl, client: me.id, proposed_by: fl, title: 'Product film', description: 'Edit a film', price: 100, currency: 'EUR', pricing: 'project',
          amount_cents: 10000, funded_cents: 0, released_cents: 0, refunded_cents: 0, payment_mode: 'escrow', status: 'proposed', revisions: 1, changes_used: 0, has_milestones: false, terms_version: 1, client_accepted_version: null,
          freelancer_accepted_version: 1, pricing_version: 1, commission_bps: 0, commission_cents: 0, auto_days: 7, created_at: new Date().toISOString() }); });
      await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); });
      await p.goto(url + '#contracts'); await p.waitForTimeout(900); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.locator('.c-row').first().click(); await p.waitForTimeout(900);
      let said = '(no Accept button)';
      if (await p.locator('[data-caction="accept"]').count()) { await p.click('[data-caction="accept"]'); await p.waitForTimeout(800); said = await p.evaluate(() => [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | ')); }
      ok(/changed a moment ago/.test(said) && !/went wrong/i.test(said) && !errs.length, `Accept meets the switch moving at that moment ("pricing_changed") -> the page says: ${said.slice(-90) || 'nothing'} (must ask to read the Order again)`);
      await ctx.close();
    }
    // 31. Orders paid directly under the new prices: no €2 minimum (€1.50 is sent) and a delivery needs no link
    {
      const { ctx, p, errs } = await open(b, P2, 'en', 1400, seed2);
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl21@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl21@test.com', password: 'password123' }); });
      await p.waitForTimeout(700);
      await p.evaluate(async () => { window.__mockEscrow = false; if (window.__reloadEscrow) await window.__reloadEscrow(); document.querySelector('#modalRoot').innerHTML = ''; });
      await p.goto(url + '#home'); await p.waitForTimeout(700); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.click('.real-card .message-person'); await p.waitForTimeout(900);
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900);
      await p.fill('#oTitle', 'Small cut'); await p.fill('#oScope', 'One short edit'); await p.fill('#oDeliv', 'MP4'); await p.fill('#oPrice', '1.50');
      const n0 = await p.evaluate(() => window.__mockdb.contracts.length);
      await p.click('#oSend'); await p.waitForTimeout(900);
      const r = await p.evaluate(() => ({ n: window.__mockdb.contracts.length, mode: (window.__mockdb.contracts.slice(-1)[0] || {}).payment_mode, said: [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | ') }));
      ok(r.n - n0 === 1 && r.mode === 'direct' && !/at least €2/.test(r.said) && !errs.length, `a €1.50 Order paid directly under the new prices -> ${r.n - n0} sent (${r.mode}); the page says: ${r.said.slice(-60) || 'nothing'} (must be sent, paid directly, no €2 message)`);
      await ctx.close();
    }
    {
      const { ctx, p, errs } = await open(b, P2, 'en');
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'fd@test.com', password: 'password123', options: { data: { first_name: 'Tom' } } }); await sb.auth.signInWithPassword({ email: 'fd@test.com', password: 'password123' }); });
      await p.waitForTimeout(600);
      await p.evaluate(() => { const db = window.__mockdb; const me = db.profiles.find(x => x.email === 'fd@test.com'); me.role = 'editor'; me.rules_version = '2026-11'; const cl = '99999999-9999-4999-8999-999999999999';
        db.profiles.push({ id: cl, email: 'cl@test.com', first_name: 'Lina', role: 'client', is_admin: false, banned: false, created_at: new Date().toISOString() });
        const conv = { id: '88888888-8888-4888-8888-888888888888', user_a: [me.id, cl].sort()[0], user_b: [me.id, cl].sort()[1], created_at: new Date().toISOString() }; db.conversations.push(conv);
        db.contracts.push({ id: '77777777-7777-4777-8777-777777777777', conversation_id: conv.id, editor: me.id, client: cl, proposed_by: cl, title: 'Product film', description: 'Edit a film', price: 100, currency: 'EUR', pricing: 'project',
          amount_cents: 10000, funded_cents: 0, released_cents: 0, refunded_cents: 0, payment_mode: 'direct', status: 'paid', revisions: 1, changes_used: 0, has_milestones: false, terms_version: 1, client_accepted_version: 1, freelancer_accepted_version: 1,
          accepted_at: new Date().toISOString(), pricing_version: 2, commission_bps: 0, commission_cents: 0, auto_days: 14, created_at: new Date().toISOString() }); });
      await p.goto(url + '#contracts'); await p.waitForTimeout(900); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.locator('.c-row').first().click(); await p.waitForTimeout(800);
      let st = '(no Deliver button)';
      if (await p.locator('[data-caction="deliver"]').count()) { await p.click('[data-caction="deliver"]'); await p.waitForTimeout(400); await p.click('#onGo'); await p.waitForTimeout(600); st = await p.evaluate(() => window.__mockdb.contracts[0].delivered_at ? 'delivered' : 'not delivered'); }
      ok(st === 'delivered' && !errs.length, `a new-price Order paid directly, delivered without a link -> ${st} (must be delivered: Cuvori pays nothing out on it)`);
      await ctx.close();
    }
    // 32-37. Send and the prices: what the form was opened with is what Send compares against
    const fillForm = async (p, price = '100') => { await p.fill('#oTitle', 'Product film'); await p.fill('#oScope', 'Edit a 60-second film'); await p.fill('#oDeliv', 'MP4'); await p.fill('#oPrice', price); };
    // Send, if the form is still open (an Order sent closes it)
    const press = async (p) => { if (await p.locator('#oSend').count()) await p.click('#oSend', { timeout: 5000 }).catch(() => {}); };
    const sent = (p) => p.evaluate(() => ({ n: window.__mockdb.contracts.length, said: [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | ') }));
    // 32. the switch moves while the tab is in the background: coming back redraws the note quietly; the first Send says
    //     the prices changed and sends nothing, the next one sends
    {
      const { ctx, p, errs } = await formAt('cl22@test.com');
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900); await fillForm(p);
      const n0 = await p.evaluate((pr) => { window.__mockPrices = pr; document.dispatchEvent(new Event('visibilitychange')); return window.__mockdb.contracts.length; }, P2);
      await p.waitForTimeout(700);
      const note = await p.evaluate(() => (document.querySelector('#oModeNote') || {}).textContent || '');
      await press(p); await p.waitForTimeout(900); const first = await sent(p);
      await press(p); await p.waitForTimeout(900); const second = await sent(p);
      ok(/5% commission/.test(note) && first.n === n0 && /prices changed while this form was open/.test(first.said) && second.n - n0 === 1 && !errs.length,
        `the switch moved while the tab was away, the note redrawn quietly (${note.slice(0, 40)}), then Send -> ${first.n - n0} sent, the page says: ${first.said.slice(-80) || 'nothing'}; Send again -> ${second.n - n0} sent (must be 0 with the message, then 1)`);
      await ctx.close();
    }
    // 33. a slow network (every price lookup takes 4 s): an answer from the last minute is enough, so Send still works
    {
      const { ctx, p, errs } = await formAt('cl23@test.com');
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900); await fillForm(p);
      const n0 = await p.evaluate(() => { window.__mockPricesDelayMs = 4000; return window.__mockdb.contracts.length; });
      await press(p); await p.waitForTimeout(4500); const r = await sent(p);
      ok(r.n - n0 === 1 && !/could not be checked/.test(r.said) && !errs.length, `every price lookup takes 4 s, the form's own answer is seconds old -> Send: ${r.n - n0} sent; the page says: ${r.said.slice(-80) || 'nothing'} (must send 1)`);
      await ctx.close();
    }
    {
      const { ctx, p, errs } = await formAt('cl23b@test.com', { clock: true });
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900); await fillForm(p);
      await p.clock.fastForward(65000);
      const n0 = await p.evaluate(() => { window.__mockPricesDelayMs = 4000; return window.__mockdb.contracts.length; });
      await press(p); await p.waitForTimeout(4500); const first = await sent(p);
      await press(p); await p.waitForTimeout(3700); const second = await sent(p);
      ok(first.n === n0 && /could not be checked/.test(first.said) && second.n - n0 === 1 && !errs.length,
        `every lookup takes 4 s and the last answer is 65 s old -> first Send: ${first.n - n0} sent (${first.said.slice(-50) || 'nothing'}); its answer lands, Send again -> ${second.n - n0} sent (must be 0 with the message, then 1)`);
      await ctx.close();
    }
    // 34. Send's own lookup answers with the new prices while a newer lookup (the tab came back) is still on its way: the
    //     answer counts, so nothing is sent on prices the form never showed
    {
      const { ctx, p, errs } = await formAt('cl25@test.com');
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900); await fillForm(p);
      // the fake database is at plan 2 too, as the lookups say (it would take the Order: only the page's own check stops it)
      const n0 = await p.evaluate((pr) => { window.__mockPrices = pr; window.__mockPricesSeq = [{ p: pr, ms: 800 }, { p: pr, ms: 30000 }]; return window.__mockdb.contracts.length; }, P2);
      await press(p); await p.waitForTimeout(100); await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await p.waitForTimeout(1500); const r = await sent(p);
      ok(r.n === n0 && /prices changed while this form was open/.test(r.said) && !errs.length, `Send's lookup answers "new prices" while a newer lookup is still out -> ${r.n - n0} sent; the page says: ${r.said.slice(-80) || 'nothing'} (must send nothing and say the prices changed)`);
      await ctx.close();
    }
    // 35. the page still has the new prices from last time (the switch was moved back, the lookup was slow when the form
    //     opened): a €1.50 Order is checked against the prices read at Send, not refused with the old €2
    {
      const o = await open(b, P1, 'en', 1400, seed2 + 'window.__mockPricesHang = true;', { cached: P2 });
      const { ctx, p, errs } = o;
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl26@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl26@test.com', password: 'password123' }); });
      await p.waitForTimeout(700);
      await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); document.querySelector('#modalRoot').innerHTML = ''; });
      await p.goto(url + '#home'); await p.waitForTimeout(700); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.click('.real-card .message-person'); await p.waitForTimeout(900);
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(3600); await fillForm(p, '1.50');
      const n0 = await p.evaluate(() => { window.__mockPricesHang = false; return window.__mockdb.contracts.length; });
      await press(p); await p.waitForTimeout(900); const first = await sent(p);
      await press(p); await p.waitForTimeout(900); const second = await sent(p);
      ok(!/at least €2/.test(second.said) && second.n - n0 === 1 && !errs.length, `the page on last time's new prices (switched back since), a €1.50 Order, Send twice -> ${second.n - n0} sent; the page said: ${second.said.slice(-110) || 'nothing'} (must never say "at least €2", and send it)`);
      await ctx.close();
    }
    // 36. a first visit on a slow network: the form opens before the first price answer, which then says today's prices.
    //     That is no change for the person (the same note), so Send does not stop with "the prices changed"
    {
      const { ctx, p, errs } = await formAt('cl27@test.com', {}, 'window.__mockPricesDelayMs = 8000;');
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(3600);
      await p.waitForTimeout(2500); await fillForm(p);
      const n0 = await p.evaluate(() => window.__mockdb.contracts.length);
      await press(p); await p.waitForTimeout(3600); const r = await sent(p);
      ok(r.n - n0 === 1 && !/prices changed/.test(r.said) && !errs.length, `a first visit, the form opened before the first price answer (today's prices) -> Send: ${r.n - n0} sent; the page says: ${r.said.slice(-80) || 'nothing'} (must send, with no "prices changed")`);
      await ctx.close();
    }
    // 37. the form is closed while Send waits for the prices: nothing is sent
    {
      const { ctx, p, errs } = await formAt('cl28@test.com');
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900); await fillForm(p);
      const n0 = await p.evaluate(() => { window.__mockPricesDelayMs = 1500; return window.__mockdb.contracts.length; });
      await press(p); await p.waitForTimeout(300);
      const waiting = await p.evaluate(() => !!document.querySelector('#oSend') && document.querySelector('#oSend').disabled);   // Send really was pressed and is waiting
      await p.click('.modal .close-x', { timeout: 3000 }).catch(() => {});
      await p.waitForTimeout(3500); const r = await sent(p); const closed = await p.evaluate(() => !document.querySelector('#oSend'));
      ok(waiting && closed && r.n === n0 && !errs.length, `the form closed while Send waits for the prices (Send waiting: ${waiting}, form closed: ${closed}) -> ${r.n - n0} sent (must be 0)`);
      await ctx.close();
    }
    // 38. Accept re-prices an Order (the switch moved): its chat card says Cuvori's prices changed, not that the person changed it
    {
      const { ctx, p, errs } = await formAt('cl29@test.com');
      await p.evaluate(() => { const db = window.__mockdb; const me = db.profiles.find(x => x.email === 'cl29@test.com'); const cv = db.conversations.find(c => c.user_a === me.id || c.user_b === me.id);
        db.messages.push({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', conversation_id: cv.id, sender: me.id, kind: 'contract', body: 'Product film',
          payload: { contract_id: '77777777-7777-4777-8777-777777777777', event: 'prices_changed', title: 'Product film', price: 100, currency: 'EUR', pricing: 'project', status: 'proposed', amount_cents: 10000 }, created_at: new Date().toISOString() }); });
      await p.click('.chat-window .chat-head .close');
      await p.waitForTimeout(300); await p.click('.real-card .message-person'); await p.waitForTimeout(900);
      const line = await p.evaluate(() => [...document.querySelectorAll('.chat-window .contract-card .cc-line')].map(x => x.textContent).join(' | '));
      ok(/Cuvori's prices changed/.test(line) && !/New Order/.test(line) && !errs.length, `the chat card of an Order Accept re-priced -> ${line || 'no card'} (must say Cuvori's prices changed)`);
      await ctx.close();
    }
    // 39. the switch moves in the minute after the form's prices were read, and the network is slow: Send uses that recent
    //     answer, and the database refuses the Order because the form showed other prices; the page says so
    {
      const { ctx, p, errs } = await formAt('cl30@test.com');
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900); await fillForm(p);
      const n0 = await p.evaluate((pr) => { window.__mockPrices = pr; window.__mockPricesDelayMs = 4000; return window.__mockdb.contracts.length; }, P2);
      const calls0 = await p.evaluate(() => (window.__mockCalls || {}).order_create_at_prices || 0);
      await press(p); await p.waitForTimeout(7500); const r = await sent(p);
      const calls = await p.evaluate((c) => ((window.__mockCalls || {}).order_create_at_prices || 0) - c, calls0);
      ok(r.n === n0 && calls === 1 && /could not be checked|prices changed while this form was open/.test(r.said) && !errs.length, `the switch moved seconds after the form read the prices, every lookup slow -> ${r.n - n0} sent (the database asked ${calls} time); the page says: ${r.said.slice(-80) || 'nothing'} (must send nothing: the database refuses prices the form did not show)`);
      // ... the new prices then arrive: the next Send says they changed (the note shows them now), the one after sends
      await p.evaluate(() => document.querySelectorAll('.toast').forEach(x => x.remove()));
      await press(p); await p.waitForTimeout(4500); const second = await sent(p);
      const note = await p.evaluate(() => (document.querySelector('#oModeNote') || {}).textContent || '');
      await press(p); await p.waitForTimeout(4500); const third = await sent(p);
      ok(second.n === n0 && /prices changed while this form was open/.test(second.said) && /5% commission/.test(note) && third.n - n0 === 1 && !errs.length,
        `after the refusal, Send again -> ${second.n - n0} sent (${second.said.slice(-50) || 'nothing'}), the note: ${note.slice(0, 40)}; and again -> ${third.n - n0} sent (must be 0 with "prices changed" and the 5% note, then 1)`);
      await ctx.close();
    }
    // 40. under the new prices, the payment check had not answered while the form was open (no note under it): Send shows
    //     the note (with the 5%) first and sends nothing until the person has read it
    {
      const { ctx, p, errs } = await formAt('cl31@test.com', {}, `window.__mockStatusDown = true; window.__mockPrices = ${JSON.stringify(P2)};`);
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900); await fillForm(p);
      const blank = await p.evaluate(() => (document.querySelector('#oModeNote') || {}).textContent || '');
      const n0 = await p.evaluate(() => { window.__mockStatusDown = false; return window.__mockdb.contracts.length; });
      await press(p); await p.waitForTimeout(1200); const first = await sent(p);
      const note = await p.evaluate(() => (document.querySelector('#oModeNote') || {}).textContent || '');
      await press(p); await p.waitForTimeout(1200); const second = await sent(p);
      ok(blank === '' && first.n === n0 && /Read the note below the form/.test(first.said) && /5% commission/.test(note) && second.n - n0 === 1 && !errs.length,
        `no note while the payment check was down (${blank === '' ? 'empty' : blank.slice(0, 30)}), then Send -> ${first.n - n0} sent, the page says: ${first.said.slice(-60) || 'nothing'}, the note now: ${note.slice(0, 50)}; Send again -> ${second.n - n0} sent (must be 0 with the message and the 5% note, then 1)`);
      await ctx.close();
    }
    // 41. while Send waits, the form can't be changed (what is sent is what the person saw); after a refused Send it can
    {
      const { ctx, p, errs } = await formAt('cl32@test.com');
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900); await fillForm(p);
      // two parts, €40 and €60, so the parts' own fields and remove buttons are there too
      await p.check('#oMsOn'); await p.waitForTimeout(200);
      await p.evaluate(() => { const rows = [...document.querySelectorAll('.o-ms-row')]; [['Part 1', 40], ['Part 2', 60]].forEach(([t, a], i) => { const r = rows[i]; r.querySelector('.o-ms-title').value = t; r.querySelector('.o-ms-amt').value = a; }); document.querySelector('.modal-body').dispatchEvent(new Event('input', { bubbles: true })); });
      const n0 = await p.evaluate(() => { window.__mockPricesDelayMs = 1500; return window.__mockdb.contracts.length; });
      await press(p); await p.waitForTimeout(300);
      const open = await p.evaluate(() => [...document.querySelectorAll('.modal-body input, .modal-body textarea, .modal-body select, .modal-body #oMsAdd, .modal-body .o-ms-x')].filter(x => !x.disabled).map(x => x.id || x.name || x.className || x.type));
      await p.waitForTimeout(2500); const r = await sent(p);
      ok(open.length === 0 && r.n - n0 === 1 && !errs.length, `while Send waits for the prices, fields that can still be changed: ${open.join(', ') || 'none'} -> ${r.n - n0} sent (must be none, 1 sent)`);
      await ctx.close();
    }
    {
      const { ctx, p, errs } = await formAt('cl32b@test.com', {}, 'window.__mockPricesFail = true;');
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900); await fillForm(p);
      await press(p); await p.waitForTimeout(900);
      const open = await p.evaluate(() => ['#oPrice', '#oTitle', '#oSend'].every(s => document.querySelector(s) && !document.querySelector(s).disabled));
      ok(open && !errs.length, `after a Send that could not check the prices, the form can be changed and sent again: ${open} (must be true)`);
      await ctx.close();
    }
    // 42. an Order paid directly: the switch moving changes nothing on it, so Send sends it (no "the prices changed")
    {
      const { ctx, p, errs } = await open(b, P1, 'en', 1400, seed2);
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl33@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl33@test.com', password: 'password123' }); });
      await p.waitForTimeout(700);
      await p.evaluate(async () => { window.__mockEscrow = false; if (window.__reloadEscrow) await window.__reloadEscrow(); document.querySelector('#modalRoot').innerHTML = ''; });
      await p.goto(url + '#home'); await p.waitForTimeout(700); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.click('.real-card .message-person'); await p.waitForTimeout(900);
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900); await fillForm(p);
      const n0 = await p.evaluate((pr) => { window.__mockPrices = pr; return window.__mockdb.contracts.length; }, P2);
      await press(p); await p.waitForTimeout(900); const r = await sent(p);
      const mode = await p.evaluate(() => (window.__mockdb.contracts.slice(-1)[0] || {}).payment_mode);
      const named = await p.evaluate(() => ((window.__mockLastArgs || {}).order_create_at_prices || {}).p_pricing_version);
      ok(r.n - n0 === 1 && mode === 'direct' && named === null && !/prices changed/.test(r.said) && !errs.length, `an Order paid directly, the switch moved while its form was open -> ${r.n - n0} sent (${mode}, plan named: ${named}); the page says: ${r.said.slice(-60) || 'nothing'} (must send it naming no plan, no "prices changed")`);
      await ctx.close();
    }
    // 43. a proposal's change form is closed while Save waits for the prices: nothing is saved
    {
      const { ctx, p, errs } = await open(b, P1, 'en');
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl34@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl34@test.com', password: 'password123' }); });
      await p.waitForTimeout(600);
      await p.evaluate(() => { const db = window.__mockdb; const me = db.profiles.find(x => x.email === 'cl34@test.com'); const fl = '99999999-9999-4999-8999-999999999999';
        db.profiles.push({ id: fl, email: 'fl@test.com', first_name: 'Tom', role: 'editor', is_admin: false, banned: false, created_at: new Date().toISOString() });
        const conv = { id: '88888888-8888-4888-8888-888888888888', user_a: [me.id, fl].sort()[0], user_b: [me.id, fl].sort()[1], created_at: new Date().toISOString() }; db.conversations.push(conv);
        db.contracts.push({ id: '77777777-7777-4777-8777-777777777777', conversation_id: conv.id, editor: fl, client: me.id, proposed_by: me.id, title: 'Product film', description: 'Edit a film', price: 100, currency: 'EUR', pricing: 'project',
          amount_cents: 10000, funded_cents: 0, released_cents: 0, refunded_cents: 0, payment_mode: 'escrow', status: 'proposed', revisions: 1, changes_used: 0, has_milestones: false, terms_version: 1, client_accepted_version: 1,
          freelancer_accepted_version: null, pricing_version: 1, commission_bps: 0, commission_cents: 0, auto_days: 7, created_at: new Date().toISOString() }); });
      await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); });
      await p.goto(url + '#contracts'); await p.waitForTimeout(900); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.locator('.c-row').first().click(); await p.waitForTimeout(900);
      let r = { waiting: false, title: '(no Edit button)', v: 0 };
      if (await p.locator('[data-caction="edit"]').count()) {
        await p.click('[data-caction="edit"]'); await p.waitForTimeout(900);
        await p.fill('#oTitle', 'Changed title'); await p.evaluate(() => { window.__mockPricesDelayMs = 1500; });
        await press(p); await p.waitForTimeout(300);
        const waiting = await p.evaluate(() => !!document.querySelector('#oSend') && document.querySelector('#oSend').disabled);
        await p.click('.modal .close-x', { timeout: 3000 }).catch(() => {}); await p.waitForTimeout(3500);
        r = { waiting, ...(await p.evaluate(() => ({ title: window.__mockdb.contracts[0].title, v: window.__mockdb.contracts[0].terms_version }))) };
      }
      ok(r.waiting && r.title === 'Product film' && r.v === 1 && !errs.length, `a proposal's change form closed while Save waits (Save waiting: ${r.waiting}) -> its title: ${r.title}, version ${r.v} (must be unchanged: Product film, 1)`);
      await ctx.close();
    }
    // 44. Accept answers "rules_not_accepted": the rules pop-up opens, also after the person closed it with × when they
    //     signed in (they can accept the rules right there)
    {
      const { ctx, p, errs } = await open(b, P2, 'en', 1400, 'window.__mockAcceptAnswer = "rules_not_accepted";');
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl35@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl35@test.com', password: 'password123' }); });
      await p.waitForTimeout(900);
      const askedAtSignIn = await p.evaluate(() => !!document.querySelector('#raYes'));
      if (askedAtSignIn) { await p.click('.modal .close-x', { timeout: 3000 }).catch(() => {}); await p.waitForTimeout(300); }
      await p.evaluate(() => { const db = window.__mockdb; const me = db.profiles.find(x => x.email === 'cl35@test.com'); me.rules_version = '2026-08'; const fl = '99999999-9999-4999-8999-999999999999';
        db.profiles.push({ id: fl, email: 'fl@test.com', first_name: 'Tom', role: 'editor', is_admin: false, banned: false, created_at: new Date().toISOString() });
        const conv = { id: '88888888-8888-4888-8888-888888888888', user_a: [me.id, fl].sort()[0], user_b: [me.id, fl].sort()[1], created_at: new Date().toISOString() }; db.conversations.push(conv);
        db.contracts.push({ id: '77777777-7777-4777-8777-777777777777', conversation_id: conv.id, editor: fl, client: me.id, proposed_by: fl, title: 'Product film', description: 'Edit a film', price: 100, currency: 'EUR', pricing: 'project',
          amount_cents: 10000, funded_cents: 0, released_cents: 0, refunded_cents: 0, payment_mode: 'escrow', status: 'proposed', revisions: 1, changes_used: 0, has_milestones: false, terms_version: 2, client_accepted_version: null,
          freelancer_accepted_version: 2, pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14, created_at: new Date().toISOString() }); });
      await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); });
      await p.goto(url + '#contracts'); await p.waitForTimeout(900);
      await p.evaluate(() => { if (!document.querySelector('#raYes')) document.querySelector('#modalRoot').innerHTML = ''; });
      if (await p.locator('#raYes').count()) { await p.click('.modal .close-x', { timeout: 3000 }).catch(() => {}); await p.waitForTimeout(300); }
      await p.locator('.c-row').first().click(); await p.waitForTimeout(900);
      let asked = '(no Accept button)';
      if (await p.locator('[data-caction="accept"]').count()) { await p.click('[data-caction="accept"]'); await p.waitForTimeout(900); asked = (await p.locator('#raYes').count()) ? 'the rules pop-up' : 'only a message'; }
      ok(askedAtSignIn && asked === 'the rules pop-up' && !errs.length, `the rules pop-up at sign-in closed with × (${askedAtSignIn ? 'it was shown' : 'it was NOT shown'}), then Accept answers "rules_not_accepted" -> ${asked} (must open the rules pop-up)`);
      await ctx.close();
    }
    // 45. Send pressed twice while sending the Order itself takes a moment (a real network): one Order, no error
    {
      const { ctx, p, errs } = await formAt('cl36@test.com', {}, 'window.__mockCreateDelayMs = 600;');
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900); await fillForm(p);
      const n0 = await p.evaluate(() => window.__mockdb.contracts.length);
      const c0 = await p.evaluate(() => (window.__mockCalls || {}).order_create_at_prices || 0);
      await press(p); await p.waitForTimeout(150); await p.click('#oSend', { force: true, timeout: 2000 }).catch(() => {}); await p.waitForTimeout(1500);
      const r = await sent(p); const calls = await p.evaluate((c) => ((window.__mockCalls || {}).order_create_at_prices || 0) - c, c0);
      ok(r.n - n0 === 1 && calls === 1 && !/already|went wrong/i.test(r.said) && !errs.length, `Send pressed twice while the Order takes 0.6 s to send -> ${r.n - n0} sent, ${calls} request(s) to send it; the page says: ${r.said.slice(-80) || 'nothing'} (must send one, with one request, no error)`);
      await ctx.close();
    }
    // 46. the page keeps the prices it was told for the next visit (so a returning visitor sees them at once)
    {
      const { ctx, p, errs } = await open(b, P2, 'en');
      const kept = await p.evaluate(() => { try { return JSON.parse(localStorage.getItem('cuvoriPrices') || 'null'); } catch (e) { return null; } });
      ok(kept && kept.version === 2 && kept.commission_bps === 500 && kept.review_days === 14 && kept.min_project_cents === 200 && !errs.length, `the prices kept for the next visit -> ${JSON.stringify(kept)} (must be plan 2: 500, 14 days, €2)`);
      await ctx.close();
    }
    // 47. before v56 (or after it was undone) the page sends Orders the old way, without the prices check
    {
      const o = await open(b, null, 'en', 1400, seed2); const { ctx, p, errs } = o;
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl37@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl37@test.com', password: 'password123' }); });
      await p.waitForTimeout(700);
      await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); document.querySelector('#modalRoot').innerHTML = ''; });
      await p.goto(url + '#home'); await p.waitForTimeout(700); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.click('.real-card .message-person'); await p.waitForTimeout(900);
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900); await fillForm(p);
      const n0 = await p.evaluate(() => window.__mockdb.contracts.length);
      await press(p); await p.waitForTimeout(900); const r = await sent(p);
      ok(r.n - n0 === 1 && !errs.length, `no prices in the database (before v56), Send -> ${r.n - n0} sent; the page says: ${r.said.slice(-60) || 'nothing'} (must send it)`);
      await ctx.close();
    }
    // 48. the form is closed after the Order has gone out (sending it takes 2 s): it is sent, and the page says so
    {
      const { ctx, p, errs } = await formAt('cl38@test.com', {}, 'window.__mockCreateDelayMs = 2000;');
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900); await fillForm(p);
      const n0 = await p.evaluate(() => window.__mockdb.contracts.length);
      await press(p); await p.waitForTimeout(500);
      const out = await p.evaluate(() => ((window.__mockCalls || {}).order_create_at_prices || 0) > 0);   // the Order has gone out
      await p.click('.modal .close-x', { timeout: 3000 }).catch(() => {}); const closed = await p.evaluate(() => !document.querySelector('#oSend'));
      await p.waitForTimeout(2500); const r = await sent(p);
      ok(out && closed && r.n - n0 === 1 && /Order sent/.test(r.said) && !errs.length, `the form closed (${closed}) after the Order went out (it had: ${out}) -> ${r.n - n0} sent; the page says: ${r.said.slice(-60) || 'nothing'} (must be sent and say "Order sent")`);
      await ctx.close();
    }
    // 49. a proposal at today's prices is changed after the switch moved, on a slow network: the database refuses the change
    //     (its form showed today's prices); nothing is saved and the page says why
    {
      const { ctx, p, errs } = await open(b, P1, 'en');
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl39@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl39@test.com', password: 'password123' }); });
      await p.waitForTimeout(600);
      await p.evaluate(() => { const db = window.__mockdb; const me = db.profiles.find(x => x.email === 'cl39@test.com'); const fl = '99999999-9999-4999-8999-999999999999';
        db.profiles.push({ id: fl, email: 'fl@test.com', first_name: 'Tom', role: 'editor', is_admin: false, banned: false, created_at: new Date().toISOString() });
        const conv = { id: '88888888-8888-4888-8888-888888888888', user_a: [me.id, fl].sort()[0], user_b: [me.id, fl].sort()[1], created_at: new Date().toISOString() }; db.conversations.push(conv);
        db.contracts.push({ id: '77777777-7777-4777-8777-777777777777', conversation_id: conv.id, editor: fl, client: me.id, proposed_by: me.id, title: 'Product film', description: 'Edit a film', price: 100, currency: 'EUR', pricing: 'project',
          amount_cents: 10000, funded_cents: 0, released_cents: 0, refunded_cents: 0, payment_mode: 'escrow', status: 'proposed', revisions: 1, changes_used: 0, has_milestones: false, terms_version: 1, client_accepted_version: 1,
          freelancer_accepted_version: null, pricing_version: 1, commission_bps: 0, commission_cents: 0, auto_days: 7, created_at: new Date().toISOString() }); });
      await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); });
      await p.goto(url + '#contracts'); await p.waitForTimeout(900); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.locator('.c-row').first().click(); await p.waitForTimeout(900);
      let r = { v: 0, said: '(no Edit button)', asked: 0, plan: undefined };
      if (await p.locator('[data-caction="edit"]').count()) {
        await p.click('[data-caction="edit"]'); await p.waitForTimeout(900);
        await p.fill('#oTitle', 'Changed title');
        await p.evaluate((pr) => { window.__mockPrices = pr; window.__mockPricesDelayMs = 4000; }, P2);
        await press(p); await p.waitForTimeout(7500);
        r = await p.evaluate(() => ({ v: window.__mockdb.contracts[0].terms_version, said: [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | '),
          asked: (window.__mockCalls || {}).order_update_at_prices || 0, plan: ((window.__mockLastArgs || {}).order_update_at_prices || {}).p_pricing_version }));
      }
      ok(r.v === 1 && r.asked === 1 && r.plan === 1 && /could not be checked|prices changed/.test(r.said) && !errs.length, `a proposal changed in a form that showed today's prices, after the switch moved -> version ${r.v}, the database asked ${r.asked} time naming plan ${r.plan}; the page says: ${r.said.slice(-70) || 'nothing'} (must stay version 1, the database asked with plan 1, and the page say why)`);
      await ctx.close();
    }
    // 50. an Order paid directly while the prices can't be checked: nothing on it depends on them, so it is sent
    {
      const { ctx, p, errs } = await open(b, P1, 'en', 1400, seed2 + 'window.__mockPricesFail = true;');
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl40@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl40@test.com', password: 'password123' }); });
      await p.waitForTimeout(700);
      await p.evaluate(async () => { window.__mockEscrow = false; if (window.__reloadEscrow) await window.__reloadEscrow(); document.querySelector('#modalRoot').innerHTML = ''; });
      await p.goto(url + '#home'); await p.waitForTimeout(700); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.click('.real-card .message-person'); await p.waitForTimeout(900);
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900); await fillForm(p);
      const n0 = await p.evaluate(() => window.__mockdb.contracts.length);
      await press(p); await p.waitForTimeout(900); const r = await sent(p);
      ok(r.n - n0 === 1 && !/could not be checked/.test(r.said) && !errs.length, `an Order paid directly, the prices can't be checked -> ${r.n - n0} sent; the page says: ${r.said.slice(-60) || 'nothing'} (must send it)`);
      await ctx.close();
    }
    // 51. Send pressed with the keyboard and refused: the keyboard stays on Send (no starting again from the top of the page)
    {
      const { ctx, p, errs } = await formAt('cl41@test.com', {}, 'window.__mockPricesFail = true;');
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900); await fillForm(p);
      await p.focus('#oSend'); await p.keyboard.press('Enter'); await p.waitForTimeout(900);
      const r = await p.evaluate(() => ({ on: document.activeElement && document.activeElement.id, said: [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | ') }));
      ok(r.on === 'oSend' && /could not be checked/.test(r.said) && !errs.length, `Send pressed with Enter and refused (${r.said.slice(-40) || 'nothing'}) -> the keyboard is on: ${r.on || 'the page'} (must stay on Send)`);
      await ctx.close();
    }
    // 52. at today's prices, the payment check had not answered while the form was open; Send's own check answers but Send
    //     is refused for another reason (€0.50): the note is shown now, so the next Send is not sent unseen
    {
      const { ctx, p, errs } = await formAt('cl42@test.com', {}, 'window.__mockStatusDown = true;');
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900); await fillForm(p, '0.50');
      const blank = await p.evaluate(() => { window.__mockStatusDown = false; return (document.querySelector('#oModeNote') || {}).textContent || ''; });
      await press(p); await p.waitForTimeout(1200);
      const r = await p.evaluate(() => ({ note: (document.querySelector('#oModeNote') || {}).textContent || '', said: [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | ') }));
      ok(blank === '' && /at least €1/.test(r.said) && /Payment is protected/.test(r.note) && !errs.length, `the note empty while the payment check was down (${blank ? 'not empty' : 'empty'}); Send at €0.50 -> ${r.said.slice(-40) || 'nothing'}; the note now: ${r.note.slice(0, 40) || 'still empty'} (must say "at least €1" and show the note)`);
      await ctx.close();
    }
    // 53. the form is closed while its Order is on its way, and the database refuses it because the prices changed: the page
    //     says nothing was sent (the person may think it went out)
    {
      const { ctx, p, errs } = await formAt('cl43@test.com', {}, 'window.__mockCreateDelayMs = 1500;');
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900); await fillForm(p);
      // Send still reads today's prices, while the database has just switched to the new ones
      const n0 = await p.evaluate(([p1, p2]) => { window.__mockPricesSeq = [{ p: p1, ms: 50 }]; window.__mockPrices = p2; return window.__mockdb.contracts.length; }, [P1, P2]);
      await press(p); await p.waitForTimeout(500);
      const out = await p.evaluate(() => ((window.__mockCalls || {}).order_create_at_prices || 0) > 0);
      await p.click('.modal .close-x', { timeout: 3000 }).catch(() => {}); const closed = await p.evaluate(() => !document.querySelector('#oSend'));
      await p.waitForTimeout(2000); const r = await sent(p);
      ok(out && closed && r.n === n0 && /nothing was sent/.test(r.said) && !errs.length, `the form closed (${closed}) while its Order was on its way (${out}), refused because the prices changed -> ${r.n - n0} sent; the page says: ${r.said.slice(-70) || 'nothing'} (must say nothing was sent)`);
      await ctx.close();
    }
    // 54. no v56 (or after undo): a form closed while the first, failing request is on its way sends nothing; and once the
    //     page knows the new functions are not there, it no longer asks for them
    {
      const startNoV56 = async (email, extra = '') => {
        const o = await open(b, null, 'en', 1400, seed2 + extra); const { p } = o;
        await p.evaluate(async (em) => { const sb = window.__sb; await sb.auth.signUp({ email: em, password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: em, password: 'password123' }); }, email);
        await p.waitForTimeout(700);
        await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); document.querySelector('#modalRoot').innerHTML = ''; });
        await p.goto(url + '#home'); await p.waitForTimeout(700); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
        await p.click('.real-card .message-person'); await p.waitForTimeout(900);
        await p.click('.chat-window .open-contract'); await p.waitForTimeout(900); await fillForm(p);
        return o;
      };
      {
        const { ctx, p, errs } = await startNoV56('cl44@test.com', 'window.__mockCreateDelayMs = 1500;');
        const n0 = await p.evaluate(() => window.__mockdb.contracts.length);
        await press(p); await p.waitForTimeout(500); await p.click('.modal .close-x', { timeout: 3000 }).catch(() => {});
        await p.waitForTimeout(3000);
        const r = await p.evaluate(() => ({ n: window.__mockdb.contracts.length, old: (window.__mockCalls || {}).order_create || 0 }));
        ok(r.n === n0 && r.old === 0 && !errs.length, `no v56, the form closed while the first request was on its way -> ${r.n - n0} sent, the old way asked ${r.old} time(s) (must be 0, 0)`);
        await ctx.close();
      }
      {
        const { ctx, p, errs } = await startNoV56('cl45@test.com');
        await press(p); await p.waitForTimeout(1200);
        const first = await p.evaluate(() => ({ ...(window.__mockCalls || {}) }));
        // the Order is open now (proposed): its change form, saved
        await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; }); await p.goto(url + '#contracts'); await p.waitForTimeout(900);
        await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
        let calls = { at: -1, old: -1 };
        // clicked from the page itself: the chat window, still open on the right, lies over the list
        await p.evaluate(() => document.querySelector('.c-row').click()); await p.waitForTimeout(900);
        if (await p.locator('[data-caction="edit"]').count()) {
          await p.click('[data-caction="edit"]'); await p.waitForTimeout(900); await p.fill('#oTitle', 'Changed title'); await press(p); await p.waitForTimeout(1500);
          calls = await p.evaluate(() => ({ at: (window.__mockCalls || {}).order_update_at_prices || 0, old: (window.__mockCalls || {}).order_update || 0 }));
        }
        ok(first.order_create_at_prices === 1 && first.order_create === 1 && calls.at === 0 && calls.old === 1 && !errs.length, `no v56: the first Order asks the new way once (${first.order_create_at_prices}), then the old way (${first.order_create}); a change after it -> new way ${calls.at}, old way ${calls.old} (must be 1, 1; then 0, 1)`);
        await ctx.close();
      }
    }
    // 55. no v56, the payment check had not answered while the form was open, and it answers with other review days than 7:
    //     that is no price change, so the Order is sent with the same click as before
    {
      const o = await open(b, null, 'en', 1400, seed2 + 'window.__mockStatusDown = true; window.__mockAutoDays = 10;'); const { ctx, p, errs } = o;
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'cl46@test.com', password: 'password123', options: { data: { first_name: 'Lina' } } }); await sb.auth.signInWithPassword({ email: 'cl46@test.com', password: 'password123' }); });
      await p.waitForTimeout(700);
      await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow().catch(() => {}); document.querySelector('#modalRoot').innerHTML = ''; });
      await p.goto(url + '#home'); await p.waitForTimeout(700); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.click('.real-card .message-person'); await p.waitForTimeout(900);
      await p.click('.chat-window .open-contract'); await p.waitForTimeout(900); await fillForm(p);
      const n0 = await p.evaluate(() => { window.__mockStatusDown = false; return window.__mockdb.contracts.length; });
      await press(p); await p.waitForTimeout(1200); const r = await sent(p);
      ok(r.n - n0 === 1 && !/prices changed/.test(r.said) && !errs.length, `no v56, the payment check answers late with 10 review days -> ${r.n - n0} sent; the page says: ${r.said.slice(-60) || 'nothing'} (must send, no "prices changed")`);
      await ctx.close();
    }
  } catch (e) { log.push('CRASH ' + e.message); }
  await b.close();
  console.log(log.join('\n'));
  console.log(`\n${log.filter(l => l.startsWith('PASS')).length} passed, ${log.filter(l => !l.startsWith('PASS')).length} failed`);
  process.exit(log.some(l => !l.startsWith('PASS')) ? 1 : 0);
})();
