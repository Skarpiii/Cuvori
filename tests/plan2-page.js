// Orders at the new prices (plan 2: schema v56, pricing_version 2, paid through Cuvori) on the Order screen and in the
// admin panel. The client pays only the agreed price (no card-fee or payout-fee line), the freelancer receives the price
// minus 5% (rounded half up to the cent, on the running total of the payouts, as the database's pricing_commission and
// pricing_next_commission), 14 days to review a delivery, the admin's decision box gives the freelancer's share before
// the 5% and shows it in euros, and no "card cost not covered" for these Orders. An Order agreed before the switch
// (pricing_version 1 or empty) shows exactly today's texts and lines. Each Order follows its own plan, never the switch.
// Run: node tests/plan2-page.js   (from the repo folder; LANGS=en,de,ru to choose languages, default en and de)
//      BASE=/path/to/an/older/index.html node tests/plan2-page.js   also compares every plan 1 screen with that page
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const here = (f) => path.join(__dirname, '..', f);
const url = 'file://' + here('index.html');
const mock = fs.readFileSync(here('mock-supabase.js'), 'utf8');
const SRC = fs.readFileSync(here('index.html'), 'utf8');
const ALL = ['en', 'de', 'ru', 'lt', 'es', 'pl', 'uk'];
const RUN = (process.env.LANGS || 'en,de').split(',').filter(l => ALL.includes(l));
const log = []; const ok = (c, m) => log.push((c ? 'PASS ' : 'FAIL ') + m);
const P1 = { version: 1, commission_bps: 0, min_project_cents: 100, card_costs_paid_by: 'client', review_days: 7, rounding: 'half_up', currency: 'EUR', rules_version: null };
const P2 = { version: 2, commission_bps: 500, min_project_cents: 200, card_costs_paid_by: 'platform', review_days: 14, rounding: 'half_up', currency: 'EUR', rules_version: '2026-11' };

// a text from the page's own tables, exactly as written there (the last table that has it wins, as the page merges them)
const TABLES = [...SRC.matchAll(/\n {2}const (T(?:_[A-Z]+)?) = \{/g)].map(m => m[1]);
const textOf = (table, lang, key) => {
  const a = SRC.indexOf(`const ${table} = {`); if (a < 0) return null;
  const block = SRC.slice(a, SRC.indexOf('\n  };', a));
  const starts = ALL.map(l => [l, block.search(new RegExp(`\\n\\s+${l}:\\{`))]).filter(([, i]) => i >= 0).sort((x, y) => x[1] - y[1]);
  const i = starts.findIndex(([l]) => l === lang); if (i < 0) return null;
  const part = block.slice(starts[i][1], i + 1 < starts.length ? starts[i + 1][1] : block.length);
  const m = part.match(new RegExp(`[{,\\s]${key}:"((?:[^"\\\\]|\\\\.)*)"`)); return m ? JSON.parse('"' + m[1] + '"') : null;
};
const tx = (lang, key) => { let v = null; for (const tb of TABLES) { const x = textOf(tb, lang, key); if (x != null) v = x; } return v != null ? v : lang !== 'en' ? tx('en', key) : null; };
const fill = (s, vars) => Object.keys(vars).reduce((a, k) => a.split('{' + k + '}').join(vars[k]), s || '');
const NEW_KEYS = ['o2_commission', 'o2_flReceives', 'o2_youReceive', 'o2_payOnly', 'o2_fromPayout', 'o2_heldNote'];
// today's card-fee and payout-fee lines, and today's "no commission" notes: never on a plan 2 Order
const FEE_KEYS = ['o_processing', 'o_connect', 'o_cuvoriZero', 'o_processingHint', 'o_connectHint', 'o_quoteFailed'];
const FEE_WORDS = { en: /card fee|payout fee/i, de: /Kartengebühr|Auszahlungsgebühr/i, ru: /комиссия за карту|комиссия за выплату/i, lt: /kortelės mokestis|išmokėjimo mokestis/i, es: /comisión de tarjeta|comisión de pago/i, pl: /opłata za kartę|opłata za wypłatę/i, uk: /комісія за картку|комісія за виплату/i };
// today's "Cuvori fee €0.00" line: its label is a line of its own (in some languages "Cuvori fee" and "Cuvori's commission" are the same words)
const feeLeft = (lang, s) => [...FEE_KEYS.map(k => tx(lang, k)).filter(x => x && s.includes(x)), ...(s.split('\n').some(l => l.trim() === tx(lang, 'o_cuvoriFee')) ? [tx(lang, 'o_cuvoriFee') + ' (a line of its own)'] : []),
  ...[7, 14].map(n => fill(tx(lang, 'es_proposeNote'), { n })).filter(x => s.includes(x)), ...(FEE_WORDS[lang].test(s) ? [String(s.match(FEE_WORDS[lang])[0])] : [])];
const newLeft = (lang, s) => NEW_KEYS.map(k => [k, tx(lang, k)]).filter(([, v]) => s.includes(v.split('{')[0].trim() || v)).map(([k]) => k);

async function open(b, prices, lang, width, extra) {
  const ctx = await b.newContext({ viewport: { width: width || 1400, height: 900 } });
  await ctx.addInitScript(([pr, lg]) => { try { localStorage.setItem('cuvoriLanguage', lg); } catch (e) {} if (pr) window.__mockPrices = pr; }, [prices, lang]);
  if (extra) await ctx.addInitScript(extra);
  await ctx.addInitScript(mock);
  await ctx.route('**/supabase.min.js', r => r.fulfill({ status: 200, body: '/* mocked */', contentType: 'application/javascript' }));
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  return { ctx, p, errs };
}
const ID = '77777777-7777-4777-8777-777777777777', OTHER = '99999999-9999-4999-8999-999999999999';
// an Order as its client ("Lina") or its freelancer ("Tom") sees it. o.order overrides the Order's fields (a funded plan 2
// Order of €100 by default); o.ready: the freelancer's Stripe account can receive; o.ms: its parts; o.events: its history
async function orderPage(b, o) {
  const { ctx, p, errs } = await open(b, o.prices === undefined ? P2 : o.prices, o.lang, o.width, o.extra);
  await p.goto(o.page || url); await p.waitForTimeout(700);
  const fl = o.role === 'freelancer', email = fl ? 'fl@test.com' : 'cl@test.com';
  await p.evaluate(async ([em, nm]) => { const sb = window.__sb; await sb.auth.signUp({ email: em, password: 'password123', options: { data: { first_name: nm } } }); await sb.auth.signInWithPassword({ email: em, password: 'password123' }); }, [email, fl ? 'Tom' : 'Lina']);
  await p.waitForTimeout(600);
  await p.evaluate(([o, email, ID, OTHER]) => {
    const db = window.__mockdb; const me = db.profiles.find(x => x.email === email); me.rules_version = '2026-11'; const now = new Date().toISOString();
    const fl = o.role === 'freelancer';
    if (fl) { me.role = 'editor'; db.profiles.push({ id: OTHER, email: 'cl@test.com', first_name: 'Lina', role: 'client', is_admin: false, banned: false, created_at: now }); }
    else db.profiles.push({ id: OTHER, email: 'fl@test.com', first_name: 'Tom', role: 'editor', is_admin: false, banned: false, created_at: now });
    const ed = fl ? me.id : OTHER, cl = fl ? OTHER : me.id;
    if (o.ready !== false) db.payout_details.push({ id: ed, methods: [], note: '', stripe_account_id: 'acct_test', stripe_payouts_enabled: true });
    const conv = { id: '88888888-8888-4888-8888-888888888888', user_a: [me.id, OTHER].sort()[0], user_b: [me.id, OTHER].sort()[1], created_at: now }; db.conversations.push(conv);
    db.contracts.push(Object.assign({ id: ID, conversation_id: conv.id, editor: ed, client: cl, proposed_by: cl, title: 'Product film', description: 'Edit a film', price: 100, currency: 'EUR', pricing: 'project',
      amount_cents: 10000, funded_cents: 10000, released_cents: 0, refunded_cents: 0, payment_mode: 'escrow', status: 'funded', revisions: 1, changes_used: 0, has_milestones: false, terms_version: 1,
      client_accepted_version: 1, freelancer_accepted_version: 1, accepted_at: now, pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14, created_at: now }, o.order || {}));
    (o.ms || []).forEach((m, i) => db.order_milestones.push(Object.assign({ id: '66666666-6666-4666-8666-66666666666' + i, order_id: ID, position: i + 1, title: 'Part ' + (i + 1), status: 'pending', created_at: now }, m)));
    (o.events || []).forEach((e, i) => db.order_events.push(Object.assign({ id: 900 + i, order_id: ID, actor: null, data: {}, created_at: now }, e)));
  }, [o, email, ID, OTHER]);
  await p.evaluate(async () => { window.__mockEscrow = true; if (window.__reloadEscrow) await window.__reloadEscrow(); });
  await p.goto((o.page || url) + '#contracts'); await p.waitForTimeout(900); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
  await p.locator('.c-row').first().click(); await p.waitForTimeout(900);
  return { ctx, p, errs };
}
const screen = (p) => p.evaluate(() => (document.querySelector('#modalRoot .modal') || document.querySelector('#modalRoot')).innerText);
const screenHtml = (p) => p.evaluate(() => document.querySelector('#modalRoot').innerHTML);
const button = (p, a) => p.evaluate((a) => { const x = document.querySelector(`#modalRoot [data-caction="${a}"]`); return x ? x.textContent : null; }, a);
const toasts = (p) => p.evaluate(() => [...document.querySelectorAll('.toast')].map(x => x.textContent).join(' | '));
const order = (p) => p.evaluate((id) => JSON.parse(JSON.stringify(window.__mockdb.contracts.find(c => c.id === id))), ID);
const stripe = (p) => p.evaluate(() => JSON.parse(JSON.stringify(window.__fakeStripe)));
const history = (p) => p.evaluate(() => { const d = [...document.querySelectorAll('#modalRoot details')].pop(); if (d) d.open = true; return d ? d.innerText : ''; });
const missing = (s, wants) => wants.filter(w => !s.includes(w));
const say = (list) => list.length ? ' — ' + list.join('; ') : '';

(async () => {
  // 0. the new texts: in all 7 languages, with the English one's placeholders, translated, "editorius" in Lithuanian
  {
    const bad = [];
    for (const k of NEW_KEYS) for (const l of ALL) {
      const v = textOf('T_PRICES', l, k), en = textOf('T_PRICES', 'en', k); const ph = (x) => (String(x).match(/\{[a-z]+\}/g) || []).sort().join('');
      if (!v) bad.push(`${l}.${k} missing`); else { if (ph(v) !== ph(en)) bad.push(`${l}.${k}: placeholders ${ph(v)} (English ${ph(en)})`); if (l !== 'en' && v === en) bad.push(`${l}.${k} still English`); if (/montuotoj/i.test(v)) bad.push(`${l}.${k} says montuotojas`); }
    }
    // they are an Order's own texts: none has a "__p2" version (that would follow the switch instead of the Order)
    for (const k of NEW_KEYS) if (SRC.includes(k + '__p2:')) bad.push(`${k} has a __p2 version`);
    ok(!bad.length, `the ${NEW_KEYS.length} new texts are in all 7 languages, with the same placeholders, translated${say(bad)}`);
  }
  const b = await chromium.launch();
  try {
    for (const lang of RUN) {
      const T = (k) => tx(lang, k); const L = lang + ': ';
      // 1. a proposal at the new prices, before anyone accepts: the price, the 5%, what the freelancer receives, the 14 days
      for (const role of ['freelancer', 'client']) {
        const { ctx, p, errs } = await orderPage(b, { lang, role, order: { status: 'proposed', funded_cents: 0, accepted_at: null, client_accepted_version: role === 'client' ? null : 1, freelancer_accepted_version: role === 'client' ? 1 : null } });
        const s = await screen(p);
        const want = [T('o_priceLine'), '€100.00', fill(T('o2_commission'), { pct: '5' }), '−€5.00', T(role === 'freelancer' ? 'o2_youReceive' : 'o2_flReceives'), '€95.00', fill(T('es_proposeNote__p2'), { n: 14, pct: '5' })];
        const acc = await button(p, 'accept');
        ok(!missing(s, want).length && !feeLeft(lang, s).length && acc && !errs.length, `${L}plan 2 proposal, as the ${role}, before accepting: the price, ${fill(T('o2_commission'), { pct: '5' })} −€5.00, ${T(role === 'freelancer' ? 'o2_youReceive' : 'o2_flReceives')} €95.00 and 14 days; no card-fee line${say(missing(s, want).map(w => 'missing "' + w.slice(0, 50) + '"'))}${say(feeLeft(lang, s).map(w => 'shows "' + w.slice(0, 50) + '"'))}${errs.length ? ' — page error ' + errs[0] : ''}`);
        await ctx.close();
      }
      // 2. the 5% rounded half up to the cent: €33.30 -> 5% is 166.5 cents -> €1.67, the freelancer receives €31.63
      {
        const { ctx, p, errs } = await orderPage(b, { lang, role: 'freelancer', order: { status: 'proposed', price: 33.3, amount_cents: 3330, funded_cents: 0, accepted_at: null, freelancer_accepted_version: null } });
        const s = await screen(p);
        ok(s.includes('−€1.67') && s.includes('€31.63') && !errs.length, `${L}plan 2 proposal of €33.30: 5% is 166.5 cents, rounded half up -> ${s.includes('−€1.67') ? '€1.67' : '?'}, the freelancer receives ${s.includes('€31.63') ? '€31.63' : '?'} (must be €1.67 and €31.63, as the database's pricing_commission)`);
        await ctx.close();
      }
      // 3. agreed, the client pays: the Fund button is the agreed price and nothing on top; the payment asks for exactly that
      {
        const { ctx, p, errs } = await orderPage(b, { lang, role: 'client', order: { status: 'accepted', funded_cents: 0 } });
        const s = await screen(p); const fund = await button(p, 'fund');
        const want = [T('o_fundTitle'), T('o_priceLine'), T('o_total'), '€100.00', T('o2_payOnly'), fill(T('o2_fromPayout'), { pct: '5', fee: '€5.00', name: 'Tom', amt: '€95.00' }), fill(T('o_fundedDesc'), { n: 14 })];
        ok(fund === fill(T('o_fundBtn'), { amt: '€100.00' }) && !missing(s, want).length && !feeLeft(lang, s).length && !errs.length,
          `${L}plan 2 Order agreed, as the client: the button says "${fund}" (must be "${fill(T('o_fundBtn'), { amt: '€100.00' })}"), the box says the agreed price only, the 5% from the payout and 14 days${say(missing(s, want).map(w => 'missing "' + w.slice(0, 50) + '"'))}${say(feeLeft(lang, s).map(w => 'shows "' + w.slice(0, 50) + '"'))}`);
        if (fund) { await p.click('[data-caction="fund"]'); await p.waitForTimeout(1200); }
        const st = await stripe(p), c = await order(p), line = await p.evaluate((id) => window.__mockdb.order_payments.find(x => x.order_id === id && x.kind === 'fund'), ID);
        const ch = (st.charges || []).at(-1) || {};
        const back = await p.evaluate(() => (window.__lastConfirm || {}).contract_id || null);   // the page went to the payment page and came back
        ok(ch.amount === 10000 && ch.fee === 0 && ch.connect === 0 && ch.total === 10000 && c.funded_cents === 10000 && line && line.fee_cents === 0 && line.connect_cents === 0 && back === ID && !errs.length,
          `${L}plan 2 Order: Fund -> the payment asks for €${(ch.total || 0) / 100} (amount ${ch.amount}, fee ${ch.fee}, connect ${ch.connect}); the Order holds ${c.funded_cents}; its payment line's fee ${line && line.fee_cents}, payout fee ${line && line.connect_cents}; the page ${back ? 'went to the payment page' : 'did not go to the payment page'} (must be 10000, 0, 0, 10000, and go)${errs.length ? ' — page error ' + errs[0] : ''}`);
        await ctx.close();
      }
      // 4. a payment function that would charge something on top at the new prices: the page does not go to that payment page
      {
        const { ctx, p, errs } = await orderPage(b, { lang, role: 'client', order: { status: 'accepted', funded_cents: 0 }, extra: 'window.__mockCheckoutExtra = { fee: 300, total: 10300 };' });
        if (await button(p, 'fund')) { await p.click('[data-caction="fund"]'); await p.waitForTimeout(900); }
        const went = await p.evaluate(() => !!window.__lastConfirm || location.hash.includes('paid=')), said = await toasts(p);
        ok(!went && said.includes(T('a_error')) && !errs.length, `${L}plan 2 Order: the payment function answers a €3 card fee on top -> the page ${went ? 'went to that payment page' : 'stays'} and says "${said.slice(-50)}" (must stay, and say something went wrong)`);
        await ctx.close();
      }
      // 5. agreed, as the freelancer: what they will receive, the 5% and the 14 days
      {
        const { ctx, p, errs } = await orderPage(b, { lang, role: 'freelancer', order: { status: 'accepted', funded_cents: 0 } });
        const s = await screen(p);
        const want = [T('o2_youReceive'), '€95.00', '−€5.00', fill(T('o2_heldNote'), { pct: '5', n: 14 })];
        ok(!missing(s, want).length && !feeLeft(lang, s).length && !errs.length, `${L}plan 2 Order agreed, as the freelancer: "${T('o2_youReceive')} €95.00", the 5% and 14 days${say(missing(s, want).map(w => 'missing "' + w.slice(0, 50) + '"'))}${say(feeLeft(lang, s).map(w => 'shows "' + w.slice(0, 50) + '"'))}`);
        await ctx.close();
      }
      // 6. paid in, as the client: the 5% and what the freelancer receives; approving says it; the payout keeps 5%
      {
        const { ctx, p, errs } = await orderPage(b, { lang, role: 'client' });
        const s = await screen(p);
        const want = [fill(T('o2_commission'), { pct: '5' }), '€5', T('o2_flReceives'), '€95', fill(T('o2_heldNote'), { pct: '5', n: 14 })];
        ok(!missing(s, want).length && !feeLeft(lang, s).length && !errs.length, `${L}plan 2 Order paid in, as the client: the 5% (€5) and €95 for the freelancer, 14 days, no "Cuvori fee: €0"${say(missing(s, want).map(w => 'missing "' + w.slice(0, 50) + '"'))}${say(feeLeft(lang, s).map(w => 'shows "' + w.slice(0, 50) + '"'))}`);
        let confirm = '';
        if (await button(p, 'release')) { await p.click('[data-caction="release"]'); await p.waitForTimeout(400); confirm = await screen(p); await p.click('#omGo'); await p.waitForTimeout(900); }
        const tr = (await stripe(p)).transfers.at(-1) || {}, c = await order(p), line = await p.evaluate((id) => window.__mockdb.order_payments.find(x => x.order_id === id && x.kind === 'release'), ID);
        ok(confirm.includes(fill(T('o2_fromPayout'), { pct: '5', fee: '€5.00', name: 'Tom', amt: '€95.00' })) && tr.amount === 9500 && tr.gross === 10000 && c.released_cents === 10000 && c.commission_cents === 500 && line && line.amount_cents === 10000 && line.commission_cents === 500 && line.payout_cents === 9500,
          `${L}plan 2 Order: approving says "${fill(T('o2_fromPayout'), { pct: '5', fee: '€5.00', name: 'Tom', amt: '€95.00' })}"${confirm.includes(fill(T('o2_fromPayout'), { pct: '5', fee: '€5.00', name: 'Tom', amt: '€95.00' })) ? '' : ' (not shown)'}; the transfer is ${tr.amount} of ${tr.gross}, the Order counts ${c.released_cents} paid out and ${c.commission_cents} commission (must be 9500 of 10000, 10000 and 500)`);
        // the finished Order: the 5% kept and what the freelancer received
        await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; }); await p.locator('.c-row').first().click(); await p.waitForTimeout(900);
        const done = await screen(p);
        ok(done.includes(fill(T('o2_commission'), { pct: '5' })) && done.includes('€95') && !feeLeft(lang, done).length && !errs.length, `${L}plan 2 Order completed: the screen shows the 5% kept and €95 received${say(feeLeft(lang, done).map(w => 'shows "' + w.slice(0, 50) + '"'))}${errs.length ? ' — page error ' + errs[0] : ''}`);
        await ctx.close();
      }
      // 7. paid in, as the freelancer: "You receive €95"; the deliver dialog says the Order's 14 days
      {
        const { ctx, p, errs } = await orderPage(b, { lang, role: 'freelancer' });
        const s = await screen(p); let desc = '';
        if (await button(p, 'deliver')) { await p.click('[data-caction="deliver"]'); await p.waitForTimeout(400); desc = await screen(p); }
        ok(s.includes(T('o2_youReceive')) && s.includes('€95') && !feeLeft(lang, s).length && desc.includes(fill(T('es_deliverDesc'), { n: 14 })) && !errs.length, `${L}plan 2 Order paid in, as the freelancer: "${T('o2_youReceive')} €95", and the deliver dialog says 14 days${say(feeLeft(lang, s).map(w => 'shows "' + w.slice(0, 50) + '"'))}`);
        await ctx.close();
      }
      // 8. delivered, as the client: the 14 days, the approve button is the money held
      {
        const due = new Date(Date.now() + 14 * 864e5).toISOString();
        const { ctx, p, errs } = await orderPage(b, { lang, role: 'client', order: { status: 'delivered', delivered_at: new Date().toISOString(), delivery_url: 'https://drive.google.com/file/d/1', auto_release_at: due } });
        const s = await screen(p), rel = await button(p, 'release');
        ok(s.includes(fill(T('o2_heldNote'), { pct: '5', n: 14 })) && s.includes(T('o2_flReceives')) && !feeLeft(lang, s).length && rel === fill(T('o_approveRelease'), { amt: '€100' }) && !errs.length, `${L}plan 2 Order delivered, as the client: 14 days and the 5%, "${rel}"${say(feeLeft(lang, s).map(w => 'shows "' + w.slice(0, 50) + '"'))}`);
        await ctx.close();
      }
      // 9. a price increase both accepted (€20 owed): the button is the €20 owed, nothing on top
      {
        const { ctx, p, errs } = await orderPage(b, { lang, role: 'client', order: { price: 120, amount_cents: 12000 } });
        const s = await screen(p), top = await button(p, 'topup');
        const want = [T('o_increaseLine'), '€20.00', T('o_total'), T('o2_payOnly'), fill(T('o2_commission'), { pct: '5' }), '€6', '€114'];
        ok(top === fill(T('o_topup'), { amt: '€20.00' }) && !missing(s, want).length && !feeLeft(lang, s).length && !errs.length, `${L}plan 2 Order with a €20 increase owed: the button says "${top}" (must be "${fill(T('o_topup'), { amt: '€20.00' })}"), the 5% of €120 is €6, €114 for the freelancer${say(missing(s, want).map(w => 'missing "' + w.slice(0, 50) + '"'))}${say(feeLeft(lang, s).map(w => 'shows "' + w.slice(0, 50) + '"'))}`);
        if (top) { await p.click('[data-caction="topup"]'); await p.waitForTimeout(1200); }
        const ch = ((await stripe(p)).charges || []).at(-1) || {}, c = await order(p);
        ok(ch.kind === 'topup' && ch.amount === 2000 && ch.fee === 0 && ch.connect === 0 && ch.total === 2000 && c.funded_cents === 12000, `${L}plan 2 Order: paying the increase asks for €${(ch.total || 0) / 100} (fee ${ch.fee}, connect ${ch.connect}); the Order holds ${c.funded_cents} (must be 2000 with nothing on top, 12000)`);
        await ctx.close();
      }
      // 10. parts paid out one by one: 5% on the running total of the payouts, rounded half up (€33.33 + €66.67 = €100: €1.67 + €3.33 = €5)
      {
        const { ctx, p, errs } = await orderPage(b, { lang, role: 'client', order: { has_milestones: true }, ms: [{ amount_cents: 3333, status: 'submitted' }, { amount_cents: 6667, status: 'submitted' }] });
        const conf = [], sent = [];
        for (let i = 0; i < 2; i++) {
          const btn = p.locator('[data-msact="release"]').first();
          if (!(await btn.count())) break;
          await btn.click(); await p.waitForTimeout(400); conf.push(await screen(p)); await p.click('#omGo'); await p.waitForTimeout(900);
          sent.push(((await stripe(p)).transfers.at(-1) || {}).amount);
          await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; }); await p.locator('.c-row').first().click(); await p.waitForTimeout(900);
        }
        const c = await order(p);
        const w1 = fill(T('o2_fromPayout'), { pct: '5', fee: '€1.67', name: 'Tom', amt: '€31.66' }), w2 = fill(T('o2_fromPayout'), { pct: '5', fee: '€3.33', name: 'Tom', amt: '€63.34' });
        ok((conf[0] || '').includes(w1) && (conf[1] || '').includes(w2) && sent[0] === 3166 && sent[1] === 6334 && c.commission_cents === 500 && c.released_cents === 10000 && !errs.length,
          `${L}plan 2 Order in two parts: approving each says "${w1}" / "${w2}"; transfers ${sent.join(' + ')}, commission ${c.commission_cents}, paid out ${c.released_cents} (must be 3166 + 6334, 500, 10000)`);
        await ctx.close();
      }
      // 11. the history line for a payment that came too late: under the new prices it goes back in full, and the event says so
      //     (full: true, as the payment code writes it); the page goes by what the event says, so a line never claims more than
      //     happened. Today's Orders keep their line.
      for (const plan of [2, 1]) {
        const ev = plan === 2 ? [{ event: 'late_payment_refunded', data: { total_cents: 10000, amount_cents: 10000, card_fee_cents: 0, full: true } }]
                              : [{ event: 'late_payment_refunded', data: { total_cents: 10000, amount_cents: 9775, card_fee_cents: 225 } }];
        const { ctx, p, errs } = await orderPage(b, { lang, role: 'client', order: plan === 2 ? { status: 'completed', released_cents: 10000, commission_cents: 500 } : { status: 'completed', released_cents: 10000, pricing_version: 1, commission_bps: 0, auto_days: 7 }, events: ev });
        const h = await history(p);
        const full = fill(T('o_ev_late_payment_refunded_full'), { total: '€100' }), today = fill(T('o_ev_late_payment_refunded'), { total: '€100', amt: '€97.75', fee: '€2.25' });
        if (plan === 2) ok(h.includes(full) && !h.includes(today) && !errs.length, `${L}plan 2 Order: a late payment's history line says "${full}"${h.includes(full) ? '' : ' (not shown: ' + h.slice(-120) + ')'}`);
        else ok(h.includes(today) && !h.includes(full) && !errs.length, `${L}plan 1 Order: a late payment's history line stays today's: "${today}"${h.includes(today) ? '' : ' (not shown)'}`);
        await ctx.close();
      }
      // 12. the switch moved back (today's prices in force again): an Order agreed at the new prices keeps them
      {
        const { ctx, p, errs } = await orderPage(b, { lang, role: 'freelancer', prices: P1 });
        const s = await screen(p);
        ok(s.includes(T('o2_youReceive')) && s.includes('€95') && s.includes(fill(T('o2_heldNote'), { pct: '5', n: 14 })) && !feeLeft(lang, s).length && !errs.length, `${L}the switch is off again: a plan 2 Order still shows its 5% and 14 days${say(feeLeft(lang, s).map(w => 'shows "' + w.slice(0, 50) + '"'))}`);
        await ctx.close();
      }
      // 13. Orders agreed before the switch (pricing_version 1, or empty from before v56) with the new prices in force: today's lines, nothing new
      for (const pv of [1, null]) {
        const old = { pricing_version: pv, commission_bps: pv ? 0 : null, commission_cents: pv ? 0 : null, auto_days: 7 };
        const tag = `${L}plan ${pv || 'empty'} Order, new prices in force`;
        // proposed: no payment box, as today
        {
          const { ctx, p, errs } = await orderPage(b, { lang, role: 'client', order: { ...old, status: 'proposed', funded_cents: 0, accepted_at: null, client_accepted_version: null } });
          const s = await screen(p), boxes = await p.evaluate(() => document.querySelectorAll('#modalRoot .pay-box').length);
          ok(boxes === 0 && !newLeft(lang, s).length && !errs.length, `${tag}: a proposal shows no payment box (${boxes}) and none of the new texts${say(newLeft(lang, s))}`);
          await ctx.close();
        }
        // agreed: the card fee and payout fee lines, the Fund button with them, the payment with them
        {
          const { ctx, p, errs } = await orderPage(b, { lang, role: 'client', order: { ...old, status: 'accepted', funded_cents: 0 } });
          const q = await p.evaluate(async () => (await window.__sb.rpc('order_quote', { p_price_cents: 10000, p_currency: 'EUR', p_country: null, p_customer: 'any', p_method: 'card', p_topup: false })).data);
          const two = (c) => '€' + (c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
          const s = await screen(p), fund = await button(p, 'fund');
          const want = [T('o_processing'), two(q.processing_cents), T('o_cuvoriFee'), T('o_total'), two(q.total_cents), ...(q.connect_cents > 0 ? [T('o_connect'), two(q.connect_cents)] : [])];
          ok(q.processing_cents > 0 && fund === fill(T('o_fundBtn'), { amt: two(q.total_cents) }) && !missing(s, want).length && !newLeft(lang, s).length && !errs.length, `${tag}, agreed: the card fee ${two(q.processing_cents)}${q.connect_cents ? ', the payout fee ' + two(q.connect_cents) : ''} and "${fund}" as today${say(missing(s, want).map(w => 'missing "' + w.slice(0, 40) + '"'))}${say(newLeft(lang, s))}`);
          if (fund) { await p.click('[data-caction="fund"]'); await p.waitForTimeout(1200); }
          const ch = ((await stripe(p)).charges || []).at(-1) || {};
          ok(ch.fee === q.processing_cents && ch.total === q.total_cents && ch.amount === 10000, `${tag}: the payment asks for ${ch.total} (fee ${ch.fee}) as today (must be ${q.total_cents}, fee ${q.processing_cents})`);
          await ctx.close();
        }
        // paid in: "Cuvori fee: €0.", releasing pays out all of it
        {
          const { ctx, p, errs } = await orderPage(b, { lang, role: 'client', order: old });
          const s = await screen(p);
          let confirm = ''; if (await button(p, 'release')) { await p.click('[data-caction="release"]'); await p.waitForTimeout(400); confirm = await screen(p); await p.click('#omGo'); await p.waitForTimeout(900); }
          const tr = (await stripe(p)).transfers.at(-1) || {};
          ok(s.includes(T('o_cuvoriZero')) && !newLeft(lang, s + confirm).length && confirm.includes(fill(T('o_releaseConfirm'), { amt: '€100', name: 'Tom' })) && tr.amount === 10000 && tr.gross === undefined && !errs.length,
            `${tag}, paid in: "${T('o_cuvoriZero')}" as today, approving releases ${tr.amount} (must be 10000, all of it)${say(newLeft(lang, s + confirm))}`);
          await ctx.close();
        }
      }
    }
    // 14. every language: the plan 2 screens show their own texts, no placeholder or key left, "editorius" in Lithuanian
    {
      const bad = [];
      for (const lang of ALL) {
        for (const [role, ord] of [['client', { status: 'proposed', funded_cents: 0, accepted_at: null, client_accepted_version: null }], ['client', { status: 'accepted', funded_cents: 0 }], ['freelancer', {}]]) {
          const { ctx, p, errs } = await orderPage(b, { lang, role, order: ord });
          const s = await screen(p);
          if (/\{[a-z]+\}|o2_|__p2|es_[a-z]+[A-Z]/.test(s)) bad.push(`${lang} ${role} ${ord.status || 'funded'}: a placeholder or key shows: ${(s.match(/\{[a-z]+\}|o2_\w+|__p2|es_[a-z]+[A-Z]\w*/) || [])[0]}`);
          if (!/5\s?%/.test(s) || !/14/.test(s)) bad.push(`${lang} ${role} ${ord.status || 'funded'}: the 5% or the 14 days missing`);
          if (feeLeft(lang, s).length) bad.push(`${lang} ${role} ${ord.status || 'funded'}: shows ${feeLeft(lang, s).join(', ')}`);
          if (lang === 'lt' && /montuotoj/i.test(s)) bad.push('lt: montuotojas');
          if (errs.length) bad.push(`${lang}: page error ${errs[0]}`);
          await ctx.close();
        }
      }
      ok(!bad.length, `plan 2 Order screens in all 7 languages: their texts, the 5% and 14 days, no key or placeholder, no card-fee line${say(bad)}`);
    }
    // 15. on a 390px phone the plan 2 payment box fits the screen
    {
      const { ctx, p, errs } = await orderPage(b, { lang: 'de', role: 'client', order: { status: 'accepted', funded_cents: 0 }, width: 390 });
      const wide = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const boxWide = await p.evaluate(() => { const x = document.querySelector('#modalRoot .pay-box'); return x ? x.scrollWidth - x.clientWidth : -1; });
      ok(wide <= 0 && boxWide <= 0 && !errs.length, `plan 2 payment box on a 390px phone (German): the page is ${wide}px too wide, the box ${boxWide}px (must be 0 or less)`);
      await ctx.close();
    }
    // 16. the admin panel: a plan 2 dispute and a plan 1 dispute side by side, and a paid plan 2 Order whose card cost Stripe took
    for (const variant of ['list without the plan', 'list with the plan', 'plan unreadable', 'no v56']) {
      const extra = variant === 'list with the plan' ? 'window.__mockAdminListPlan = true;' : variant === 'plan unreadable' ? 'window.__mockRpcFail = { order_price_breakdown: true };' : '';
      const { ctx, p, errs } = await open(b, variant === 'no v56' ? null : P2, 'de', 1400, extra);
      await p.goto(url); await p.waitForTimeout(700);
      await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'admin@test.com', password: 'password123', options: { data: { first_name: 'Ada' } } }); await sb.auth.signInWithPassword({ email: 'admin@test.com', password: 'password123' }); });
      await p.waitForTimeout(600);
      await p.evaluate(() => {
        const db = window.__mockdb; const me = db.profiles.find(x => x.email === 'admin@test.com'); me.rules_version = '2026-11'; const now = new Date().toISOString();
        const fl = '99999999-9999-4999-8999-999999999991', cl = '99999999-9999-4999-8999-999999999992';
        db.profiles.push({ id: fl, email: 'fl@test.com', first_name: 'Tom', role: 'editor', is_admin: false, banned: false, created_at: now }, { id: cl, email: 'cl@test.com', first_name: 'Lina', role: 'client', is_admin: false, banned: false, created_at: now });
        db.payout_details.push({ id: fl, methods: [], note: '', stripe_account_id: 'acct_test', stripe_payouts_enabled: true });
        const base = { conversation_id: '88888888-8888-4888-8888-888888888888', editor: fl, client: cl, proposed_by: cl, description: 'x', currency: 'EUR', pricing: 'project', price: 100, amount_cents: 10000, funded_cents: 10000, released_cents: 0, refunded_cents: 0, payment_mode: 'escrow',
          revisions: 1, changes_used: 0, has_milestones: false, terms_version: 1, client_accepted_version: 1, freelancer_accepted_version: 1, accepted_at: now, created_at: now };
        db.contracts.push({ ...base, id: 'aaaaaaaa-0000-4000-8000-000000000002', title: 'New prices dispute', status: 'disputed', dispute_by: cl, dispute_reason: 'Not what we agreed', pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14 },
          { ...base, id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Old prices dispute', status: 'disputed', dispute_by: cl, dispute_reason: 'Not what we agreed', pricing_version: 1, commission_bps: 0, commission_cents: 0, auto_days: 7, fee_short_cents: 40 },
          { ...base, id: 'aaaaaaaa-0000-4000-8000-000000000003', title: 'New prices paid', status: 'funded', pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14 });
        // what Stripe took for the card on the plan 2 payment (Cuvori's cost by design: the client paid no card fee)
        db.order_payments.push({ id: 'pay-3', order_id: 'aaaaaaaa-0000-4000-8000-000000000003', kind: 'fund', amount_cents: 10000, fee_cents: 0, connect_cents: 0, provider_fee_cents: 175, provider: 'stripe', provider_ref: 'pi_x', status: 'succeeded', created_at: now });
        window.__mockEscrow = true;   // the payment functions are on
      });
      await p.goto(url + '#account'); await p.waitForTimeout(500); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      await p.click('#adminBtn'); await p.waitForTimeout(600); await p.click('.admin-tab[data-atab="contracts"]'); await p.waitForTimeout(900);
      const row = (id) => p.evaluate((id) => (document.querySelector(`.admin-row[data-cid="${id}"]`) || {}).innerText || '', id);
      const r1 = await row('aaaaaaaa-0000-4000-8000-000000000001'), r2 = await row('aaaaaaaa-0000-4000-8000-000000000002'), r3 = await row('aaaaaaaa-0000-4000-8000-000000000003');
      const stats = await p.evaluate(() => (document.querySelector('#adminBody .admin-stats') || {}).innerText || '');
      const p2Known = variant === 'list without the plan' || variant === 'list with the plan';
      const shortRows = (r1.includes('Card cost not covered') ? 1 : 0) + (r2.includes('Card cost not covered') ? 1 : 0) + (r3.includes('Card cost not covered') ? 1 : 0);
      if (p2Known) ok(r1.includes('Card cost not covered: Stripe took €0.40') && !r2.includes('Card cost not covered') && !r3.includes('Card cost not covered') && stats.includes('€0.40 card cost paid by Cuvori (1 order)') && !errs.length,
        `admin (${variant}): "Card cost not covered" only on the plan 1 Order (${shortRows} row(s)); the paid plan 2 Order, whose €1.75 card cost Cuvori pays by design, has none; the total says ${(stats.match(/€[\d.]+ card cost paid by Cuvori \(\d+ orders?\)/) || ['nothing'])[0]} (must be €0.40, 1 order)`);
      // the decision box of the plan 2 dispute: the freelancer's share before the 5%, in euros
      const box = async (id, d, pct) => {
        await p.click(`.admin-row[data-cid="${id}"] [data-res="${d}"]`); await p.waitForTimeout(300);
        if (pct != null) { await p.fill('#resPct', String(pct)); await p.dispatchEvent('#resPct', 'input'); }
        const r = await p.evaluate(() => ({ text: document.querySelector('#modalRoot').innerText, sum: (document.querySelector('#resSum') || {}).textContent || null, label: ([...document.querySelectorAll('#modalRoot label')][0] || {}).textContent || '' }));
        return r;
      };
      const close = () => p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
      // what Cuvori reviews to decide: the chat, shown as text (a message with HTML in it runs nothing), the dispute, the work
      if (p2Known) {
        await p.evaluate(() => { const db = window.__mockdb; db.messages.push({ id: 'msg-ev-1', conversation_id: '88888888-8888-4888-8888-888888888888', sender: '99999999-9999-4999-8999-999999999992', kind: 'text', body: 'The video is 2 minutes <img src=x onerror="window.__evXss=1">', created_at: new Date().toISOString() }); });
        const evBtn = await p.$('.admin-row[data-cid="aaaaaaaa-0000-4000-8000-000000000002"] [data-evidence]'), noBtn = await p.$('.admin-row[data-cid="aaaaaaaa-0000-4000-8000-000000000003"] [data-evidence]');
        if (evBtn) { await evBtn.click(); await p.waitForTimeout(400); }
        const ev = await p.evaluate(() => ({ text: (document.querySelector('#modalRoot') || {}).innerText || '', img: !!document.querySelector('#modalRoot img'), xss: !!window.__evXss }));
        await close();
        ok(!!evBtn && !noBtn && /Evidence: New prices dispute/.test(ev.text) && /Opened by the client/.test(ev.text) && /Not what we agreed/.test(ev.text) && ev.text.includes('The video is 2 minutes <img src=x onerror="window.__evXss=1">') && !ev.img && !ev.xss && /admin log/.test(ev.text) && !errs.length,
          `admin (${variant}): the dispute's Evidence (${evBtn ? "button there" : "NO BUTTON"}, ${noBtn ? "ALSO on an Order nobody disputed" : "none on an Order nobody disputed"}) shows the dispute and the chat as text (${ev.img || ev.xss ? "HTML RAN" : "no HTML ran"}): ${ev.text.replace(/\s+/g, " ").slice(0, 160)}`);
      }
      const s50 = await box('aaaaaaaa-0000-4000-8000-000000000002', 'split'); await close();
      const s60 = await box('aaaaaaaa-0000-4000-8000-000000000002', 'split', 60);
      if (p2Known) {
        ok(s60.label === "Freelancer's share (%), before the 5%" && s50.sum === '€100.00 held, 50%: the freelancer receives €47.50, Cuvori keeps €2.50, the client gets €50.00 back.' && s60.sum === '€100.00 held, 60%: the freelancer receives €57.00, Cuvori keeps €3.00, the client gets €40.00 back.' && !errs.length,
          `admin (${variant}), plan 2 dispute, Split: the label "${s60.label}"; at 50% "${s50.sum}"; at 60% "${s60.sum}" (must be "Freelancer's share (%), before the 5%", €47.50/€2.50/€50.00, €57.00/€3.00/€40.00)`);
        await p.fill('#resNote', 'Most of it was delivered'); await p.click('#resGo'); await p.waitForTimeout(900);
        const st = await stripe(p), c = await p.evaluate(() => JSON.parse(JSON.stringify(window.__mockdb.contracts.find(x => x.id === 'aaaaaaaa-0000-4000-8000-000000000002'))));
        const tr = st.transfers.at(-1) || {}, rf = st.refunds.at(-1) || {};
        ok(tr.amount === 5700 && tr.gross === 6000 && rf.amount === 4000 && c.released_cents === 6000 && c.commission_cents === 300 && c.refunded_cents === 4000,
          `admin (${variant}), plan 2 dispute split 60%: the freelancer is sent ${tr.amount} of their ${tr.gross}, the client gets ${rf.amount} back, the Order counts ${c.released_cents} paid out, ${c.commission_cents} commission (must be 5700 of 6000, 4000, 6000, 300: the 5% out of the freelancer's share, never the client's refund)`);
      } else {
        ok(s60.label === 'Freelancer receives (%)' && (variant === 'no v56' ? !/could not be read/.test(s60.text) : /could not be read just now/.test(s60.text)) && !errs.length,
          `admin (${variant}): the plan 2 dispute's box ${variant === 'no v56' ? 'has today\'s label (no prices in the database: every Order has today\'s prices)' : 'says the price plan could not be read, and to reload before deciding'} -> "${s60.label}"${/could not be read/.test(s60.text) ? ' + the note' : ''}`);
      }
      await close();
      if (variant === 'list without the plan') {
        // Release and Refund on the plan 2 dispute: what each means in euros
        await p.evaluate(() => { const c = window.__mockdb.contracts.find(x => x.id === 'aaaaaaaa-0000-4000-8000-000000000003'); c.status = 'disputed'; c.dispute_by = c.client; c.dispute_reason = 'Late'; });
        await p.click('.admin-tab[data-atab="users"]'); await p.waitForTimeout(300); await p.click('.admin-tab[data-atab="contracts"]'); await p.waitForTimeout(900);
        const rel = await box('aaaaaaaa-0000-4000-8000-000000000003', 'release'); await close();
        const ref = await box('aaaaaaaa-0000-4000-8000-000000000003', 'refund'); await close();
        ok(rel.sum === 'The freelancer receives €95.00, Cuvori keeps €5.00 (its 5% commission).' && ref.sum === 'The client gets €100.00 back. Cuvori keeps nothing.', `admin, plan 2 dispute: Release -> "${rel.sum}"; Refund -> "${ref.sum}"`);
        // the plan 1 dispute: today's box, word for word, and the whole share goes to the freelancer
        const old = await box('aaaaaaaa-0000-4000-8000-000000000001', 'split', 70);
        await p.fill('#resNote', 'Most of it was delivered'); await p.click('#resGo'); await p.waitForTimeout(900);
        const tr = (await stripe(p)).transfers.at(-1) || {};
        ok(old.label === 'Freelancer receives (%)' && old.sum === null && !/5%|commission/.test(old.text) && tr.amount === 7000 && tr.gross === undefined, `admin, plan 1 dispute: today's label "${old.label}", no euro line (${old.sum === null ? 'none' : old.sum}); split 70% sends ${tr.amount} (must be 7000, all of the share)`);
      }
      await ctx.close();
    }
    // 17. BASE: every plan 1 screen is exactly the one an older page shows (the same Order, the same test backend)
    if (process.env.BASE) {
      const base = 'file://' + path.resolve(process.env.BASE), diffs = [];
      for (const lang of RUN) for (const pv of [1, null]) for (const [role, ord] of [['client', { status: 'proposed', funded_cents: 0, accepted_at: null, client_accepted_version: null }], ['freelancer', { status: 'proposed', funded_cents: 0, accepted_at: null, freelancer_accepted_version: null }],
        ['client', { status: 'accepted', funded_cents: 0 }], ['freelancer', { status: 'accepted', funded_cents: 0 }], ['client', {}], ['freelancer', {}], ['client', { price: 120, amount_cents: 12000 }], ['client', { status: 'delivered', delivered_at: '2026-11-01T10:00:00Z', delivery_url: 'https://x.test/a', auto_release_at: '2026-11-08T10:00:00Z' }],
        ['client', { status: 'completed', released_cents: 10000 }]]) {
        const o = { lang, role, order: { ...ord, pricing_version: pv, commission_bps: pv ? 0 : null, commission_cents: pv ? 0 : null, auto_days: 7, created_at: '2026-10-30T10:00:00Z', accepted_at: ord.accepted_at === null ? null : '2026-10-30T11:00:00Z' },
          events: [{ event: 'late_payment_refunded', data: { total_cents: 10000, amount_cents: 9775, card_fee_cents: 225 }, created_at: '2026-10-31T10:00:00Z' }] };
        const a = await orderPage(b, o), h1 = (await screenHtml(a.p)).replace(/\s+/g, ' '); await a.ctx.close();
        const z = await orderPage(b, { ...o, page: base }), h0 = (await screenHtml(z.p)).replace(/\s+/g, ' '); await z.ctx.close();
        if (h1 !== h0) { let i = 0; while (h1[i] === h0[i]) i++; diffs.push(`${lang} plan ${pv || 'empty'} ${role} ${ord.status || 'funded'}: differs at "…${h0.slice(Math.max(0, i - 40), i + 60)}…" / now "…${h1.slice(Math.max(0, i - 40), i + 60)}…"`); }
      }
      ok(!diffs.length, `plan 1 Order screens are exactly the older page's (${RUN.join(', ')}; proposed, agreed, paid in, an increase owed, delivered, completed, with the history)${say(diffs)}`);
      // the admin panel with plan 1 Orders only (a dispute, and a card cost not covered): the list and each decision box
      const adminHtml = async (page, prices) => {
        const { ctx, p } = await open(b, prices, 'en', 1400, '');
        await p.goto(page); await p.waitForTimeout(700);
        await p.evaluate(async () => { const sb = window.__sb; await sb.auth.signUp({ email: 'admin@test.com', password: 'password123', options: { data: { first_name: 'Ada' } } }); await sb.auth.signInWithPassword({ email: 'admin@test.com', password: 'password123' }); });
        await p.waitForTimeout(600);
        await p.evaluate(() => { const db = window.__mockdb; db.profiles.find(x => x.email === 'admin@test.com').rules_version = '2026-11'; const now = '2026-10-30T10:00:00Z';
          const base = { conversation_id: '88888888-8888-4888-8888-888888888888', editor: '99999999-9999-4999-8999-999999999991', client: '99999999-9999-4999-8999-999999999992', proposed_by: '99999999-9999-4999-8999-999999999992', description: 'x', currency: 'EUR', pricing: 'project', price: 100, amount_cents: 10000, funded_cents: 10000, released_cents: 0, refunded_cents: 0, payment_mode: 'escrow', revisions: 1, has_milestones: false, terms_version: 1, accepted_at: now, created_at: now, commission_cents: 0, auto_days: 7 };
          db.contracts.push({ ...base, id: 'aaaaaaaa-0000-4000-8000-000000000001', title: 'Old prices dispute', status: 'disputed', dispute_by: base.client, dispute_reason: 'Not what we agreed', pricing_version: 1, commission_bps: 0, fee_short_cents: 40 },
            { ...base, id: 'aaaaaaaa-0000-4000-8000-000000000004', title: 'From before v56', status: 'delivered', pricing_version: null, commission_bps: null, commission_cents: null }); window.__mockEscrow = true; });
        await p.goto(page + '#account'); await p.waitForTimeout(500); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; });
        await p.click('#adminBtn'); await p.waitForTimeout(600); await p.click('.admin-tab[data-atab="contracts"]'); await p.waitForTimeout(900);
        const out = [await p.evaluate(() => document.querySelector('#adminBody').innerHTML)];
        for (const id of ['aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000004']) for (const d of ['release', 'split', 'refund']) {
          await p.click(`.admin-row[data-cid="${id}"] [data-res="${d}"]`); await p.waitForTimeout(300); out.push(await p.evaluate(() => document.querySelector('#modalRoot').innerHTML)); await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; }); }
        await ctx.close(); return out.map(x => x.replace(/\s+/g, ' '));
      };
      const adiff = [];
      // (the Evidence button on a dispute is new for every Order and is checked above: it is left out of the comparison)
      const noEv = (h) => h.replace(/<button class="link-btn" data-evidence="1">Evidence<\/button>/g, '');
      for (const prices of [P2, null]) { const now = (await adminHtml(url, prices)).map(noEv), old = await adminHtml(base, prices); now.forEach((h, i) => { if (h !== old[i]) adiff.push(`${prices ? 'new prices on' : 'no v56'}: ${i ? 'decision box ' + i : 'the list'} differs`); }); }
      ok(!adiff.length, `admin panel with plan 1 Orders: the list and its 6 decision boxes are exactly the older page's (new prices on, and before v56)${say(adiff)}`);
    }
  } catch (e) { log.push('CRASH ' + e.message); }
  await b.close();
  console.log(log.join('\n'));
  console.log(`\n${log.filter(l => l.startsWith('PASS')).length} passed, ${log.filter(l => !l.startsWith('PASS')).length} failed`);
  process.exit(log.some(l => !l.startsWith('PASS')) ? 1 : 0);
})();
