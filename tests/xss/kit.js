// Shared by the stored-XSS proofs. Each proof saves text an attacker could save (a profile, a video, a job, a chat
// message, an Order) in the fake database, opens the page where that text is shown, and gives one verdict per case:
//   PASS  the page showed the place under attack, and the attacker's text stayed text;
//   FAIL  the attacker's text became part of the page (a tag, an event handler or a javascript: link), a script of
//         theirs ran, or the place under attack never showed: then the proof tests nothing, so it must not pass.
// The page's security policy blocks injected scripts as well, so "nothing ran" alone would pass even with a hole in
// the escaping. The check that no tag from the attacker's text is in the page is what proves the escaping itself.
const { chromium } = require('playwright'); const fs = require('fs');
const ROOT = process.cwd();
const MOCK = fs.readFileSync(ROOT + '/mock-supabase.js', 'utf8');
const URL = 'file://' + ROOT + '/index.html';
const T = '2026-01-01T00:00:00Z';

// the attacker's text for case k: a tag with an event handler, marked so it can be found if it ever becomes a tag
const bad = (k) => `<img src=z data-xss="${k}" onerror="window.__pwn=Object.assign(window.__pwn||{},{${k}:1})">`;
// the same text as the page shows it when it stays text
const asText = (k) => `data-xss="${k}"`;

// a public professional with one service, the way the page needs it to show their card
function attacker({ profile = {}, editor = {}, service = {}, extra = {} } = {}) {
  return {
    profiles: [{ id: 'atk', email: 'atk@a.test', first_name: 'Atk', role: 'editor', banned: false, created_at: T, ...profile }],
    editor_profiles: [{ id: 'atk', display_name: 'Atk', role_label: 'editor', city: 'X', country: 'Y', languages: ['English'], specializations: ['catOther'],
      tools: [], credentials: [], bio: 'hi', rate_amount: 10, rate_unit: 'hour', is_public: true, available: true, created_at: T, ...editor }],
    services: [{ id: 'sv-atk', profile_id: 'atk', profession_slug: 'video-editor', rate_amount: 10, rate_unit: 'hour', currency: 'EUR', headline: '',
      values: {}, is_public: true, sort_order: 0, created_at: T, updated_at: T, ...service }],
    ...extra,
  };
}

// a fresh browser with the fake database (and the attacker's rows in it), on the page
async function open(rows, hash = '') {
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(MOCK);
  if (rows) await ctx.addInitScript((rows) => { (function go() { const db = window.__mockdb; if (!db) return setTimeout(go, 5);
    for (const [table, list] of Object.entries(rows)) (db[table] = db[table] || []).push(...list); })(); }, rows);
  await ctx.route('**/supabase.min.js', r => r.fulfill({ status: 200, body: '/* mocked */', contentType: 'application/javascript' }));
  const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto(URL + hash); await p.waitForTimeout(900);
  return { b, p, errs };
}
const clearModal = (p) => p.evaluate(() => { const m = document.querySelector('#modalRoot'); if (m) m.innerHTML = ''; });
async function signUp(p, name, email) {
  await p.goto(URL + '#create-account'); await p.waitForTimeout(300);
  await p.click('#authSeg [data-auth="signup"]').catch(() => {});
  await p.fill('#suName', name); await p.fill('#suEmail', email); await p.fill('#suPass', 'password123'); await p.check('#suAgree');
  await p.click('[data-auth-signup]'); await p.waitForTimeout(900); await clearModal(p);
}
const textOf = (p, sel) => p.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : ''; }, sel);

const results = [];
// reached: the place under attack really showed (true/false); where: what was looked at, for the FAIL message
async function verdict(p, label, reached, where) {
  const seen = await p.evaluate(() => ({
    tags: [...document.querySelectorAll('[data-xss]')].map(e => e.getAttribute('data-xss')),
    handlers: [...document.querySelectorAll('*')].filter(e => [...e.attributes].some(a => /^on/i.test(a.name) && /__pwn/.test(a.value))).length,
    jsLinks: [...document.querySelectorAll('[href],[src],[action],[formaction]')].map(e => e.getAttribute('href') || e.getAttribute('src') || e.getAttribute('action') || e.getAttribute('formaction'))
      .filter(h => /^\s*javascript:/i.test(h || '')),
    ran: Object.keys(window.__pwn || {}),
  }));
  const broken = seen.tags.length || seen.handlers || seen.jsLinks.length || seen.ran.length;
  const ok = !!reached && !broken;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: ${broken ? "the attacker's text became part of the page " + JSON.stringify(seen)
    : !reached ? 'the place under attack never showed (' + where + '), so nothing was tested' : 'shown as text, nothing ran'}`);
  results.push(ok);
}
// runs a proof: a crash is a FAIL, and the exit code says whether every case passed
function main(fn) {
  fn().then(() => process.exit(results.length && results.every(Boolean) ? 0 : 1),
    (e) => { console.log('FAIL the proof crashed: ' + String((e && e.message) || e).split('\n')[0]); process.exit(1); });
}

module.exports = { URL, bad, asText, attacker, open, clearModal, signUp, textOf, verdict, main };
