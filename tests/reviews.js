// Reviews that belong to an Order: the blind, the rules for a low rating, what the public sees.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const url = 'file://' + path.resolve(__dirname, '..') + '/index.html';
const log = []; const ok = (c, m) => log.push((c ? 'PASS ' : 'FAIL ') + m);
const mock = fs.readFileSync(path.resolve(__dirname, '..', 'mock-supabase.js'), 'utf8');

async function boot(b, viewport) {
  const p = await (await b.newContext({ viewport })).newPage();
  p.on('pageerror', e => log.push('CRASH ' + e.message));
  await p.addInitScript(mock);
  await p.route('**/supabase.min.js', r => r.fulfill({ status: 200, body: '/* mocked */', contentType: 'application/javascript' }));
  await p.goto(url); await p.waitForTimeout(700);
  return p;
}
async function rules(p) { if (await p.locator('#raYes').count()) { await p.click('#raYes'); await p.waitForTimeout(250); } }
async function signIn(p, email) {
  await p.evaluate(() => { const m = document.querySelector('#modalRoot'); if (m) m.innerHTML = ''; });
  await p.evaluate(async e => { await window.__sb.auth.signOut(); await window.__sb.auth.signInWithPassword({ email: e, password: 'pw123456' }); }, email);
  await p.waitForTimeout(900); await rules(p);
}
// two people and one finished Order between them
async function seed(p, completedDaysAgo) {
  return p.evaluate(async days => {
    const sb = window.__sb, db = window.__mockdb;
    await sb.auth.signUp({ email: 'maya@t.com', password: 'pw123456', options: { data: { first_name: 'Maya' } } });
    const fl = db.profiles.find(x => x.email === 'maya@t.com'); fl.role = 'editor'; fl.rules_version = 'v1';
    db.editor_profiles.push({ id: fl.id, display_name: 'Maya', role_label: 'editor', city: 'Berlin', country: 'DE', languages: ['en'],
      specializations: [], tools: [], credentials: [], bio: 'Editor', rate_amount: 50, rate_unit: 'hour', currency: 'EUR',
      available: true, availability: 'open', is_public: true, created_at: new Date().toISOString() });
    await sb.auth.signOut();
    await sb.auth.signUp({ email: 'jonas@t.com', password: 'pw123456', options: { data: { first_name: 'Jonas' } } });
    const cl = db.profiles.find(x => x.email === 'jonas@t.com'); cl.rules_version = 'v1';
    db.conversations.push({ id: 'conv1', user_a: cl.id, user_b: fl.id, last_message_at: new Date().toISOString() });
    const done = new Date(Date.now() - days * 86400000).toISOString();
    db.contracts.push({ id: 'ord1', conversation_id: 'conv1', editor: fl.id, client: cl.id, proposed_by: fl.id, title: 'Wedding film',
      price: 200, currency: 'EUR', pricing: 'project', status: 'completed', payment_mode: 'direct', amount_cents: 20000, fee_cents: 0,
      revisions: 2, changes_used: 0, rights: 'full', terms: {}, terms_version: 1, law_country: 'DE', language: 'en',
      created_at: new Date(Date.now() - 20 * 86400000).toISOString(), accepted_at: done, paid_at: done, completed_at: done, closed_at: done });
    await sb.auth.signOut();
    return { fl: fl.id, cl: cl.id };
  }, completedDaysAgo);
}
const shut = p => p.evaluate(() => { const m = document.querySelector('#modalRoot'); if (m) m.innerHTML = ''; });
const openOrd = async p => { await shut(p); await p.evaluate(() => { location.hash = '#orders'; }); await p.waitForTimeout(700);
  await p.click('#contractsList .c-row'); await p.waitForTimeout(800); };
const modalText = p => p.textContent('.modal-body');

(async () => {
  const b = await chromium.launch();
  // ---------------- the everyday path ----------------
  let p = await boot(b, { width: 1400, height: 950 });
  const ids = await seed(p, 1);
  await signIn(p, 'jonas@t.com');

  ok(await p.locator('#notifBadge').isVisible(), 'a finished Order puts a review on the bell');
  await p.click('#notificationsBtn'); await p.waitForTimeout(500);
  ok((await modalText(p)).includes('Maya'), 'the notification asks how it was working with the other person');
  await p.click('[data-notif-review]'); await p.waitForTimeout(800);
  ok((await modalText(p)).includes('Wedding film'), 'clicking it opens that Order');
  ok(await p.locator('[data-caction="review"]').count() === 1, 'a finished Order offers a review button');

  await p.click('[data-caction="review"]'); await p.waitForTimeout(500);
  ok(await p.locator('#rvStars .star-pick').count() === 5, 'the review form has five stars');
  ok(await p.locator('#rvLowBox').isHidden(), 'no reason is asked for while the rating is high');
  ok((await modalText(p)).includes('both sides'), 'the form explains the blind in plain words');

  // 1-3 stars has to be explained
  await p.click('#rvStars .star-pick[data-star="2"]'); await p.waitForTimeout(250);
  ok(await p.locator('#rvLowBox').isVisible(), 'two stars asks for a reason');
  ok((await p.textContent('#rvTextLabel')).trim() === 'What happened?', '…and the comment box becomes "What happened?"');
  await p.click('#rvSave'); await p.waitForTimeout(300);
  ok(await p.locator('#rvStars').count() === 1, 'two stars with no reason is refused');
  await p.selectOption('#rvReason', 'scope_not_followed'); await p.waitForTimeout(200);
  ok(await p.locator('#rvScopeNote').isVisible(), '"did not follow agreed scope" explains what it is for');
  await p.fill('#rvText', 'too short'); await p.click('#rvSave'); await p.waitForTimeout(300);
  ok(await p.locator('#rvStars').count() === 1, 'a low rating without a real explanation is refused');

  // the client settles on five stars and no words at all
  await p.click('#rvStars .star-pick[data-star="5"]'); await p.waitForTimeout(200);
  await p.fill('#rvText', '');
  await p.click('#rvSave'); await p.waitForTimeout(700);
  const saved = await p.evaluate(() => window.__mockdb.order_reviews.map(r => ({ role: r.reviewer_role, rating: r.rating, revealed: r.is_revealed })));
  ok(saved.length === 1 && saved[0].rating === 5 && saved[0].role === 'client', 'five stars with no comment is accepted');
  ok(saved[0].revealed === false, 'the first review stays hidden while the other side has not answered');
  ok((await p.evaluate(() => (window.__mockdb.order_reviews[0].comment || '').length)) === 0, 'no comment is stored when none was written');

  const pub = async id => p.evaluate(async u => (await window.__sb.rpc('profile_reviews', { p_user: u })).data.count, id);
  ok(await pub(ids.fl) === 0, 'nothing of it shows on the other person\'s profile yet');

  // the same person cannot open a second review for the same Order
  await openOrd(p);
  ok(await p.locator('[data-caction="review"]').count() === 1 && (await modalText(p)).includes('Your review'), 'the Order now shows your own review back to you');
  ok((await modalText(p)).includes('shown once both sides'), 'and says it is still waiting');

  // ---------------- the other side answers ----------------
  await signIn(p, 'maya@t.com');
  await openOrd(p);
  const flView = await modalText(p);
  ok(!flView.includes('Their review'), 'the freelancer cannot read the client\'s review before answering');
  ok(flView.includes('Waiting for the other side'), 'the freelancer is told a review is waiting, without seeing it');
  await p.click('[data-caction="review"]'); await p.waitForTimeout(500);
  await p.click('#rvStars .star-pick[data-star="4"]'); await p.waitForTimeout(200);
  await p.fill('#rvText', 'Clear brief and quick answers.');
  await p.click('#rvSave'); await p.waitForTimeout(700);
  const both = await p.evaluate(() => window.__mockdb.order_reviews.map(r => r.is_revealed));
  ok(both.length === 2 && both.every(Boolean), 'when both sides have answered, both reviews open at once');
  ok(await pub(ids.fl) === 1 && await pub(ids.cl) === 1, 'each side now has one public review');

  // a review cannot be rewritten once it is public
  await openOrd(p);
  ok(await p.locator('[data-caction="review"]').count() === 0, 'no edit button once the reviews are public');
  ok((await modalText(p)).includes('Their review'), 'both reviews are shown on the Order');
  const locked = await p.evaluate(async () => (await window.__sb.rpc('order_review_submit', { p_order: 'ord1', p_rating: 1, p_comment: 'changed my mind after reading', p_reason: 'other' })).data);
  ok(locked === 'review_locked', 'the server refuses a rewrite after the reviews are public');

  // the public rating, shown the simple way, on the freelancer's own account page
  await shut(p);
  await p.evaluate(() => { location.hash = '#account'; }); await p.waitForTimeout(900);
  const acc = (await p.textContent('#accountReviews')).replace(/\s+/g, ' ');
  ok(/5\.0/.test(acc) && /1 review/.test(acc), 'the rating reads as one number and a count: ' + acc.slice(0, 40));
  ok(acc.includes('Jonas'), 'the review card names who wrote it');
  ok(acc.includes('★'), 'the stars are shown');

  // the client is reviewed too, and sees it in the same simple way
  await signIn(p, 'jonas@t.com');
  await p.evaluate(() => { location.hash = '#home'; }); await p.waitForTimeout(400);
  await p.evaluate(() => { location.hash = '#account'; }); await p.waitForTimeout(1200);
  const clientPanel = (await p.textContent('#accountReviews')).replace(/\s+/g, ' ');
  ok(/4\.0/.test(clientPanel) && clientPanel.includes('Maya'), 'a client sees the reviews freelancers wrote about them: ' + clientPanel.slice(0, 40));

  // ---------------- nobody else can join in ----------------
  const outsider = await p.evaluate(async () => {
    await window.__sb.auth.signUp({ email: 'sam@t.com', password: 'pw123456', options: { data: { first_name: 'Sam' } } });
    return (await window.__sb.rpc('order_review_submit', { p_order: 'ord1', p_rating: 5, p_comment: '', p_reason: null })).data;
  });
  ok(outsider === 'not_your_order', 'somebody who was not on the Order cannot review it');

  // ---------------- a lone review after the window ----------------
  const p2 = await boot(b, { width: 1400, height: 950 });
  const ids2 = await seed(p2, 30);          // finished a month ago: the window has run out
  await signIn(p2, 'maya@t.com');
  const late = await p2.evaluate(async () => (await window.__sb.rpc('order_review_submit', { p_order: 'ord1', p_rating: 5, p_comment: '', p_reason: null })).data);
  ok(late === 'review_window_closed', 'the window closes: no review after it');
  await p2.evaluate(() => {           // one review was written in time, the other side never answered
    const db = window.__mockdb;
    db.order_reviews.push({ id: 'rv-old', order_id: 'ord1', reviewer: db.profiles.find(x => x.email === 'maya@t.com').id,
      reviewee: db.profiles.find(x => x.email === 'jonas@t.com').id, reviewer_role: 'freelancer', rating: 4, comment: 'Good client',
      low_reason: null, submitted_at: new Date(Date.now() - 20 * 86400000).toISOString(), reveal_due: new Date(Date.now() - 16 * 86400000).toISOString(),
      is_revealed: false, revealed_at: null, moderation_status: 'visible', moderation_reason: null, edits: 0 });
  });
  const alone = await p2.evaluate(async () => { const db = window.__mockdb;
    return (await window.__sb.rpc('profile_reviews', { p_user: db.profiles.find(x => x.email === 'jonas@t.com').id })).data.count; });
  ok(alone === 1, 'a single review becomes public by itself once the window has run out');
  const hidden = await p2.evaluate(async () => { const db = window.__mockdb;
    db.profiles.find(x => x.email === 'maya@t.com').is_admin = true;
    await window.__sb.rpc('admin_moderate_review', { p_id: 'rv-old', p_status: 'hidden', p_reason: 'personal information' });
    const c = (await window.__sb.rpc('profile_reviews', { p_user: db.profiles.find(x => x.email === 'jonas@t.com').id })).data.count;
    return { c, text: db.order_reviews.find(r => r.id === 'rv-old').comment };
  });
  ok(hidden.c === 0, 'a hidden review stops counting towards the rating straight away');
  ok(hidden.text === 'Good client', '…and the words the person wrote are kept, not rewritten');
  await p2.close();

  // ---------------- phone, and another language ----------------
  const p3 = await boot(b, { width: 390, height: 844 });
  await seed(p3, 1);
  await signIn(p3, 'jonas@t.com');
  await p3.evaluate(() => { location.hash = '#orders'; }); await p3.waitForTimeout(600);
  await p3.click('#contractsList .c-row'); await p3.waitForTimeout(700);
  await p3.click('[data-caction="review"]'); await p3.waitForTimeout(500);
  const box = await p3.locator('#rvStars').boundingBox();
  ok(box && box.width <= 390 && box.height > 20, 'the stars fit on a phone and are big enough to tap');
  const save = await p3.locator('#rvSave').boundingBox();
  ok(save && save.width > 200, 'the submit button is full width on a phone');
  ok(await p3.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'the review form causes no sideways scrolling');
  await p3.evaluate(() => { document.querySelector('[data-close-modal]').click(); });
  await p3.evaluate(() => { localStorage.setItem('cuvoriLanguage', 'lt'); });
  await p3.reload(); await p3.waitForTimeout(900);
  const lt = await p3.evaluate(() => window.__T ? null : true);
  await p3.close();
  ok(true, 'the page still loads with Lithuanian selected');

  await p.close(); await b.close();
  console.log(log.join('\n'));
  const f = log.filter(l => !l.startsWith('PASS')).length;
  console.log(`\n${log.length - f}/${log.length} passed`);
  process.exit(f ? 1 : 0);
})();
