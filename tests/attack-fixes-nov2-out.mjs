// Fixes of 2 November (payouts, decisions and the hourly run): regression checks for the problems the review of 2 November
// proved in the payment code. Both price plans where both are affected.
// D1 an Order in parts (60 + 40) whose client's bank took 40.00 back (a partial chargeback, lost) while the Order held the
//    money: after part 1 used the 60, the Order stayed open for ever holding nothing (part 2 could never be paid, nobody could
//    decide or cancel, the hourly run failed part 2 every hour, both people's accounts could not be deleted). D1a it closes
//    with part 1's payout; D1b one left open (from before) is closed by the hourly run; D1c a part the Order no longer holds
//    enough for is set aside by the hourly run, not tried and failed every hour.
// D2 the last part paid out, but the write that closes the Order was not answered: the client was shown an error although
//    the money moved, and a plan 1 Order stayed open for ever holding nothing.
// D3 Cuvori's decision claimed on the Order, but its record (the "decision" history line) could not be saved: the admin was
//    told nothing had moved, yet the hourly run carried it out ten minutes later with no record, no written decision to the
//    two people and no "lost a dispute" mark. D3a the admin decides the same again; D3b a different decision; D3c a
//    freelancer's cancel (not a decision) is still finished by the hourly run.
// D4 today's prices: the re-payment after a won chargeback made at Stripe, but its answer lost, or the count refused (or
//    saved with its answer lost) right after: the Order counted nothing paid out and had no line for it.
// D5 today's prices: an old notice of a decided chargeback delivered again after another chargeback became the Order's:
//    recorded open again, the Order froze. D5b the same when the "chargeback won" history line could not be saved at first.
// D6 the admin replaces a stuck decision while the Order's payment page holds a charged payment the Order has not recorded:
//    it waited 5 s on the Order's own lock and failed "busy", every time.
// D7 Cuvori's decision worked out from the Order as read before its lock: a part paid out at that moment shrank both shares
//    at settlement, while the decision on record kept the first amounts.
// D8 the hourly run's lists of Orders to try again took any 20: 20 that fail for ever hid every later one. Re-payments
//    (D8a), pull-backs (D8b), second chargebacks to take over (D8c), re-payment lines (D8d), milestone payout lines (D8e),
//    first payment lines (D8f), card fees charged by mistake under the new prices (D8g).
// Run: node tests/attack-fixes-nov2-out.mjs  (TARGET=<folder> runs it against another copy of the payment code)
import { DB, DBQ, STRIPE, V56, users, hooks, req, call, mk, reset, fns, pay, signed, uuid, fund, past } from "./fn-harness.mjs";
import { checkLines, reconcile, listed } from "./plan2-ledger.mjs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const realError = console.error; console.error = () => {};
const guard = async (name, fn) => { try { await fn(); } catch (e) { out.push(`VULNERABLE ${name} threw: ${e && e.stack ? e.stack.split("\n").slice(0, 2).join(" ") : e}`); } finally { reset(); DBQ.paging = false; } };
const fx = await fns();
V56.on = true;                                                        // the fake database keeps v56's rules
STRIPE.balance = 50_000_000_000;                                      // other clients' money in the platform balance
// time moves on when the test says so (hours between hourly runs), and a wait inside the code passes at once
const RealDate = Date; let skew = 0;
globalThis.Date = class extends RealDate { constructor(...a) { if (a.length === 0) super(RealDate.now() + skew); else super(...a); } static now() { return RealDate.now() + skew; } };
const later = (min) => { skew += min * 60e3; };
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...args) => realSetTimeout(() => { if (Number(ms) > 0) skew += Number(ms); fn(...args); }, 0);
const DAY = 1440;
const chargeOf = (pi) => STRIPE.charges[STRIPE.intents[pi].latest_charge];
const webhook = (ev) => call(fx.webhook, req("POST", "x", ev));
const hourly = () => call(fx.autoRelease, req("POST", "x", {}));
const NOTE = "Cuvori looked at the chat and the files.";
const checkout = (c) => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
const approve = (c, milestone_id) => call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, ...(milestone_id ? { milestone_id } : {}) } }));
const cancel = (c) => call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
const resolve = (c, decision, extra = {}) => call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision, note: NOTE, ...extra } }));
const completed = (s) => signed({ type: "checkout.session.completed", data: { object: s } });
const cbEvent = (type, ch, extra = {}) => signed({ type, data: { object: { id: extra.id || "dp_" + ch.id, object: "dispute", charge: ch.id, payment_intent: ch.payment_intent, amount: extra.amount || ch.amount, currency: "eur", status: extra.status || "needs_response", reason: "fraudulent",
  created: (STRIPE.disputes[ch.id] && STRIPE.disputes[ch.id].created) || Math.floor(Date.now() / 1000) } } });
const dispute = async (c, ch, status, extra = {}) => {
  STRIPE.disputes[ch.id] = { ...(STRIPE.disputes[ch.id] || {}), id: extra.id || "dp_" + ch.id, status, ...(extra.amount ? { amount: extra.amount } : {}) };
  const type = ["won", "lost", "warning_closed"].includes(status) ? "charge.dispute.closed" : "charge.dispute.created";
  return webhook(cbEvent(type, ch, { status, ...extra }));
};
const mk2 = (o = {}) => mk({ pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14, ...o });
const mk1 = (o = {}) => mk({ pricing_version: 1, commission_bps: 0, commission_cents: 0, auto_days: 7, ...o });
const row = (c) => DB.contracts.find(x => x.id === c.id) || c;
const lines = (c, kind) => DB.order_payments.filter(p => p.order_id === c.id && (!kind || p.kind === kind));
const sum = (ls) => ls.reduce((a, l) => a + l.amount_cents, 0);
const tsOf = (c) => STRIPE.transfers.filter(t => t.metadata.contract_id === c.id);
const sent = (c) => tsOf(c).reduce((a, t) => a + t.amount - t.amount_reversed, 0);
const back = (c) => STRIPE.refunds.filter(r => r.contract === c.id && !(r.metadata && ["fee_surplus", "late_payment"].includes(r.metadata.kind))).reduce((a, r) => a + r.amount, 0);
const held = (c) => { const x = row(c); return x.funded_cents - x.released_cents - x.refunded_cents; };
const events = (c, ev) => DB.order_events.filter(e => e.order_id === c.id && e.event === ev);
const ms = (c, amounts, status = "submitted") => { c.has_milestones = true; return amounts.map((a, i) => { const m = { id: uuid(), order_id: c.id, title: "part " + (i + 1), amount_cents: a, status, position: i + 1 }; DB.order_milestones.push(m); return m; }); };
const ledger = (c) => { const x = row(c); return [...checkLines(DB, [c.id]), ...reconcile(DB, STRIPE, x), ...listed(DB, x)]; };
const report = (p) => p.length ? " — " + p.slice(0, 3).join(" | ") : "";
async function fund2(c) { const r = await checkout(c); if (r.status !== 200) return { checkout: r }; const s = pay(c.stripe_checkout_id); return { checkout: r, session: s, webhook: await webhook(completed(s)) }; }
async function topUp(c, cents) { c.amount_cents += cents; const r = await checkout(c); if (r.status !== 200) return { checkout: r }; const s = pay(c.stripe_checkout_id); return { checkout: r, session: s, webhook: await webhook(completed(s)) }; }
const ready = (yes) => { STRIPE.accounts.acct_1EditorAAAAAAAA.payouts_enabled = yes; DB.payout_details.find(p => p.id === users.ed.id).stripe_payouts_enabled = yes; };
const dbError = () => new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } });
// the Order counts as money held (schema v56's has_money_held, for this one Order): its people can't delete their accounts
const HELD = ["funded", "delivered", "disputed", "releasing", "resolving"];
const holdsMoney = (x) => HELD.includes(x.status) || x.chargeback_status === "open" || /^chargeback won/.test(x.money_error || "") || /(^| · Also: )chargeback \S+ also (open )?on payment /.test(x.money_error || "");
const PLANS = [["plan 2", mk2, 2], ["plan 1", mk1, 1]];

// ---------- D1 an Order in parts whose partial chargeback was lost while it held the money ----------
async function partialLost(mkX, cbCents = 4000) {
  const c = mkX(); const f = await fund2(c); c.status = "funded";
  const ch = chargeOf(f.session.payment_intent);
  const [m1, m2] = ms(c, [6000, 4000], "pending");
  await dispute(c, ch, "needs_response", { amount: cbCents }); await dispute(c, ch, "lost", { amount: cbCents });
  return { c, m1, m2, ch };
}
for (const [name, mkX, plan] of PLANS) {
  const part1 = plan === 2 ? 5700 : 6000;
  await guard(`D1a [${name}]`, async () => {
    const { c, m1, m2 } = await partialLost(mkX);
    const mid = row(c).status;
    m1.status = "submitted"; m2.status = "submitted"; m2.auto_release_at = new Date(Date.now() + 3 * 86400e3).toISOString();
    const a1 = await approve(c, m1.id);
    const x = row(c), closedAt = x.status;
    const ev = events(c, "completed").find(e => e.data && Array.isArray(e.data.unpaid_parts));
    later(4 * DAY); const h = await hourly();
    const tried = (h.json.failures || []).some(f => f.id === m2.id);
    const a2 = await approve(c, m2.id);
    const p = plan === 2 ? ledger(c) : [];
    vuln(mid !== "funded" || a1.status !== 200 || closedAt !== "completed" || sent(c) !== part1 || held(c) !== 0 || m2.status !== "submitted" || m2.auto_release_at != null || !ev || !ev.data.unpaid_parts.includes(m2.id)
      || tried || a2.status !== 409 || holdsMoney(row(c)) || p.length,
      `D1a [${name}] 40.00 of 100.00 charged back (lost) while held (${mid}); part 1 (60.00) approved -> ${a1.status}: the Order is ${closedAt}, the freelancer has ${sent(c)}, held ${held(c)}; part 2 ${m2.status}, its clock ${m2.auto_release_at ? "still running" : "stopped"}, named unpaid in the history: ${!!ev}; the hourly run tried part 2: ${tried}; approving it -> ${a2.status}; counts as money held: ${holdsMoney(row(c))} (must be completed, ${part1}, 0, part 2 left as it is with no clock, named, not tried, 409, not held)${report(p)}`);
  });
  await guard(`D1b [${name}]`, async () => {
    // left open from before (the close step never ran): the hourly run closes it
    const { c, m1, m2 } = await partialLost(mkX);
    m1.status = "submitted";
    hooks.db = async (method, table, search, body) => (method === "PATCH" && table === "contracts" && /"status":"(completed|refunded)"/.test(body || "") ? dbError() : null);
    const a1 = await approve(c, m1.id);
    hooks.db = null;
    const mid = row(c).status;
    later(10); await hourly();
    const x = row(c);
    vuln(a1.status !== 200 || mid !== "funded" || x.status !== "completed" || held(c) !== 0 || sent(c) !== part1 || m2.status !== "pending" || holdsMoney(x),
      `D1b [${name}] the same, part 1 paid out (${a1.status}) but the Order left open (${mid}); after the hourly run it is ${x.status}, held ${held(c)}, the freelancer has ${sent(c)}, part 2 ${m2.status} (must be completed, 0, ${part1}, pending)`);
  });
  await guard(`D1c [${name}]`, async () => {
    // 70.00 charged back: 30.00 held, less than either part. The hourly run sets both aside (Cuvori decides), never fails them
    const { c, m1, m2 } = await partialLost(mkX, 7000);
    for (const m of [m1, m2]) { m.status = "submitted"; m.auto_release_at = past(1); }
    later(10); const h1 = await hourly(); later(60); const h2 = await hourly();
    const failedParts = [...(h1.json.failures || []), ...(h2.json.failures || [])].filter(f => f.id === m1.id || f.id === m2.id);
    const aside = (h2.json.skipped || []).filter(s => s.id === m1.id || s.id === m2.id).length;
    const r = await resolve(c, "refund");
    vuln(held(c) !== 0 || failedParts.length || aside !== 2 || r.status !== 200 || back(c) !== 3000 || row(c).status !== "refunded",
      `D1c [${name}] 70.00 of 100.00 charged back: 30.00 held for parts of 60.00 and 40.00; the hourly runs failed them ${failedParts.length} time(s), set aside ${aside} of 2; Cuvori's 'refund' -> ${r.status}: the client got back ${back(c)}, ${row(c).status} (must be 0 failures, 2 set aside, 200, 3000, refunded)`);
  });
}

// ---------- D2 the last part paid out, the closing write not answered ----------
for (const [name, mkX, plan] of PLANS) {
  await guard(`D2 [${name}]`, async () => {
    const c = mkX(); await fund2(c); c.status = "funded";
    const [m1] = ms(c, [10000]);
    let refused = false;
    hooks.db = async (method, table, search, body) => { if (!refused && method === "PATCH" && table === "contracts" && /"status":"completed"/.test(body || "")) { refused = true; return dbError(); } return null; };
    const a = await approve(c, m1.id);
    hooks.db = null;
    const mid = row(c).status;
    later(10); await hourly();
    const x = row(c), must = plan === 2 ? 9500 : 10000;
    const p = plan === 2 ? ledger(c) : [];
    vuln(!refused || a.status !== 200 || mid !== "funded" || x.status !== "completed" || sent(c) !== must || held(c) !== 0 || holdsMoney(x) || p.length,
      `D2 [${name}] the last part approved, the Order's closing write refused (${refused}) -> ${a.status} (the payout went through: ${sent(c)}); after the hourly run ${x.status}, held ${held(c)} (must be 200, completed, 0)${report(p)}`);
  });
}

// ---------- D3 Cuvori's decision not on record ----------
async function unrecorded(mkX, opened = true) {
  const c = mkX(); await fund2(c); c.status = "disputed"; c.dispute_by = users.cl.id; c.disputed_at = new Date().toISOString();
  if (opened) DB.order_events.push({ id: uuid(), order_id: c.id, actor: users.cl.id, event: "disputed", data: { note: "bad work" }, created_at: new Date().toISOString() });
  let fired = false;
  hooks.db = async (method, table, search, body) => { if (!fired && method === "POST" && table === "order_events" && /"event":"decision"/.test(body || "")) { fired = true; return dbError(); } return null; };
  const r = await resolve(c, "refund");
  hooks.db = null;
  later(15); await hourly(); later(60); await hourly();
  return { c, r, fired };
}
const decisionNotes = (c) => String(row(c).money_error || "").split(" · Also: ").filter(n => n.startsWith("decision not on record")).length;
const messages = (c) => DB.messages.filter(m => m.conversation_id === c.conversation_id && m.body === `Cuvori decision: ${NOTE}`).length;
const lostFlags = (c) => DB.user_flags.filter(f => f.contract_id === c.id && f.kind === "dispute_lost").length;
for (const [name, mkX, plan] of PLANS) {
  await guard(`D3a [${name}]`, async () => {
    const msgs0 = DB.messages.filter(m => m.body === `Cuvori decision: ${NOTE}`).length;
    const { c, r, fired } = await unrecorded(mkX);
    const mid = { status: row(c).status, back: back(c), notes: decisionNotes(c) };
    row(c).money_error = null;                                       // the admin marks the note as handled: it is not written again
    later(60); await hourly();
    const again = decisionNotes(c);
    const r2 = await resolve(c, "refund");
    const x = row(c), rec = events(c, "decision");
    vuln(!fired || r.status !== 503 || mid.status !== "resolving" || mid.back !== 0 || mid.notes !== 1 || again !== 0 || r2.status !== 200 || x.status !== "refunded" || back(c) !== 10000
      || rec.length !== 1 || rec[0].data.decision !== "refund" || messages(c) - msgs0 < 1 || lostFlags(c) !== 1 || decisionNotes(c) !== 0,
      `D3a [${name}] 'refund' claimed but its record not saved (${r.status}); two hourly runs later: ${mid.status}, the client got back ${mid.back}, note written ${mid.notes} time(s), again after it was marked handled ${again}; the admin decides 'refund' again -> ${r2.status}: ${x.status}, back ${back(c)}, records ${rec.length}, written decision ${messages(c) - msgs0 >= 1}, "lost a dispute" marks ${lostFlags(c)}, note left ${decisionNotes(c)} (must be 503, resolving, 0, 1, 0; 200, refunded, 10000, 1, true, 1, 0)`);
  });
  await guard(`D3b [${name}]`, async () => {
    const { c, r } = await unrecorded(mkX);
    const mid = { status: row(c).status, back: back(c) };
    const r2 = await resolve(c, "release");
    const x = row(c), rec = events(c, "decision"), must = plan === 2 ? 9500 : 10000;
    vuln(r.status !== 503 || mid.status !== "resolving" || mid.back !== 0 || r2.status !== 200 || x.status !== "completed" || sent(c) !== must || back(c) !== 0 || rec.length !== 1 || !rec[0].data.replaced || rec[0].data.replaced.decision !== "refund" || decisionNotes(c) !== 0,
      `D3b [${name}] the same; the admin decides 'release' instead -> ${r2.status}: ${x.status}, the freelancer has ${sent(c)}, the client got back ${back(c)}, records ${rec.length} (naming the one it replaced: ${!!(rec[0] && rec[0].data.replaced)}), while unrecorded ${mid.status} / back ${mid.back} (must be 200, completed, ${must}, 0, 1, true, resolving, 0)`);
  });
  await guard(`D3c [${name}]`, async () => {
    // the freelancer gives the Order back; Stripe does not answer the refund: the hourly run finishes it (not a decision)
    const c = mkX(); await fund2(c); c.status = "delivered";
    let down = true;
    hooks.stripe = async (path, method) => (down && method === "POST" && path === "/refunds" ? [500, { error: { type: "api_error", message: "An unknown error occurred" } }] : null);
    const k = await cancel(c);
    down = false; hooks.stripe = null;
    const mid = row(c).status;
    later(15); await hourly();
    vuln(k.status === 200 || mid !== "resolving" || row(c).status !== "refunded" || back(c) !== 10000 || decisionNotes(c) !== 0,
      `D3c [${name}] the freelancer gives the Order back, the refund fails at first (${k.status}, ${mid}); the hourly run: ${row(c).status}, the client got back ${back(c)}, decision note ${decisionNotes(c)} (must be refunded, 10000, 0)`);
  });
}

// ---------- D4 the re-payment after a won chargeback, its answer lost or its count refused ----------
const origFetch = globalThis.fetch;
let FAULT = null;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url), m = init.method || "GET";
  if (FAULT && !FAULT.fired) {
    if (FAULT.kind === "answer lost" && u.includes("api.stripe.com/v1/transfers") && m === "POST" && /retransfer_/.test(String(init.body))) {
      FAULT.fired = true; await origFetch(url, init); const e = new TypeError("fetch failed"); e.cause = { code: "UND_ERR_SOCKET" }; throw e;
    }
    if (FAULT.armed && u.includes("/rest/v1/contracts") && m === "PATCH" && /released_cents/.test(String(init.body))) {
      if (FAULT.kind === "count refused") { FAULT.fired = true; return dbError(); }
      if (FAULT.kind === "count saved, answer lost") { FAULT.fired = true; await origFetch(url, init); return dbError(); }
    }
  }
  return origFetch(url, init);
};
for (const [name, mkX, plan] of [["plan 1", mk1, 1], ["plan 2", mk2, 2]]) for (const kind of ["answer lost", "count refused", "count saved, answer lost"]) {
  await guard(`D4 [${name}] ${kind}`, async () => {
    const c = mkX(); const f = await fund2(c); c.status = "delivered";
    const ch = chargeOf(f.session.payment_intent);
    await approve(c);
    await dispute(c, ch, "needs_response");
    FAULT = { kind, fired: false, armed: false };
    if (kind !== "answer lost") hooks.stripe = async (path, method, p) => { if (method === "POST" && path === "/transfers" && /retransfer_/.test(p.get("metadata[purpose]") || "")) FAULT.armed = true; return null; };
    const w = await dispute(c, ch, "won");
    hooks.stripe = null;
    const fired = FAULT.fired; FAULT = null;
    const w2 = await webhook(cbEvent("charge.dispute.closed", ch, { status: "won" }));
    later(20); await hourly(); later(DAY); await hourly();
    const x = row(c), must = plan === 2 ? 9500 : 10000;
    const net = sum(lines(c, "release")) - sum(lines(c, "reversal"));
    const p = plan === 2 ? ledger(c) : [];
    vuln(!fired || w2.status !== 200 || sent(c) !== must || x.released_cents !== 10000 || net !== 10000 || held(c) !== 0 || x.status !== "completed" || x.money_error || p.length,
      `D4 [${name}] ${kind} (${fired}): won -> ${w.status}, the notice again -> ${w2.status}; the freelancer has ${sent(c)} in ${tsOf(c).length} transfers; the Order counts paid out ${x.released_cents}, the ledger ${net}, held ${held(c)}, ${x.status}, note ${JSON.stringify(x.money_error)} (must be ${must}, 10000, 10000, 0, completed, no note)${report(p)}`);
  });
}
globalThis.fetch = origFetch;

// ---------- D5 an old notice of a decided chargeback, after another became the Order's ----------
for (const [name, mkX, plan] of [["plan 1", mk1, 1], ["plan 2", mk2, 2]]) for (const outcome of ["lost", "won"]) for (const lineLost of outcome === "won" ? [false, true] : [false]) {
  const tag = `D5${lineLost ? "b" : ""} [${name}] first ${outcome}`;
  await guard(tag, async () => {
    const c = mkX(); const f = await fund2(c); c.status = "funded";
    const ch = chargeOf(f.session.payment_intent);
    const u = await topUp(c, 2000); const ch2 = chargeOf(u.session.payment_intent);
    await dispute(c, ch, "needs_response", { amount: 3000 });
    let refused = false;
    if (lineLost) hooks.db = async (method, table, search, body) => { if (!refused && method === "POST" && table === "order_events" && /"event":"chargeback_won"/.test(body || "")) { refused = true; return dbError(); } return null; };
    const w1 = await dispute(c, ch, outcome, { amount: 3000 });
    hooks.db = null;
    const w1b = lineLost ? await webhook(cbEvent("charge.dispute.closed", ch, { status: outcome, amount: 3000 })) : w1;   // Stripe sends it again
    await dispute(c, ch2, "needs_response"); await dispute(c, ch2, "lost");
    const before = { id: row(c).chargeback_id, st: row(c).chargeback_status };
    const w = await webhook(cbEvent("charge.dispute.funds_withdrawn", ch, { status: "needs_response", amount: 3000 }));
    const after = { id: row(c).chargeback_id, st: row(c).chargeback_status };
    c.status = "delivered";
    const r = await approve(c);
    later(DAY); await hourly();
    const x = row(c);
    vuln((lineLost && (!refused || w1b.status !== 200)) || before.id !== "dp_" + ch2.id || before.st !== "lost" || w.status !== 200 || after.id !== before.id || after.st !== "lost" || r.status !== 200 || x.status !== "completed" || held(c) !== 0,
      `${tag}${lineLost ? ` (its history line refused at first: ${refused}, sent again -> ${w1b.status})` : ""}, the second lost: chargeback ${before.id === "dp_" + ch2.id ? "the second" : before.id} ${before.st}; the first's old notice again -> ${w.status}: chargeback ${after.id === "dp_" + ch2.id ? "the second" : after.id} ${after.st}; the client approves -> ${r.status}; ${x.status}, held ${held(c)} (must be: the second lost, unchanged, 200, completed, 0)`);
  });
}

// ---------- D6 replacing a stuck decision while the payment page holds a charged payment not recorded ----------
await guard("D6", async () => {
  const c = mk({ amount_cents: 10000 });
  await fund(fx, c);
  Object.assign(c, { amount_cents: 15000, price: 150 });
  await checkout(c);
  const s = pay(c.stripe_checkout_id);
  const pi = STRIPE.intents[s.payment_intent], ch = STRIPE.charges[pi.latest_charge];
  pi.status = "succeeded"; pi.amount_received = pi.amount; ch.captured = true; ch.balance_transaction = ch._bt;
  Object.assign(c, { status: "resolving", resolution: "release", split_editor_cents: 10000, refund_cents: 0, resolved_at: past(2), resolved_by: null, amount_cents: 10000, price: 100 });
  const t0 = Date.now();
  const r = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "refund", note: "freelancer account closed, refund the client" } }));
  const took = (Date.now() - t0) / 1000;
  const x = row(c), refunded = STRIPE.refunds.some(y => y.payment_intent === s.payment_intent);
  vuln(r.status !== 200 || took > 4 || x.status !== "refunded" || x.resolution !== "refund" || !refunded || back(c) < 10000,
    `D6 the admin replaces a stuck 'release' with 'refund' while the page holds a charged payment not recorded -> ${r.status} ${r.json && (r.json.code || r.json.error) || ""} after ${took.toFixed(1)} s; ${x.status}/${x.resolution}; that payment back on the card: ${refunded} (must be 200 at once, refunded/refund, true)`);
});

// ---------- D7 the decision's amounts from the Order as it is under its lock ----------
for (const [name, mkX, plan] of PLANS) {
  await guard(`D7 [${name}]`, async () => {
    const c = mkX(); await fund2(c); c.status = "funded";
    const [m1] = ms(c, [6000, 4000]);
    const snap = JSON.parse(JSON.stringify(row(c)));                 // what the admin's request reads first
    const a = await approve(c, m1.id);                                // part 1 paid out at that very moment
    let stale = true;
    hooks.db = async (method, table, search) => {
      if (stale && method === "GET" && table === "contracts" && search.includes(`id=eq.${c.id}`)) { stale = false; return new Response(JSON.stringify([snap]), { status: 200, headers: { "content-type": "application/json" } }); }
      return null;
    };
    const r = await resolve(c, "split", { editor_percent: 50 });
    hooks.db = null;
    const x = row(c), rec = events(c, "decision")[0] || { data: {} };
    const freelancer = plan === 2 ? 5700 + 1900 : 8000;
    vuln(a.status !== 200 || r.status !== 200 || rec.data.editor_cents !== 2000 || rec.data.refund_cents !== 2000 || x.split_editor_cents !== 2000 || x.refund_cents !== 2000 || r.json.editorCents !== 2000 || sent(c) !== freelancer || back(c) !== 2000 || x.status !== "completed",
      `D7 [${name}] part 1 (60.00) paid out while Cuvori's 50/50 split was being made (${a.status}, ${r.status}): on record ${rec.data.editor_cents}/${rec.data.refund_cents}, on the Order ${x.split_editor_cents}/${x.refund_cents}, told ${r.json && r.json.editorCents}; the freelancer has ${sent(c)}, the client got back ${back(c)}, ${x.status} (must be 2000/2000 everywhere, ${freelancer}, 2000, completed)`);
  });
}

// ---------- D8 the hourly run's retry lists: 20 that fail for ever, then one that can be done ----------
const synthetic = new Set();
const stuckOrder = (o) => { const c = mk1({ status: "completed", funded_cents: 10000, released_cents: 0, refunded_cents: 0, ...o }); synthetic.add(c.id); return c; };
// the pull-back at Stripe that such an Order's pull-back line stands for (its payout, pulled back in full, naming the
// chargeback): since the check of 12 November only what Stripe says a chargeback pulled back is paid back, never a line alone
const pulledAtStripe = (c, d, cents) => {
  const now = Date.now() / 1000, tid = `tr_${d.slice(3)}`;
  STRIPE.transfers.push({ id: tid, object: "transfer", created: now, amount: cents, currency: "eur", destination: "acct_1EditorAAAAAAAA", reversed: true, amount_reversed: cents, contract: c.id, metadata: { contract_id: c.id, milestone_id: "", purpose: "release", attempt: "" }, transfer_group: `contract_${c.id}`, source_transaction: null });
  STRIPE.reversals.push({ id: `trr_${d.slice(3)}`, object: "transfer_reversal", amount: cents, transfer: tid, created: now, metadata: { contract_id: c.id, reason: d } });
};
const dropSynthetic = () => {
  for (const t of ["contracts", "order_payments", "order_milestones"]) { const keep = DB[t].filter(r => !synthetic.has(t === "contracts" ? r.id : r.order_id)); DB[t].length = 0; DB[t].push(...keep); }
  for (const t of ["transfers", "reversals"]) { const keep = STRIPE[t].filter(x => !synthetic.has(x.metadata && x.metadata.contract_id)); STRIPE[t].length = 0; STRIPE[t].push(...keep); }
  synthetic.clear();
};
async function starved(tag, makeStuck, makeReal, isDone, what) {
  await guard(tag, async () => {
    for (let i = 0; i < 20; i++) makeStuck(i);
    const real = await makeReal();
    DBQ.paging = true;                                                // like the real database: order and limit apply
    let run = 0;
    for (; run < 4 && !isDone(real); run++) { later(60); await hourly(); }
    DBQ.paging = false;
    vuln(!isDone(real), `${tag} 20 Orders that fail for ever on the list, then ${what}: done after ${run} hourly run(s): ${isDone(real)} (must be done within 4)`);
  });
  dropSynthetic(); users.ed2.banned = false;
}
// D8a re-payments: 20 to a banned freelancer, then one whose freelancer's account is ready again
await starved("D8a", (i) => {
  users.ed2.banned = true;
  const c = stuckOrder({ editor: users.ed2.id, chargeback_status: "won", chargeback_id: `dp_stuck${i}`, money_error: "chargeback won; re-payment pending", released_cents: 0 });
  DB.order_payments.push({ id: uuid(), order_id: c.id, provider: "stripe", status: "succeeded", kind: "reversal", amount_cents: 10000, provider_ref: `tr_stuck${i}`, note: `chargeback dp_stuck${i}`, created_at: new Date().toISOString() });
  pulledAtStripe(c, `dp_stuck${i}`, 10000);
}, async () => {
  const c = mk1(); const f = await fund2(c); c.status = "delivered";
  const ch = chargeOf(f.session.payment_intent);
  await approve(c); await dispute(c, ch, "needs_response");
  ready(false); await dispute(c, ch, "won"); ready(true);
  return c;
}, (c) => sent(c) === 10000 && !/^chargeback won/.test(row(c).money_error || ""), "one whose freelancer is ready again (its re-payment)");
// D8h the 20 that fail for ever are still tried, every hour for a day, then less often (after 1, 2, 4, … hours)
await guard("D8h", async () => {
  users.ed2.banned = true;
  const stuck = [];
  for (let i = 0; i < 20; i++) {
    const c = stuckOrder({ editor: users.ed2.id, chargeback_status: "won", chargeback_id: `dp_h${i}`, money_error: "chargeback won; re-payment pending" });
    DB.order_payments.push({ id: uuid(), order_id: c.id, provider: "stripe", status: "succeeded", kind: "reversal", amount_cents: 10000, provider_ref: `tr_h${i}`, note: `chargeback dp_h${i}`, created_at: new Date().toISOString() });
    pulledAtStripe(c, `dp_h${i}`, 10000);
    stuck.push(c);
  }
  let tried = 0;
  hooks.stripe = async (path, method, p) => { if (method === "GET" && path === "/transfers" && p.get("transfer_group") === `contract_${stuck[0].id}`) tried++; return null; };
  const per = [];
  DBQ.paging = true;
  for (let run = 0; run < 30; run++) { const t0 = tried; later(60); await hourly(); per.push(tried - t0); }
  DBQ.paging = false;
  const firstDay = per.slice(0, 24).filter(n => n > 0).length, after = per.slice(24).filter(n => n > 0).length;
  vuln(firstDay !== 24 || after < 1 || after > 3,
    `D8h one of 20 re-payments that can never be made: tried in ${firstDay} of the first 24 hourly runs, in ${after} of the next 6 (must be 24, then 1 to 3)`);
});
dropSynthetic(); users.ed2.banned = false;
// D8b pull-backs: 20 whose chargeback Stripe no longer has, then one whose pull-back failed at first
await starved("D8b", (i) => stuckOrder({ chargeback_status: "open", chargeback_id: `dp_gone${i}`, money_error: "chargeback: Stripe did not answer (Netlify log ref 0000000a)" }), async () => {
  const c = mk1(); const f = await fund2(c); c.status = "delivered";
  const ch = chargeOf(f.session.payment_intent);
  await approve(c);
  hooks.stripe = async (path, method) => (method === "POST" && /\/reversals$/.test(path) ? [400, { error: { type: "invalid_request_error", message: "The account has insufficient funds" } }] : null);
  await dispute(c, ch, "needs_response");
  hooks.stripe = null;
  return c;
}, (c) => sent(c) === 0 && !/^chargeback:/.test(row(c).money_error || ""), "one whose pull-back failed at first (its pull-back)");
// D8c second chargebacks: 20 whose noted chargeback Stripe does not list, then one Stripe could not be asked about at first
await starved("D8c", (i) => stuckOrder({ chargeback_status: "lost", chargeback_id: `dp_old${i}`, money_error: `chargeback dp_noted${i} also open on payment pi_none${i} (10.00 EUR): Cuvori handles it once chargeback dp_old${i} is done; until then nothing on this Order is paid out or refunded` }), async () => {
  const c = mk1(); const f = await fund2(c); c.status = "funded";
  const ch = chargeOf(f.session.payment_intent);
  const u = await topUp(c, 2000); const ch2 = chargeOf(u.session.payment_intent);
  await dispute(c, ch, "needs_response", { amount: 3000 });
  await dispute(c, ch2, "needs_response");                            // noted: the first is open
  hooks.stripe = async (path, method) => (method === "GET" && path === "/disputes" ? [500, { error: { type: "api_error", message: "An unknown error occurred" } }] : null);
  await dispute(c, ch, "lost", { amount: 3000 });                     // Stripe can't be asked about the next one now
  hooks.stripe = null;
  c._ch2 = "dp_" + ch2.id;
  return c;
}, (c) => row(c).chargeback_id === c._ch2 && !/also (open )?on payment/.test(row(c).money_error || ""), "one Stripe could not be asked about at first (its takeover)");
// D8d re-payment lines: 20 whose re-payment Stripe does not have, then one whose line could not be saved
await starved("D8d", (i) => stuckOrder({ chargeback_status: "won", chargeback_id: `dp_x${i}`, released_cents: 10000, money_error: `ledger line of the re-payment not saved: tr_none${i} (10000 paid again after chargeback dp_x${i}; the hourly run adds it from Stripe's record; if this note stays, check by hand)` }), async () => {
  const c = mk1(); const f = await fund2(c); c.status = "delivered";
  const ch = chargeOf(f.session.payment_intent);
  await approve(c); await dispute(c, ch, "needs_response");
  hooks.db = async (method, table, search, body) => (table === "order_payments" && ((method === "POST" && /chargeback_won/.test(body || "")) || (method === "GET" && /chargeback_won/.test(decodeURIComponent(search)))) ? dbError() : null);
  await dispute(c, ch, "won");
  hooks.db = null;
  return c;
}, (c) => lines(c, "release").some(l => l.note === "chargeback_won") && !/^ledger line of the re-payment/.test(row(c).money_error || ""), "one whose re-payment's line could not be saved (its line)");
// D8e milestone payout lines: 20 whose payout Stripe does not have, then one (paid out over 30 days ago) whose line could not be saved
await starved("D8e", (i) => {
  const c = stuckOrder({ has_milestones: true, released_cents: 1000, money_error: `ledger line of a milestone payout not saved: x${i} (check by hand)` });
  DB.order_milestones.push({ id: uuid(), order_id: c.id, title: "p", amount_cents: 1000, status: "released", position: 1, transfer_ref: `tr_none${i}`, released_at: new Date(Date.now() - 40 * 86400e3).toISOString() });
}, async () => {
  const c = mk1(); await fund2(c); c.status = "funded";
  const [m1] = ms(c, [10000]);
  hooks.db = async (method, table, search, body) => (table === "order_payments" && ((method === "POST" && /"kind":"release"/.test(body || "")) || (method === "GET" && /kind=eq.release&milestone_id/.test(search))) ? dbError() : null);
  await approve(c, m1.id);
  hooks.db = null;
  later(31 * DAY);                                                    // older than the hourly run's 30 days of recent payouts
  return c;
}, (c) => lines(c, "release").length === 1 && !/^ledger line of a milestone/.test(row(c).money_error || ""), "one paid out over 30 days ago whose line could not be saved (its line)");
// D8f first payment lines: 20 whose payment Stripe does not have, then one (paid over 30 days ago) whose line could not be saved
await starved("D8f", (i) => stuckOrder({ stripe_payment_intent: `pi_none${i}`, funded_at: new Date(Date.now() - 40 * 86400e3).toISOString(), fee_cents: 0, money_error: `ledger line of the first payment not saved: pi_none${i} (the hourly run adds it from Stripe's record; if this note stays, check by hand)` }), async () => {
  const c = mk1();
  hooks.db = async (method, table, search, body) => (table === "order_payments" && ((method === "POST" && /"kind":"fund"/.test(body || "")) || (method === "GET" && /kind=eq.fund&provider_ref/.test(search))) ? dbError() : null);
  await fund2(c);
  hooks.db = null;
  later(31 * DAY);
  return c;
}, (c) => lines(c, "fund").length === 1 && !/^ledger line of the first payment/.test(row(c).money_error || ""), "one paid over 30 days ago whose line could not be saved (its line)");
// D8g card fees charged by mistake under the new prices: 20 whose payment Stripe does not have, then one that can go back
await starved("D8g", (i) => {
  const c = stuckOrder({ pricing_version: 2, commission_bps: 500 });
  DB.order_payments.push({ id: uuid(), order_id: c.id, provider: "stripe", status: "succeeded", kind: "fund", amount_cents: 10000, fee_cents: 100, connect_cents: 0, fee_refund_cents: 0, fee_refund_ref: null, provider_fee_cents: 150, provider_ref: `pi_none${i}`, pricing_version: 2, entry_key: `fund:pi_none${i}`, created_at: new Date(Date.now() - 86400e3).toISOString() });
}, async () => {
  const c = mk2(); await fund2(c);
  const l = lines(c, "fund")[0]; l.fee_cents = 100; l.provider_fee_cents = l.provider_fee_cents || 150;   // a page from before the Order took the new prices
  later(5);
  return c;
}, (c) => !!lines(c, "fund")[0].fee_refund_ref && STRIPE.refunds.some(r => r.contract === c.id && r.metadata.kind === "fee_surplus"), "one whose card fee can go back (its refund)");

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
