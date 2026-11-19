// Check of 26 November (both branches): the hourly job's automatic payouts (netlify/functions/stripe-auto-release.mjs).
// H1–H3 a payout that can't go through says so: the freelancer's Stripe setup is not finished, or they are banned. Before,
//    the run skipped the Order (or the part) every hour without a note, a log line or a message, and the Order kept
//    promising a payout "automatically on" a date gone by.
// H4–H6 Orders, stuck steps and parts that can't be paid don't hold back the others: before, only the 50 oldest were tried
//    each hour, and those that failed stayed the oldest for good (and parts of Orders paid directly, which never have a
//    payout, filled the list of parts).
// H7 Netlify stops the hourly job after 30 seconds: the run stops starting new payouts in time and leaves the rest for the
//    next hour.
// H8–H9 a delivery sent back and delivered (or a part handed in) again while the run works is not paid out: its new review
//    period runs.
// H10–H12b Cuvori's decision is told to both sides once (the written reason in the chat, and the "lost a dispute" mark),
//    also when its payout stopped and the hourly run finished it. Before, the hourly run finished it in silence, and the
//    admin's try again found nothing held.
// H13–H14 what stays as it was: a payout that can go through, and other notes on the Order.
// Check of 27 November (the check of the fixes above, before they went up):
// H15–H16 many Orders (or parts) of a banned freelancer hold back nothing, also while their notes are written: the notes
//    were written while the run was still reading its lists, before it looked at the clock, so with 40 of them (300 ms a
//    call) or 200 (60 ms) no automatic payout was made at all, and a run went past Netlify's 30 seconds.
// H17 a part whose freelancer is banned says so (no check covered it).
// H18–H18b "Nothing has moved" is said only when nothing moves: the decision's record refused, the admin does not try
//    again, and the hourly job carried the decision out within the hour, with nobody told.
// H19 the admin finishing a freelancer's cancel that stopped: the admin's note never goes out as the freelancer's.
// H20 a 'release' decision that can't be carried out (a banned freelancer) is told to nobody, or can be replaced.
// H21 a long note (2,000 Chinese characters) is told: the chat was looked up with the whole note in the address, over the
//    16 KB Supabase takes, and the note was never told.
// H22 parts of every protected Order are paid, also with more open Orders than one database answer holds (2,000 were read
//    in one answer, and Supabase answers at most what its "Max rows" setting allows: 1,000 unless changed, 500 here).
// H23–H24 guards of the fix: a decision whose claim did not go through is never told; and the database writes times its
//    own way ("…+00:00"), which must not keep a decision from being told.
// Check of 28 November:
// H25–H27 the hourly run says in the log when something failed or was left for the next hour: Netlify keeps nothing a
//    scheduled function sends back, so its summary (what failed, what was left when its time was up) was read by nobody.
//    No line when nothing is wrong, or when only freelancers' payouts wait (each of those is noted on its Order); and a
//    won chargeback with nothing left to pay back is no failure.
// Check of 29 November:
// H28 what the admin reads when a decision can't be saved: the page showed its own sentence for the code "provider_down"
//    ("The payment service didn't answer. Nothing was lost"), also when the refund under way was then finished by the
//    hourly job without the admin's note.
// H29 a decision carried out more than 7 days ago is never told for the first time now: once production has the new
//    hourly job, every decision the old one finished (told to nobody) would be told on its first run, months late.
// H30 the hourly job's telling step, run in the moment between a decision being saved and its Order being claimed,
//    never removes it: the decision was then carried out and told to nobody.
// Check of 30 November (how the hourly job reads its lists of Orders due and of stopped payouts):
// H31–H31b rows of one same time are each read once: the lists were read 200 rows at a time, sorted by time alone, and
//    Postgres gives rows of one time in no set order, another one for another page (a run gives every Order it starts
//    the same time). On Postgres 16, 50 Orders of one time across the 200-row edge: 12 were read twice and 12 not at
//    all, and those waited another hour.
// H32–H32b only an empty answer ends a list: Supabase answers at most what its "Max rows" allows, and set under 200, a
//    shorter answer was taken for the last one: the Orders after it were never read.
// H33–H33b a profile answer without its "banned" mark decides nothing: it was taken for "banned", the payout held and the
//    admin told the freelancer could not receive payments; the Order's own check decides (it stops on such an answer).
// H33c what stays: a freelancer with no profile counts as banned, as everywhere else.
// H34 the same for the decisions the hourly job tells (main reads them from their records, 200 at a time; pricing-v2 from
//    the Order history): with Supabase's "Max rows" under 200, the first answer was taken for the last one, and a decision
//    whose record came after it was never told. H34b a decision saved while the list is read moves the rest one place on,
//    and the next page gives again the last record of the one before: read twice, that record was taken for an old one
//    and removed, and its decision, still being carried out, would then never be told.
// Run: node tests/attack-hourly-nov26.mjs   (TARGET=<folder> checks another copy)
import fs from "node:fs";
const H = await import("./fn-harness.mjs");
const { DB, STRIPE, users, hooks, mk, fns, fund, past, call, req, uuid } = H;
const fx = await fns();
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const logs = []; const realError = console.error; console.error = (...a) => logs.push(a.map(String).join(" "));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const run = async () => (await fx.autoRelease()).json();
const paid = (c) => STRIPE.transfers.filter(t => t.contract === c.id).reduce((a, t) => a + t.amount, 0);
const NOT_READY = /not ready to receive money/, BANNED = /cannot receive payments/;

// The test database below keeps no order and no limit on a list; the real one does (?order=…&limit=…&offset=…). This
// applies them, so a list of 50 is a list of 50, as on Supabase.
const parse = (q) => { const f = []; for (const [k, v] of new URLSearchParams(q)) { if (["select", "limit", "order", "offset"].includes(k)) continue; const m = v.match(/^(eq|neq|lte|gte|lt|gt|in|is|like)\.(.*)$/); if (m) f.push({ k, op: m[1], v: m[1] === "in" ? m[2].replace(/^\(|\)$/g, "").split(",").map(decodeURIComponent) : m[2] }); } return f; };
const match = (r, f) => f.every(x => x.op === "eq" ? String(r[x.k]) === x.v : x.op === "neq" ? String(r[x.k]) !== x.v : x.op === "in" ? x.v.includes(String(r[x.k])) : x.op === "lte" ? r[x.k] != null && r[x.k] <= x.v : x.op === "lt" ? r[x.k] != null && r[x.k] < x.v : x.op === "gt" ? r[x.k] != null && r[x.k] > x.v : x.op === "gte" ? r[x.k] != null && r[x.k] >= x.v : x.op === "like" ? new RegExp("^" + x.v.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(String(r[x.k] ?? "")) : x.op === "is" ? (x.v === "null" ? r[x.k] == null : r[x.k] != null) : true);
// Rows equal in every column of the order come from Postgres in no set order, and a page asked with another offset may
// give them in another (check of 30 November, seen on Postgres 16). With tiesAnyOrder on, such rows come in an order of
// their own for each offset; otherwise as they stand.
let tiesAnyOrder = false;
const tieKey = (s) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h; };
const realLists = async (method, table, search) => {
  if (method !== "GET" || !["contracts", "order_milestones", "money_keys"].includes(table) || !/[?&]limit=/.test(search)) return null;
  const p = new URLSearchParams(search.slice(1));
  let rows = DB[table].filter(r => match(r, parse(search.slice(1))));
  const ord = p.get("order"), off = +(p.get("offset") || 0), lim = +(p.get("limit") || 1e9);
  if (ord) {
    const keys = ord.split(",").map(o => { const [col, dir] = o.split("."); return { col, sign: dir === "desc" ? -1 : 1 }; });
    rows = [...rows].sort((a, b) => { for (const { col, sign } of keys) { if (a[col] < b[col]) return -sign; if (a[col] > b[col]) return sign; } return tiesAnyOrder ? tieKey(a.id + ":" + off) - tieKey(b.id + ":" + off) : 0; });
  }
  return new Response(JSON.stringify(rows.slice(off, off + lim)), { status: 200, headers: { "content-type": "application/json" } });
};
// each check sees only its own Orders: the ones before are closed
const isolate = () => { for (const c of DB.contracts) c.status = "completed"; for (const m of DB.order_milestones) m.status = "released"; hooks.db = realLists; hooks.stripe = null; };
const ed2 = { acct: () => STRIPE.accounts.acct_1SecondBBBBBBBB, row: () => DB.payout_details.find(p => p.id === users.ed2.id), prof: () => DB.profiles.find(p => p.id === users.ed2.id) };
const notReady = () => { ed2.acct().payouts_enabled = false; ed2.row().stripe_payouts_enabled = false; };
const ready = () => { ed2.acct().payouts_enabled = true; ed2.row().stripe_payouts_enabled = true; ed2.prof().banned = false; };
const funded = async (o = {}) => { const c = mk({ amount_cents: 10000, ...o }); const f = await fund(fx, c); if (c.status !== "funded") throw new Error("funding failed: " + JSON.stringify(f.checkout || f.webhook)); return c; };
const due = (c, h = 1) => { c.status = "delivered"; c.delivered_at = past(h + 168); c.auto_release_at = past(h); return c; };
const logsOf = (id) => logs.filter(l => l.includes(id)).length;

// ===== H1–H3: a payout that can't go through says so =====
{ // H1 the freelancer's Stripe setup is not finished
  isolate(); ready();
  const c = due(await funded({ editor: users.ed2.id }), 30); notReady();
  const before = logsOf(c.id);
  await run(); await run();
  const note1 = c.money_error || "", logged = logsOf(c.id) - before;
  ready(); await run();
  vuln(!(NOT_READY.test(note1) && logged > 0 && c.status === "completed" && paid(c) === 10000 && !c.money_error),
    `H1 automatic payout, freelancer's Stripe setup not finished -> note ${note1 ? JSON.stringify(note1.slice(0, 90)) : "NONE"}, log lines ${logged}; once finished: Order ${c.status}, paid ${paid(c) / 100}, note after ${c.money_error ? JSON.stringify(c.money_error.slice(0, 50)) : "none"} (must: a note saying the payout waits for the freelancer's Stripe setup, a log line, then paid out and the note gone)`);
}
{ // H2 the freelancer is banned
  isolate(); ready();
  const c = due(await funded({ editor: users.ed2.id }), 30); ed2.prof().banned = true;
  await run();
  vuln(!(BANNED.test(c.money_error || "") && c.status === "delivered" && paid(c) === 0),
    `H2 automatic payout, freelancer banned -> Order ${c.status}, paid ${paid(c) / 100}, note ${c.money_error ? JSON.stringify(c.money_error.slice(0, 80)) : "NONE"} (must: nothing paid, a note saying the freelancer can't receive payments)`);
  ready();
}
{ // H3 a part (milestone) with its review period over, the freelancer's Stripe setup not finished
  isolate(); ready();
  const c = await funded({ editor: users.ed2.id, amount_cents: 20000, has_milestones: true });
  const m = { id: uuid(), order_id: c.id, title: "Part 1", amount_cents: 10000, status: "submitted", position: 1, submitted_at: past(200), auto_release_at: past(30) };
  DB.order_milestones.push(m, { id: uuid(), order_id: c.id, title: "Part 2", amount_cents: 10000, status: "pending", position: 2 });
  notReady(); await run();
  const note1 = c.money_error || "";
  ready(); await run();
  vuln(!(NOT_READY.test(note1) && note1.includes(m.id) && m.status === "released" && !c.money_error),
    `H3 a part's automatic payout, freelancer's Stripe setup not finished -> note ${note1 ? JSON.stringify(note1.slice(0, 110)) : "NONE"}; once finished: part ${m.status}, note after ${c.money_error ? "kept" : "none"} (must: a note naming the part, then paid out and the note gone)`);
}

// ===== H4–H6: what can't be paid doesn't hold back the others =====
{ // H4 50 Orders whose freelancer can't be paid, due before one that can be
  isolate(); notReady();
  for (let i = 0; i < 50; i++) mk({ editor: users.ed2.id, status: "delivered", funded_cents: 10000, auto_release_at: past(48 + i), delivered_at: past(300) });
  ready(); const good = due(await funded(), 1); notReady();
  await run();
  vuln(good.status !== "completed", `H4 50 Orders due earlier whose freelancer's Stripe setup isn't finished, one ready Order due later -> after one run the ready Order is ${good.status}, paid ${paid(good) / 100} (must: paid out)`);
  ready();
}
{ // H5 50 stuck payouts (client approved, the freelancer's account then not ready), started before one that can finish
  isolate(); notReady();
  for (let i = 0; i < 50; i++) mk({ editor: users.ed2.id, status: "releasing", resolution: "release", split_editor_cents: 10000, refund_cents: 0, resolved_by: users.cl.id, resolved_at: past(10 + i), funded_cents: 10000 });
  ready(); const good = await funded(); good.status = "releasing"; good.resolution = "release"; good.split_editor_cents = 10000; good.refund_cents = 0; good.resolved_by = users.cl.id; good.resolved_at = past(1); notReady();
  await run();
  vuln(good.status !== "completed", `H5 50 stuck payouts whose freelancer can't be paid, one that can finish -> after one run it is ${good.status}, paid ${paid(good) / 100} (must: finished)`);
  ready();
}
{ // H6 50 parts approved on Orders paid directly (they never have a payout), one approved part of a protected Order never paid out
  isolate(); ready();
  for (let i = 0; i < 50; i++) { const d = mk({ payment_mode: "direct", status: "funded", has_milestones: true }); DB.order_milestones.push({ id: uuid(), order_id: d.id, title: "direct part", amount_cents: 5000, status: "approved", position: 1, approved_at: past(100 + i), transfer_ref: null }); }
  const c = await funded({ amount_cents: 20000, has_milestones: true });
  const m = { id: uuid(), order_id: c.id, title: "approved, payout stopped", amount_cents: 10000, status: "approved", position: 1, approved_at: past(2), transfer_ref: null };
  DB.order_milestones.push(m, { id: uuid(), order_id: c.id, title: "Part 2", amount_cents: 10000, status: "pending", position: 2 });
  await run();
  vuln(m.status !== "released", `H6 50 approved parts of Orders paid directly, one approved part of a protected Order not paid out yet -> after one run that part is ${m.status} (must: released)`);
}

// ===== H7: Netlify's 30 seconds =====
{
  isolate(); ready();
  const cs = []; for (let i = 0; i < 12; i++) cs.push(due(await funded(), 1 + i));
  // every call to Stripe takes 300 ms and every call to the database 60 ms (Netlify to Stripe and to Supabase, assumed)
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => { const u = String(url); await sleep(u.includes("api.stripe.com") ? 300 : u.includes("/rest/v1/") ? 60 : 0); return inner(url, init); };
  const t0 = Date.now();
  try { await run(); } finally { globalThis.fetch = inner; }
  const secs = (Date.now() - t0) / 1000, first = cs.filter(c => c.status === "completed").length;
  for (let i = 0; i < 4 && cs.some(c => c.status !== "completed"); i++) await run();
  vuln(!(secs < 25 && first > 0 && cs.every(c => c.status === "completed" && paid(c) === 10000)),
    `H7 12 Orders due, slow answers -> the run took ${secs.toFixed(1)} s and paid out ${first}; the next runs paid ${cs.filter(c => c.status === "completed").length} of 12 in all, each once (must: under 25 s, so it is never stopped at 30, and the rest in the next runs)`);
}

// ===== H8–H9: delivered again while the run works =====
{ // H8 a whole Order: sent back and delivered again between the run's list and its payout
  isolate(); ready();
  const c = due(await funded(), 1); const later = new Date(Date.now() + 7 * 86400e3).toISOString(); let once = false;
  hooks.stripe = async (path, method) => { if (!once && method === "GET" && path === "/accounts/acct_1EditorAAAAAAAA") { once = true; c.status = "delivered"; c.delivered_at = new Date().toISOString(); c.auto_release_at = later; c.changes_used = (c.changes_used || 0) + 1; } return null; };
  await run(); hooks.stripe = null;
  vuln(!(c.status === "delivered" && paid(c) === 0 && c.auto_release_at === later), `H8 delivered again (new review period) while the run worked -> Order ${c.status}, paid ${paid(c) / 100} (must: not paid, the new review period runs)`);
}
{ // H9 a part: sent back and handed in again between the run's list and its payout
  isolate(); ready();
  const c = await funded({ amount_cents: 20000, has_milestones: true });
  const m = { id: uuid(), order_id: c.id, title: "Part 1", amount_cents: 10000, status: "submitted", position: 1, submitted_at: past(200), auto_release_at: past(1) };
  DB.order_milestones.push(m, { id: uuid(), order_id: c.id, title: "Part 2", amount_cents: 10000, status: "pending", position: 2 });
  const later = new Date(Date.now() + 7 * 86400e3).toISOString(); let once = false;
  hooks.stripe = async (path, method) => { if (!once && method === "GET" && path === "/accounts/acct_1EditorAAAAAAAA") { once = true; m.status = "submitted"; m.submitted_at = new Date().toISOString(); m.auto_release_at = later; } return null; };
  await run(); hooks.stripe = null;
  vuln(!(m.status === "submitted" && paid(c) === 0), `H9 a part handed in again (new review period) while the run worked -> part ${m.status}, paid ${paid(c) / 100} (must: not paid, the new review period runs)`);
}

// ===== H10–H12: Cuvori's decision told to both sides once =====
// (each in a chat of its own, so a message is counted for its own Order only)
const disputed = async () => {
  const c = await funded({ conversation_id: uuid() }); c.status = "disputed"; c.disputed_at = past(2); c.dispute_by = users.cl.id; c.dispute_reason = "not what we agreed";
  DB.order_events.push({ id: uuid(), order_id: c.id, actor: users.cl.id, event: "disputed", data: {}, created_at: past(2) });
  return c;
};
const REASON = "The delivery matches the brief the client wrote.";
const decide = (c) => call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "release", note: REASON } }));
const told = (c) => ({ msgs: DB.messages.filter(m => m.conversation_id === c.conversation_id && String(m.body || "").includes(REASON)).length, marks: DB.user_flags.filter(f => f.contract_id === c.id && f.kind === "dispute_lost").length });
const inAnHour = async () => { const real = Date.now; Date.now = () => real() + 11 * 60e3; try { await run(); } finally { Date.now = real; } };   // a stuck step is picked up after 10 minutes
{ // H10 the payout stops at Stripe; the hourly run finishes it
  isolate(); ready();
  const c = await disputed(); let fail = true;
  hooks.stripe = async (path, method) => { if (fail && method === "POST" && path === "/transfers") { fail = false; return [500, { error: { message: "An error occurred with our connection to Stripe.", type: "api_error" } }]; } return null; };
  const r1 = await decide(c); hooks.stripe = null;
  await inAnHour();
  const t1 = told(c);
  const r2 = await decide(c); const t2 = told(c);
  vuln(!(c.status === "completed" && paid(c) === 10000 && t1.msgs === 1 && t1.marks === 1 && t2.msgs === 1 && t2.marks === 1),
    `H10 decision 'release' with a written reason, its payout stopped at Stripe (${r1.status}), finished by the hourly run -> Order ${c.status}, paid ${paid(c) / 100}, reason in the chat ${t1.msgs}, "lost a dispute" mark ${t1.marks}; the admin's try again (${r2.status}) -> reason ${t2.msgs}, mark ${t2.marks} (must: 1 and 1, never more)`);
}
{ // H11 a decision that goes through at once
  isolate(); ready();
  const c = await disputed(); const r = await decide(c); const t = told(c);
  await inAnHour(); const t2 = told(c);
  vuln(!(r.status === 200 && c.status === "completed" && paid(c) === 10000 && t.msgs === 1 && t.marks === 1 && t2.msgs === 1 && t2.marks === 1),
    `H11 decision 'release' that goes through at once (${r.status}) -> Order ${c.status}, paid ${paid(c) / 100}, reason in the chat ${t.msgs}, mark ${t.marks}; after the next hourly run ${t2.msgs}, ${t2.marks} (must: 1 and 1)`);
}
{ // H12 the database refuses one write while the decision is being made: told once, paid once
  isolate(); ready();
  const c = await disputed(); let refuse = true;
  hooks.db = async (method, table, search, body) => {
    if (refuse && method === "POST" && ((table === "money_keys" && /"scope":"decision:/.test(body || "")) || (table === "order_events" && /"event":"decision"/.test(body || "")) || (table === "messages" && String(body || "").includes(REASON)))) { refuse = false; return new Response(JSON.stringify({ message: "temporarily unavailable" }), { status: 503, headers: { "content-type": "application/json" } }); }
    return realLists(method, table, search);
  };
  const r1 = await decide(c); hooks.db = realLists;
  const r2 = await decide(c); await inAnHour(); const t = told(c);
  vuln(!(c.status === "completed" && paid(c) === 10000 && t.msgs === 1 && t.marks === 1),
    `H12 the database refused one write of the decision (answer ${r1.status}), the admin tried again (${r2.status}) -> Order ${c.status}, paid ${paid(c) / 100}, reason in the chat ${t.msgs}, mark ${t.marks} (must: paid once, told once)`);
}

{ // H12b the database refuses the chat message all through the admin's request; the payout goes through
  isolate(); ready();
  const c = await disputed(); let refuse = true;
  hooks.db = async (method, table, search, body) => {
    if (refuse && method === "POST" && table === "messages" && String(body || "").includes(REASON)) return new Response(JSON.stringify({ message: "temporarily unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
    return realLists(method, table, search);
  };
  const r = await decide(c); refuse = false; hooks.db = realLists; const t0 = told(c);
  await inAnHour(); const t = told(c); await inAnHour(); const t2 = told(c);
  vuln(!(c.status === "completed" && paid(c) === 10000 && t.msgs === 1 && t.marks === 1 && t2.msgs === 1),
    `H12b the chat message refused all through the admin's request (answer ${r.status}, Order ${c.status}, paid ${paid(c) / 100}, reason in the chat ${t0.msgs}) -> after the hourly run: reason ${t.msgs}, mark ${t.marks}; after another: reason ${t2.msgs} (must: told once by the hourly run)`);
}

// ===== H13–H14: what stays as it was =====
{ // H13 an Order whose freelancer can be paid: paid out on the first run, no note
  isolate(); ready();
  const c = due(await funded(), 2); await run();
  const ev = DB.order_events.filter(e => e.order_id === c.id).map(e => e.event);
  vuln(!(c.status === "completed" && paid(c) === 10000 && !c.money_error && ev.includes("auto_released")), `H13 a ready Order due -> ${c.status}, paid ${paid(c) / 100}, note ${c.money_error ? "SOME" : "none"}, history ${ev.includes("auto_released") ? "auto_released" : JSON.stringify(ev)} (must: paid out once, no note)`);
}
{ // H14 another note on the Order stays; the waiting note goes once the payout goes through
  isolate(); ready();
  const OTHER = "top-up pi_TESTX1 may not be recorded — check by hand";
  const c = due(await funded({ editor: users.ed2.id }), 5); c.money_error = OTHER; notReady();
  await run(); const both = c.money_error || "";
  ready(); await run();
  vuln(!(both.includes(OTHER) && NOT_READY.test(both) && c.status === "completed" && c.money_error === OTHER),
    `H14 an Order with another note, its freelancer not ready -> note ${JSON.stringify(both.slice(0, 120))}; once paid out -> ${JSON.stringify(c.money_error)} (must: both while it waits, only the other one after)`);
}

// ===== H15–H17: what can't be paid holds back nothing, also while its notes are written =====
// Every call to Stripe or the database counts as `ms` on a clock the run reads (performance.now); nothing really waits.
// The run's time when it ends is returned.
// (dbCalls: the addresses of the database calls the last run made)
let dbCalls = [];
const onClock = async (ms, fn) => {
  const inner = globalThis.fetch, realNow = performance.now; let t = 0; dbCalls = [];
  globalThis.fetch = async (url, init) => { const u = String(url); if (u.includes("/rest/v1/")) dbCalls.push(u); if (u.includes("api.stripe.com") || u.includes("/rest/v1/")) t += ms; return inner(url, init); };
  performance.now = () => t;
  try { await fn(); } finally { globalThis.fetch = inner; performance.now = realNow; }
  return t;
};
const secs = (ts) => ts.map(t => (t / 1000).toFixed(1)).join(", ");
for (const [id, n, ms] of [["H15", 200, 60], ["H15b", 40, 300]]) { // Orders of a banned freelancer due before one ready Order
  isolate(); ready();
  const banned = []; for (let i = 0; i < n; i++) banned.push(mk({ editor: users.ed2.id, status: "delivered", funded_cents: 10000, auto_release_at: past(48 + i), delivered_at: past(400) }));
  const good = due(await funded(), 1); ed2.prof().banned = true;
  // hourly runs until every one has its note (8 at most), then one more
  const times = []; let at = 0, noted = 0;
  for (let h = 1; h <= 8 && noted < n; h++) {
    times.push(await onClock(ms, run)); if (!at && good.status === "completed") at = h;
    noted = banned.filter(c => BANNED.test(c.money_error || "")).length;
  }
  times.push(await onClock(ms, run));
  const ids = new Set(banned.map(c => c.id)), last = dbCalls.filter(u => [...u.matchAll(/[?&]id=eq\.([0-9a-f-]{36})/g)].some(x => ids.has(x[1]))).length;
  vuln(!(at === 1 && paid(good) === 10000 && Math.max(...times) < 28e3 && noted === n && last === 0),
    `${id} ${n} Orders of a banned freelancer due before one ready Order, every call ${ms} ms -> the ready Order paid on run ${at || "NONE"}; the runs took ${secs(times)} s; ${noted} of ${n} have their note; the run after that read or wrote ${last} of them one by one (must: paid on the first run, every run under 28 s so Netlify's 30 never stops it, each noted within 8 runs, and a note already there costs no call)`);
  ready();
}
{ // H16 parts of a banned freelancer's Orders due before one ready part, every call 60 ms
  isolate(); ready();
  const parts = [];
  for (let i = 0; i < 200; i++) {
    const o = mk({ editor: users.ed2.id, status: "funded", amount_cents: 20000, funded_cents: 20000, has_milestones: true });
    const p = { id: uuid(), order_id: o.id, title: "Part 1", amount_cents: 10000, status: "submitted", position: 1, submitted_at: past(400), auto_release_at: past(48 + i) };
    DB.order_milestones.push(p); parts.push([o, p]);
  }
  const c = await funded({ amount_cents: 20000, has_milestones: true });
  const m = { id: uuid(), order_id: c.id, title: "Part 1", amount_cents: 10000, status: "submitted", position: 1, submitted_at: past(400), auto_release_at: past(1) };
  DB.order_milestones.push(m, { id: uuid(), order_id: c.id, title: "Part 2", amount_cents: 10000, status: "pending", position: 2 });
  ed2.prof().banned = true;
  const times = []; let at = 0;
  for (let h = 1; h <= 4; h++) { times.push(await onClock(60, run)); if (!at && m.status === "released") at = h; }
  const noted = parts.filter(([o, p]) => BANNED.test(o.money_error || "") && (o.money_error || "").includes(p.id)).length;
  vuln(!(at === 1 && paid(c) === 10000 && Math.max(...times) < 28e3 && noted === 200),
    `H16 200 parts of a banned freelancer due before one ready part, every call 60 ms -> the ready part paid on run ${at || "NONE of 4"}; the runs took ${secs(times)} s; ${noted} of 200 have their note (must: paid on the first run, every run under 28 s, each noted)`);
  ready();
}
{ // H17 a part with its review period over, its freelancer banned
  isolate(); ready();
  const c = await funded({ editor: users.ed2.id, amount_cents: 20000, has_milestones: true });
  const m = { id: uuid(), order_id: c.id, title: "Part 1", amount_cents: 10000, status: "submitted", position: 1, submitted_at: past(200), auto_release_at: past(30) };
  DB.order_milestones.push(m, { id: uuid(), order_id: c.id, title: "Part 2", amount_cents: 10000, status: "pending", position: 2 });
  ed2.prof().banned = true; await run(); await run();
  const note1 = c.money_error || "", paid1 = paid(c);
  ready(); await run();
  vuln(!(BANNED.test(note1) && note1.includes(m.id) && paid1 === 0 && m.status === "released" && paid(c) === 10000 && !c.money_error),
    `H17 a part's automatic payout, freelancer banned -> note ${note1 ? JSON.stringify(note1.slice(0, 110)) : "NONE"}, paid ${paid1 / 100}; the ban lifted: part ${m.status}, paid ${paid(c) / 100}, note after ${c.money_error ? "kept" : "none"} (must: nothing paid and a note naming the part, then paid out and the note gone)`);
}

// ===== H18–H21: Cuvori's decisions =====
const NOTHING = /nothing (has )?moved|nothing moves|nothing was changed|nothing changed/i;
const refuseRecord = () => { let refuse = true; return async (method, table, search, body) => {
  if (refuse && method === "POST" && ((table === "money_keys" && /"scope":"decision:/.test(body || "")) || (table === "order_events" && /"event":"decision"/.test(body || "")))) { refuse = false; return new Response(JSON.stringify({ message: "temporarily unavailable" }), { status: 503, headers: { "content-type": "application/json" } }); }
  return realLists(method, table, search);
}; };
const refundedOf = (c) => STRIPE.refunds.filter(r => r.contract === c.id && !(r.metadata && r.metadata.kind === "fee_surplus")).reduce((a, r) => a + r.amount, 0);
const errOf = (r) => String((r.json || {}).error || "");
{ // H18 the decision's record refused; the admin does not try again; the hourly job runs
  isolate(); ready();
  const c = await disputed(); hooks.db = refuseRecord();
  const r = await decide(c); hooks.db = realLists;
  await inAnHour(); await inAnHour();
  const paidThen = paid(c), after = `Order ${c.status}, paid ${paidThen / 100}, reason in the chat ${told(c).msgs}`;
  const r2 = await decide(c); const t = told(c);
  vuln(!((!NOTHING.test(errOf(r)) || paidThen === 0) && c.status === "completed" && paid(c) === 10000 && t.msgs === 1 && t.marks === 1),
    `H18 the decision's record refused (answer ${r.status} ${JSON.stringify(errOf(r).slice(0, 90))}), no try again -> after the hourly job: ${after}; the admin decides again (${r2.status}) -> Order ${c.status}, paid ${paid(c) / 100}, reason ${t.msgs}, mark ${t.marks} (must: "nothing has moved" only when nothing moves until the admin decides again; then paid once, told once)`);
}
{ // H18b a freelancer's cancel whose refund stopped at Stripe: the admin finishes it with a note, and its record is refused
  isolate(); ready();
  const c = await funded({ conversation_id: uuid() }); let fail = true;
  hooks.stripe = async (path, method) => { if (fail && method === "POST" && path === "/refunds") { fail = false; return [500, { error: { message: "An error occurred with our connection to Stripe.", type: "api_error" } }]; } return null; };
  const r0 = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id, note: "I can't do this one, sorry." } })); hooks.stripe = null;
  hooks.db = refuseRecord();
  const r = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "refund", note: "Finishing the freelancer's cancel." } })); hooks.db = realLists;
  const before = refundedOf(c); await inAnHour();
  vuln(NOTHING.test(errOf(r)) && refundedOf(c) > before,
    `H18b the freelancer's cancel stopped (${r0.status}); the admin finishes it, its record refused (answer ${r.status} ${JSON.stringify(errOf(r).slice(0, 110))}) -> within the hour: Order ${c.status}, refunded ${refundedOf(c) / 100} (must: the answer never says nothing has moved when the hourly job then moves it)`);
}
{ // H19 a freelancer's cancel whose refund stopped at Stripe: the admin finishes it with a written note
  isolate(); ready();
  const c = await funded({ conversation_id: uuid() }); let fail = true;
  hooks.stripe = async (path, method) => { if (fail && method === "POST" && path === "/refunds") { fail = false; return [500, { error: { message: "An error occurred with our connection to Stripe.", type: "api_error" } }]; } return null; };
  const r0 = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id, note: "I can't do this one, sorry." } })); hooks.stripe = null;
  const NOTE = "Finishing the freelancer's cancel: the client gets the money back.";
  const r = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "refund", note: NOTE } }));
  await inAnHour();
  const sent = DB.messages.filter(m => m.conversation_id === c.conversation_id && String(m.body || "").includes(NOTE));
  const who = (id) => id === users.adm.id ? "the admin" : id === users.ed.id ? "the FREELANCER" : id === users.cl.id ? "the CLIENT" : String(id);
  vuln(!(c.status === "refunded" && refundedOf(c) === 10000 && sent.every(m => m.sender === users.adm.id) && sent.length <= 1),
    `H19 the freelancer's cancel stopped (${r0.status}); the admin finishes it with a note (${r.status}) -> Order ${c.status}, refunded ${refundedOf(c) / 100}; the note in the chat: ${sent.length ? sent.map(m => "from " + who(m.sender)).join(", ") : "not sent"} (must: refunded, and the note never from the freelancer: from the admin, once)`);
}
{ // H20 a 'release' decision whose freelancer is banned: it can't be carried out
  isolate(); ready();
  const c = await funded({ editor: users.ed2.id, conversation_id: uuid() }); c.status = "disputed"; c.disputed_at = past(2); c.dispute_by = users.cl.id;
  DB.order_events.push({ id: uuid(), order_id: c.id, actor: users.cl.id, event: "disputed", data: {}, created_at: past(2) });
  ed2.prof().banned = true;
  const r1 = await decide(c); await inAnHour();
  const marked = (id) => DB.user_flags.filter(f => f.contract_id === c.id && f.kind === "dispute_lost" && f.user_id === id).length;
  const a = { msgs: told(c).msgs, client: marked(users.cl.id), paid: paid(c) };
  const r2 = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "refund", note: "Refunded instead." } }));
  const b = { client: marked(users.cl.id), freelancer: marked(users.ed2.id) };
  vuln(!(a.paid === 0 && ((a.msgs === 0 && a.client === 0) || (r2.status === 200 && b.client === 0 && b.freelancer === 1))),
    `H20 decision 'release', freelancer banned (${r1.status}) -> after the hourly job: paid ${a.paid / 100}, reason in the chat ${a.msgs}, client marked ${a.client}; the admin decides 'refund' instead (${r2.status}) -> client marked ${b.client}, freelancer marked ${b.freelancer} (must: nothing paid, and either nobody told or marked, or the decision can be replaced and the mark moves)`);
  ready();
}
{ // H21 a note of 2,000 Chinese characters; the database's gateway refuses an address over 16 KB (Supabase's limit: a 520)
  isolate(); ready();
  const c = await disputed();
  let LONG = ""; while ([...LONG].length < 2000) LONG += "交付内容与约定一致。"; LONG = [...LONG].slice(0, 2000).join("");
  let refused = 0;
  hooks.db = async (method, table, search, body) => { if (`/rest/v1/${table}${search || ""}`.length > 16384) { refused++; return new Response("<html>520</html>", { status: 520, headers: { "content-type": "text/html" } }); } return realLists(method, table, search); };
  const r = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "release", note: LONG } }));
  await inAnHour(); await inAnHour(); hooks.db = realLists;
  const n = DB.messages.filter(m => m.conversation_id === c.conversation_id && String(m.body || "").startsWith("Cuvori decision: 交付内容")).length;
  vuln(!(r.status === 200 && c.status === "completed" && n === 1),
    `H21 decision with a note of 2,000 Chinese characters (${r.status}) -> Order ${c.status}, the note in the chat ${n} time(s) after the request and two hourly runs; ${refused} request(s) refused as too long (must: told once)`);
}

// ===== H23–H24: guards of the decision fix =====
{ // H23 a decision whose claim does not go through (the Order changed a moment before); the admin decides again, the same way
  isolate(); ready();
  const c = await disputed(); const A = "First reason, the claim did not go through.", B = "Second reason, carried out.";
  let once = true;
  hooks.db = async (method, table, search, body) => {
    if (once && method === "PATCH" && table === "contracts" && /"status":"resolving"/.test(body || "")) { once = false; return new Response("[]", { status: 200, headers: { "content-type": "application/json" } }); }
    return realLists(method, table, search);
  };
  const r1 = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "release", note: A } })); hooks.db = realLists;
  const r2 = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "release", note: B } }));
  await inAnHour(); await inAnHour();
  const n = (t) => DB.messages.filter(m => m.conversation_id === c.conversation_id && String(m.body || "").includes(t)).length;
  vuln(!(r1.status === 409 && r2.status === 200 && c.status === "completed" && n(A) === 0 && n(B) === 1),
    `H23 a decision whose claim did not go through (${r1.status}), then the same decision again (${r2.status}) -> Order ${c.status}; the first reason in the chat ${n(A)}, the second ${n(B)} after two hourly runs (must: only the second, once)`);
}
{ // H24 the database writes times its own way ("2026-11-27T10:00:00.123+00:00"), as Postgres does
  isolate(); ready();
  const c = await disputed();
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const r = await inner(url, init);
    if (!String(url).includes("/rest/v1/")) return r;
    const txt = await r.text();
    return new Response(txt.replace(/("(?:resolved_at|created_at|closed_at|completed_at)":")(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)Z"/g, "$1$2+00:00\""), { status: r.status, headers: r.headers });
  };
  let r, t, t2;
  try { r = await decide(c); t = told(c); await inAnHour(); t2 = told(c); } finally { globalThis.fetch = inner; }
  vuln(!(r.status === 200 && c.status === "completed" && paid(c) === 10000 && t.msgs === 1 && t.marks === 1 && t2.msgs === 1 && t2.marks === 1),
    `H24 times written "…+00:00" by the database -> decision ${r.status}, Order ${c.status}, paid ${paid(c) / 100}, reason in the chat ${t.msgs}, mark ${t.marks}; after the hourly run ${t2.msgs}, ${t2.marks} (must: 1 and 1)`);
}

// ===== H22: parts of every protected Order, however many are open =====
{ // 2,000 other protected Orders open, whose ids sort first; the database answers at most 500 rows (Supabase's "Max rows" set lower)
  isolate(); ready();
  for (let i = 0; i < 2000; i++) mk({ id: "0" + uuid().slice(1), status: "funded", amount_cents: 10000, funded_cents: 10000 });
  const c = mk({ id: "ffffffff-ffff-4fff-bfff-ffffffffffff", amount_cents: 20000, has_milestones: true }); await fund(fx, c);
  const m = { id: uuid(), order_id: c.id, title: "Part 1", amount_cents: 10000, status: "submitted", position: 1, submitted_at: past(400), auto_release_at: past(1) };
  DB.order_milestones.push(m, { id: uuid(), order_id: c.id, title: "Part 2", amount_cents: 10000, status: "pending", position: 2 });
  hooks.db = async (method, table, search, body) => { const r = await realLists(method, table, search, body); if (!r) return r; const rows = await r.json(); return new Response(JSON.stringify(rows.slice(0, 500)), { status: 200, headers: { "content-type": "application/json" } }); };
  await run(); await run(); hooks.db = realLists;
  vuln(!(m.status === "released" && paid(c) === 10000), `H22 2,000 other protected Orders open (their ids first), at most 500 rows an answer -> the due part of the last one is ${m.status}, paid ${paid(c) / 100} (must: paid out)`);
}

// ===== H25–H27: the hourly run's summary in the log =====
const SUMMARY = /^hourly run summary:/;
const runLogged = async (fn = run) => { const from = logs.length; const r = await fn(); return { r, lines: logs.slice(from).filter(l => SUMMARY.test(l)) }; };
{ // H25 a payout that fails at Stripe
  isolate(); ready();
  const c = due(await funded(), 1); let fail = true;
  hooks.stripe = async (path, method) => { if (fail && method === "POST" && path === "/transfers") { fail = false; return [500, { error: { message: "An error occurred with our connection to Stripe.", type: "api_error" } }]; } return null; };
  const { lines } = await runLogged(); hooks.stripe = null;
  vuln(!(lines.length === 1 && /\b1 failed\b/.test(lines[0]) && lines[0].includes(c.id)),
    `H25 an automatic payout that failed at Stripe -> summary lines in the log: ${lines.length}${lines[0] ? " " + JSON.stringify(lines[0].slice(0, 160)) : ""} (must: one line saying 1 failed and naming the Order)`);
}
{ // H26 the run's time is up before every Order due is paid (every call 300 ms on the run's clock)
  isolate(); ready();
  for (let i = 0; i < 12; i++) due(await funded(), 1 + i);
  let res = null; const from = logs.length;
  await onClock(300, async () => { res = await run(); });
  const lines = logs.slice(from).filter(l => SUMMARY.test(l)), left = res && res.waiting;
  vuln(!(left > 0 && lines.length === 1 && new RegExp(`\\b${left} left for the next hour\\b`).test(lines[0])),
    `H26 12 Orders due, the run's time up -> it left ${left} for the next hour; summary lines in the log: ${lines.length}${lines[0] ? " " + JSON.stringify(lines[0].slice(0, 160)) : ""} (must: one line saying how many were left)`);
}
{ // H27 nothing wrong: a payout that goes through; payouts that wait for their freelancer; a won chargeback with nothing to pay back
  isolate(); ready();
  const c = due(await funded(), 1);
  const a = await runLogged();
  isolate(); ready();
  const b1 = due(await funded({ editor: users.ed2.id }), 3); ed2.prof().banned = true;
  const b = await runLogged();
  isolate(); ready();
  const n1 = due(await funded({ editor: users.ed2.id }), 3); notReady();
  const n = await runLogged(); ready();
  isolate(); ready();
  const w = mk({ status: "funded", amount_cents: 10000, funded_cents: 10000, chargeback_status: "won", chargeback_id: "dp_" + uuid().replace(/-/g, "").slice(0, 14), money_error: "chargeback won, re-payment failed: Stripe did not answer (Netlify log ref 0a1b2c3d)" });
  const x = await runLogged();
  vuln(!(c.status === "completed" && !a.lines.length && !b.lines.length && !n.lines.length && !x.lines.length),
    `H27 a payout that went through -> summary lines ${a.lines.length}; a banned freelancer's payout -> ${b.lines.length}; a freelancer's Stripe setup not finished -> ${n.lines.length}; a won chargeback with nothing to pay back -> ${x.lines.length}${x.lines[0] ? " " + JSON.stringify(x.lines[0].slice(0, 120)) : ""} (must: none: nothing failed and nothing was left)`);
}

// ===== H28–H30: Cuvori's decisions (check of 29 November) =====
const ROOT = process.env.TARGET || new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const lib = await import(ROOT + "/netlify/lib/cuvori.mjs");          // the same copy the functions use
{ // H28 what the admin reads (the page's own words, in English) when the decision's record is refused
  const page = fs.readFileSync(ROOT + "/index.html", "utf8");
  const fnSrc = (page.match(/function fnPlain\(e,pay\)\{[\s\S]*?\n  \}/) || [""])[0];
  const word = (k) => { const m = page.match(new RegExp(k + ':"((?:[^"\\\\]|\\\\.)*)"')); return m ? JSON.parse('"' + m[1] + '"') : "KEY:" + k; };
  const fnPlain = new Function("t", "fill", "isAdmin", fnSrc + "\nreturn fnPlain;")(word, (x, o) => x.replace(/\{(\w+)\}/g, (_, k) => o[k]), () => true);
  const reads = (r) => { const j = r.json || {}; const e = { status: r.status, code: typeof j.code === "string" ? j.code : null, message: j.error || "", reason: j.error || "" }; return (r.status >= 400 && fnPlain(e, false)) || e.message; };
  // A: a fresh decision
  isolate(); ready();
  const a = await disputed(); hooks.db = refuseRecord();
  const ra = await decide(a); hooks.db = realLists; const saidA = reads(ra);
  await inAnHour();
  // B: finishing a freelancer's cancel whose refund stopped at Stripe
  isolate(); ready();
  const b = await funded({ conversation_id: uuid() }); let fail = true;
  hooks.stripe = async (path, method) => { if (fail && method === "POST" && path === "/refunds") { fail = false; return [500, { error: { message: "An error occurred with our connection to Stripe.", type: "api_error" } }]; } return null; };
  await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: b.id, note: "I can't do this one, sorry." } })); hooks.stripe = null;
  hooks.db = refuseRecord();
  const rb = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: b.id, decision: "refund", note: "Finishing the freelancer's cancel." } })); hooks.db = realLists;
  const saidB = reads(rb), before = refundedOf(b); await inAnHour(); const movedB = refundedOf(b) > before;
  const okA = ra.status < 400 || (paid(a) === 0 && !/payment service/i.test(saidA));
  const okB = rb.status < 400 || !movedB || /hourly/i.test(saidB);
  vuln(!(okA && okB),
    `H28 a decision whose record is refused -> the admin reads ${JSON.stringify(ra.status < 400 ? "(went through)" : saidA.slice(0, 110))}, paid ${paid(a) / 100} after the hourly job; finishing a stopped cancel -> the admin reads ${JSON.stringify(rb.status < 400 ? "(went through)" : saidB.slice(0, 130))}, refund then made by the hourly job: ${movedB} (must: what really happened, never "the payment service didn't answer"; and when the hourly job still makes the refund, say so)`);
}
{ // H29 decisions carried out by a step that told nobody (the hourly job running in production today): 1 and 30 days later
  const late = async (days) => {
    isolate(); ready();
    const c = await disputed(); let fail = true;
    hooks.stripe = async (path, method) => { if (fail && method === "POST" && path === "/transfers") { fail = false; return [500, { error: { message: "An error occurred with our connection to Stripe.", type: "api_error" } }]; } return null; };
    await decide(c); hooks.stripe = null;
    const atFirst = told(c).msgs;
    if (c.status === "resolving") await lib.settle({ ...c }, null, "resolved_release");      // finished without telling anyone
    const real = Date.now; Date.now = () => real() + days * 86400e3; try { await run(); } finally { Date.now = real; }
    return { status: c.status, paid: paid(c), atFirst, after: told(c).msgs };
  };
  const d1 = await late(1), d30 = await late(30);
  vuln(!(d1.status === "completed" && d1.after === 1 && d30.status === "completed" && d30.after === d30.atFirst && d30.after <= 1),
    `H29 a decision carried out without being told -> 1 day later the hourly job: reason in the chat ${d1.atFirst} -> ${d1.after}; 30 days later: ${d30.atFirst} -> ${d30.after} (must: told within 7 days, never for the first time after that)`);
}
{ // H30 the hourly job's telling step runs between the decision being saved and its Order being claimed
  isolate(); ready();
  const c = await disputed(); let once = true;
  hooks.db = async (method, table, search, body) => {
    if (once && method === "PATCH" && table === "contracts" && /"status":"resolving"/.test(body || "")) { once = false; await lib.tellDecisions(); }
    return realLists(method, table, search);
  };
  const r = await decide(c); hooks.db = realLists; await inAnHour();
  const t = told(c);
  vuln(!(r.status === 200 && c.status === "completed" && paid(c) === 10000 && t.msgs === 1 && t.marks === 1),
    `H30 the telling step ran between the decision's record and its claim -> decision ${r.status}, Order ${c.status}, paid ${paid(c) / 100}, reason in the chat ${t.msgs}, mark ${t.marks} (must: 1 and 1)`);
}

// ===== H31–H33c (check of 30 November): how the lists are read =====
const stopped = (c, at) => Object.assign(c, { status: "releasing", resolution: "release", split_editor_cents: 10000, refund_cents: 0, resolved_by: users.cl.id, resolved_at: at });
{ // H31 50 Orders due at one same time, across the 200-row page edge, behind 175 Orders of a banned freelancer
  isolate(); ready();
  for (let i = 0; i < 175; i++) mk({ editor: users.ed2.id, status: "delivered", funded_cents: 10000, auto_release_at: past(48 + i), delivered_at: past(400) });
  const at = past(30), cs = [];
  for (let i = 0; i < 50; i++) { const c = await funded(); c.status = "delivered"; c.delivered_at = past(200); c.auto_release_at = at; cs.push(c); }
  ed2.prof().banned = true; tiesAnyOrder = true;
  try { await run(); } finally { tiesAnyOrder = false; }
  const n = cs.filter(c => c.status === "completed" && paid(c) === 10000).length;
  vuln(n !== 50, `H31 50 Orders due at one same time across the 200-row page edge, behind 175 of a banned freelancer, the database giving rows of one time in an order of its own for each page -> after one run ${n} of 50 paid out (must: all 50, each read once)`);
  ready();
}
{ // H31b 50 stopped payouts started by one run (one same time), across the page edge, behind 175 of a banned freelancer
  isolate(); ready();
  for (let i = 0; i < 175; i++) stopped(mk({ editor: users.ed2.id, funded_cents: 10000 }), past(10 + i));
  const at = past(5), cs = [];
  for (let i = 0; i < 50; i++) cs.push(stopped(await funded(), at));
  ed2.prof().banned = true; tiesAnyOrder = true;
  try { await run(); } finally { tiesAnyOrder = false; }
  const n = cs.filter(c => c.status === "completed" && paid(c) === 10000).length;
  vuln(n !== 50, `H31b 50 stopped payouts of one same time across the 200-row page edge, behind 175 of a banned freelancer, rows of one time in an order of their own for each page -> after one run ${n} of 50 finished (must: all 50)`);
  ready();
}
// the database answers at most n rows (Supabase's "Max rows" set lower)
const maxRows = (n) => async (method, table, search, body) => { const r = await realLists(method, table, search, body); if (!r) return r; const rows = await r.json(); return new Response(JSON.stringify(rows.slice(0, n)), { status: 200, headers: { "content-type": "application/json" } }); };
{ // H32 at most 100 rows an answer (under a page of 200): 150 Orders of a banned freelancer due first, then one ready
  isolate(); ready();
  for (let i = 0; i < 150; i++) mk({ editor: users.ed2.id, status: "delivered", funded_cents: 10000, auto_release_at: past(48 + i), delivered_at: past(400) });
  const good = due(await funded(), 1); ed2.prof().banned = true;
  hooks.db = maxRows(100);
  try { await run(); } finally { hooks.db = realLists; }
  vuln(!(good.status === "completed" && paid(good) === 10000), `H32 at most 100 rows an answer, 150 Orders of a banned freelancer due first, then one ready -> after one run the ready Order is ${good.status}, paid ${paid(good) / 100} (must: paid out)`);
  ready();
}
{ // H32b the same for stopped payouts: 150 of a banned freelancer started first, then one that can finish
  isolate(); ready();
  for (let i = 0; i < 150; i++) stopped(mk({ editor: users.ed2.id, funded_cents: 10000 }), past(10 + i));
  const good = stopped(await funded(), past(1)); ed2.prof().banned = true;
  hooks.db = maxRows(100);
  try { await run(); } finally { hooks.db = realLists; }
  vuln(!(good.status === "completed" && paid(good) === 10000), `H32b at most 100 rows an answer, 150 stopped payouts of a banned freelancer first, then one that can finish -> after one run it is ${good.status}, paid ${paid(good) / 100} (must: finished)`);
  ready();
}
// profile answers without their "banned" mark: only the hourly job's list of freelancers ("list"), or every one ("all")
const noBannedMark = (which) => async (method, table, search, body) => {
  if (method === "GET" && table === "profiles" && /[?&]select=(id,)?banned(&|$)/.test(search) && (which === "all" || /[?&]id=in\./.test(search))) {
    const rows = DB.profiles.filter(r => match(r, parse(search.slice(1)))).map(r => ({ id: r.id }));
    return new Response(JSON.stringify(rows), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realLists(method, table, search, body);
};
const noteOf = (c) => (c.money_error ? JSON.stringify(c.money_error.slice(0, 70)) : "none");
{ // H33 the hourly job's list of freelancers comes back without the "banned" mark; the freelancer is not banned
  isolate(); ready();
  const c = due(await funded(), 3);
  hooks.db = noBannedMark("list");
  try { await run(); } finally { hooks.db = realLists; }
  vuln(!(c.status === "completed" && paid(c) === 10000 && !BANNED.test(c.money_error || "")), `H33 the list of freelancers answered without the "banned" mark, the freelancer not banned -> Order ${c.status}, paid ${paid(c) / 100}, note ${noteOf(c)} (must: paid out, as the Order's own check finds; never a note that the freelancer can't receive payments)`);
}
{ // H33b every answer about the "banned" mark comes back without it
  isolate(); ready();
  const c = due(await funded(), 3), from = logs.length;
  hooks.db = noBannedMark("all");
  try { await run(); } finally { hooks.db = realLists; }
  const summary = logs.slice(from).find(l => l.startsWith("hourly run summary:")) || "";
  vuln(!(c.status === "delivered" && paid(c) === 0 && !BANNED.test(c.money_error || "") && summary.includes(c.id)), `H33b every answer about the "banned" mark without it -> Order ${c.status}, paid ${paid(c) / 100}, note ${noteOf(c)}, the log's summary ${summary.includes(c.id) ? "names it" : "does NOT name it"} (must: nothing paid, no note that the freelancer can't receive payments, the failure in the log)`);
}
{ // H33c a freelancer with no profile counts as banned: set aside with its note; a ready Order after it is paid
  isolate(); ready();
  const gone = mk({ editor: uuid(), status: "delivered", funded_cents: 10000, auto_release_at: past(48), delivered_at: past(400) });
  const good = due(await funded(), 1);
  await run();
  vuln(!(paid(gone) === 0 && BANNED.test(gone.money_error || "") && good.status === "completed" && paid(good) === 10000), `H33c a freelancer with no profile -> paid ${paid(gone) / 100}, note ${noteOf(gone)}; the ready Order after it ${good.status} (must: nothing paid, the note that the freelancer can't receive payments, the ready one paid)`);
}
{ // H34 a decision carried out but not told yet (its chat message refused, as in H12b), behind 150 decisions still being
  // carried out whose records come first; the database answers at most 100 rows. The telling step, 11 minutes later.
  isolate(); ready();
  const T = past(2), waiting = [];
  for (let i = 0; i < 150; i++) {
    const o = mk({ id: "0" + uuid().slice(1), status: "resolving", resolution: "release", split_editor_cents: 10000, refund_cents: 0, resolved_by: users.adm.id, resolved_at: T });
    waiting.push({ id: uuid(), scope: `decision:${o.id}:${T}`, key: JSON.stringify({ decision: "release", by: users.adm.id }), created_at: T });
  }
  DB.money_keys.push(...waiting);
  const c = await funded({ id: "ffffffff-ffff-4fff-bfff-fffffffffff1", conversation_id: uuid() });
  c.status = "disputed"; c.disputed_at = past(2); c.dispute_by = users.cl.id; c.dispute_reason = "not what we agreed";
  DB.order_events.push({ id: uuid(), order_id: c.id, actor: users.cl.id, event: "disputed", data: {}, created_at: past(2) });
  hooks.db = async (method, table, search, body) => {
    if (method === "POST" && table === "messages" && String(body || "").includes(REASON)) return new Response(JSON.stringify({ message: "temporarily unavailable" }), { status: 503, headers: { "content-type": "application/json" } });
    return realLists(method, table, search, body);
  };
  const r = await decide(c); const t0 = told(c);
  hooks.db = maxRows(100);
  const real = Date.now; Date.now = () => real() + 11 * 60e3;
  try { await lib.tellDecisions(); } finally { Date.now = real; hooks.db = realLists; }
  const t = told(c);
  for (const w of waiting) DB.money_keys.splice(DB.money_keys.indexOf(w), 1);
  vuln(!(r.status === 200 && c.status === "completed" && paid(c) === 10000 && t0.msgs === 0 && t.msgs === 1 && t.marks === 1), `H34 a decision carried out (answer ${r.status}, Order ${c.status}, paid ${paid(c) / 100}) but not told yet (reason in the chat ${t0.msgs}), behind 150 still being carried out, at most 100 rows an answer -> the telling step: reason in the chat ${t.msgs}, mark ${t.marks} (must: 1 and 1)`);
}
{ // H34b 250 decisions still being carried out; a new one is saved while the telling step reads their records
  isolate(); ready();
  const T = past(2), waiting = [];
  for (let i = 0; i < 250; i++) {
    const o = mk({ id: "1" + uuid().slice(1), status: "resolving", resolution: "release", split_editor_cents: 10000, refund_cents: 0, resolved_by: users.adm.id, resolved_at: T });
    waiting.push({ id: uuid(), scope: `decision:${o.id}:${T}`, key: JSON.stringify({ decision: "release", by: users.adm.id }), created_at: T });
  }
  DB.money_keys.push(...waiting);
  const fresh = { id: uuid(), scope: `decision:00000000-0000-4000-8000-000000000000:${new Date().toISOString()}`, key: JSON.stringify({ decision: "refund", by: users.adm.id }), created_at: new Date().toISOString() };
  let saved = false;
  hooks.db = async (method, table, search, body) => {
    const r = await realLists(method, table, search, body);
    if (r && !saved && table === "money_keys" && /scope=like\.decision/.test(search)) { saved = true; DB.money_keys.push(fresh); }   // saved right after the first page was read
    return r;
  };
  try { await lib.tellDecisions(); } finally { hooks.db = realLists; }
  const kept = waiting.filter(w => DB.money_keys.includes(w)).length;
  for (const w of [...waiting, fresh]) { const i = DB.money_keys.indexOf(w); if (i >= 0) DB.money_keys.splice(i, 1); }
  vuln(kept !== 250, `H34b 250 decisions still being carried out, a new one saved while their records are read -> records kept ${kept} of 250 (must: every one, so each is told once carried out)`);
}

hooks.db = null; hooks.stripe = null; console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
