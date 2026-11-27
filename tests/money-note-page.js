// Check of 27 November 2026 (schema v56): an Order's money note (contracts.money_error) is for the payment code and the
// admin. Since v56 the database gives an Order's two people every column of it but the note, and the page reads its Orders
// through my_orders, which gives each person only what the note means for them (money_note). Here the stand-in for the
// database does what the database does after v56: the table refuses every column at once (select *), my_orders and the
// Order screen's data give money_note instead of the note.
// N1 after v56, for the freelancer and the client: the Orders list, a chat's Order button (the chat's Order: activeOrderFor)
//    and the Order screen all work; each says what the note means for them (the freelancer's Stripe setup to finish); the
//    note's words and Stripe's ids are nowhere on the page or in what it was given.
// N2 before v56 (no my_orders yet): the same Orders, read from the table as before; the note's meaning as before.
// N3 no page errors, nothing wider than a phone's screen.
// Run: node tests/money-note-page.js   (TARGET=<folder> checks another copy)
const { chromium } = require('playwright'); const fs = require('fs'); const path = require('path');
const root = process.env.TARGET ? path.resolve(process.env.TARGET) : path.resolve(__dirname, '..');   // the copy under test (TARGET), else this one
const html = fs.readFileSync(root + '/index.html', 'utf8');
const mock = fs.readFileSync(root + '/mock-supabase.js', 'utf8');
const url = 'file://' + root + '/index.html';
const log = []; const ok = (c, m) => log.push((c ? 'PASS ' : 'FAIL ') + m);
const P1 = { version: 1, commission_bps: 0, min_project_cents: 100, card_costs_paid_by: 'client', review_days: 7, rounding: 'half_up', currency: 'EUR', rules_version: null };
// the page's own English text of a key (the last table that has it)
const en = (key) => { const all = [...html.matchAll(new RegExp(`\\b${key}:"((?:[^"\\\\]|\\\\.)*)"`, 'g'))].map(m => JSON.parse('"' + m[1] + '"')); return all[0] || '\u0000missing ' + key; };
const lib = fs.readFileSync(root + '/netlify/lib/cuvori.mjs', 'utf8');
const NOT_READY = (/const NOT_READY = "([^"]+)"/.exec(lib) || [])[1] || 'missing NOT_READY';
const NOTE = `Money step stopped (automatic payout): ${NOT_READY} · Also: chargeback dp_1SecretDispute also open on payment pi_3SecretPayment`;
const SECRET = /SecretDispute|SecretPayment|chargeback dp_|Money step stopped/;

(async () => {
  const b = await chromium.launch();
  for (const [stage, prices] of [['after v56', P1], ['before v56', null]]) {
    for (const [size, viewport] of [['desktop', { width: 1400, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
      const ctx = await b.newContext({ viewport });
      await ctx.addInitScript((pr) => { try { localStorage.setItem('cuvoriLanguage', 'en'); } catch (e) {} if (pr) window.__mockPrices = pr; }, prices);
      await ctx.addInitScript(mock);
      await ctx.route('**/supabase.min.js', r => r.fulfill({ status: 200, body: '/* mocked */', contentType: 'application/javascript' }));
      const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
      const name = `${stage}, ${size}`;
      try {
        await p.goto(url); await p.waitForTimeout(500);
        const clear = async () => { await p.evaluate(() => { document.querySelector('#modalRoot').innerHTML = ''; }); };
        const signUp = async (n, email) => { await p.goto(url + '#create-account'); await p.waitForTimeout(300); await p.fill('#suName', n); await p.fill('#suEmail', email); await p.fill('#suPass', 'password123'); await p.check('#suAgree'); await p.click('[data-auth-signup]'); await p.waitForTimeout(900); };
        const signOut = async () => { await clear(); await p.goto(url + '#account'); await p.waitForTimeout(300); await p.click('#signOutBtn'); await p.waitForTimeout(400); };
        const signIn = async (email) => { await p.goto(url + '#create-account'); await p.waitForTimeout(300); await p.click('#authSeg [data-auth="signin"]'); await p.waitForTimeout(200); await p.fill('#siEmail', email); await p.fill('#siPass', 'password123'); await p.click('[data-auth-signin]'); await p.waitForTimeout(1300); };
        await signUp('Ana', 'ana@test.com'); await signOut(); await signUp('Bo', 'bo@test.com');
        const ids = await p.evaluate((NOTE) => { const db = window.__mockdb; const ana = db.profiles.find(x => x.email === 'ana@test.com').id, bo = db.profiles.find(x => x.email === 'bo@test.com').id; const now = new Date().toISOString();
          const [ua, ub] = [ana, bo].sort(); db.conversations.push({ id: 'cv-note', user_a: ua, user_b: ub, created_at: now, last_message_at: now });
          db.contracts.push({ id: 'c-note', conversation_id: 'cv-note', editor: bo, client: ana, proposed_by: ana, title: 'Note: a video', description: '', price: 100, currency: 'EUR', pricing: 'project', revisions: 2, status: 'funded', payment_mode: 'escrow',
            amount_cents: 10000, funded_cents: 10000, released_cents: 0, refunded_cents: 0, terms: {}, terms_version: 1, accepted_version: 1, client_accepted_version: 1, freelancer_accepted_version: 1, accepted_at: now, created_at: now, changes_used: 0, money_error: NOTE });
          return { ana, bo }; }, NOTE);
        for (const [side, email, other, hintKey] of [['the freelancer', 'bo@test.com', 'ana', 'es_flNotReadyHint'], ['the client', 'ana@test.com', 'bo', 'es_clNotReadyHint']]) {
          await signOut(); await signIn(email);   // signed in afresh: the chats are read with the Order's chat in them
          await p.evaluate(() => { window.__mockCalls = {}; });
          // the Orders list, then the Order screen from it
          await clear(); await p.goto(url + '#orders'); await p.waitForTimeout(900);
          if (await p.locator('.modal.locked [data-avpick="open"]').count()) { await p.click('.modal.locked [data-avpick="open"]'); await p.waitForTimeout(500); }
          const listed = await p.locator('#contractsList .c-row', { hasText: 'Note: a video' }).count();
          if (listed) { await p.locator('#contractsList .c-row', { hasText: 'Note: a video' }).first().click(); await p.waitForTimeout(900); }
          const screen = (await p.textContent('#modalRoot') || '').replace(/\s+/g, ' ');
          // a chat's Order button: the chat's current Order
          await clear(); await p.goto(url + '#home'); await p.waitForTimeout(700);
          await p.evaluate((k) => { const c = document.querySelector(`.contact[data-person="u:${k}"]`); if (c) c.click(); }, ids[other]); await p.waitForTimeout(1000);
          const chat = await p.locator('.chat-window .open-contract').count();
          if (chat) { await p.locator('.chat-window .open-contract').first().click(); await p.waitForTimeout(1000); }
          const fromChat = (await p.textContent('#modalRoot') || '').replace(/\s+/g, ' ');
          const seen = await p.evaluate(() => document.documentElement.outerHTML + JSON.stringify(window.__mockLastArgs || {}));
          const calls = await p.evaluate(() => window.__mockCalls || {});
          const wide = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
          const hint = en(hintKey).split('{')[0].trim().slice(0, 40);
          ok(listed === 1 && screen.includes('Note: a video') && screen.includes(hint) && chat > 0 && fromChat.includes('Note: a video') && fromChat.includes(hint) && !SECRET.test(screen + fromChat),
            `${name}, ${side}: the Orders list (${listed} row), its Order screen and the chat's Order button open the Order and say what the note means for them ("${hint}…"); the note's own words shown: ${SECRET.test(screen + fromChat)}`);
          ok(prices ? (calls.my_orders || 0) >= 2 && !SECRET.test(seen) : (calls.my_orders || 0) >= 2,
            `${name}, ${side}: the Orders were read ${prices ? 'through my_orders, and the note\'s words are nowhere in the page' : 'from the table, as before v56 (my_orders not there yet)'} -> my_orders asked ${calls.my_orders || 0} times; note's words in the page: ${SECRET.test(seen)}`);
          ok(!wide, `${name}, ${side}: nothing wider than the screen`);
        }
      } catch (e) { log.push('CRASH ' + name + ': ' + e.message.split('\n')[0]); }
      ok(errs.length === 0, `${name}: no page errors ${errs.join(' | ')}`);
      await ctx.close();
    }
  }
  await b.close();
  console.log(log.join('\n')); const f = log.filter(l => !l.startsWith('PASS')).length; console.log(`\n${log.length - f}/${log.length} passed`); process.exit(f ? 1 : 0);
})();
