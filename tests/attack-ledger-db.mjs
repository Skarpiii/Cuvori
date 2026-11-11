// The ledger check in the real database (tests/ledger-db-check.mjs), checked with ledgers made by hand: a plan 2 Order
// written right comes out with no refused line and nothing listed, and each badly written or wrong ledger is refused, or
// listed by the ledger check, for its own reason, exactly as the live database (schema v56) would. The Orders are made
// as the payment tests make them (mk() of tests/fn-harness.mjs), the lines as the payment code writes them into the fake
// database (each with the id and created_at the fake adds).
// L1 a right Order, L2-L8 the broken ones, L9-L13 what the module itself must get right, L14 a refund that fails at Stripe.
// Run: node tests/attack-ledger-db.mjs   (needs the local Postgres of tests/db; it is started here)
import { spawnSync } from "node:child_process";
import { mk, uuid } from "./fn-harness.mjs";
import { checkLedgerInDb } from "./ledger-db-check.mjs";

const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const check = async (name, fn) => { try { await fn(); } catch (e) { vuln(true, `${name} -> the check could not run: ${e.message.slice(0, 300)}`); } };

// ---------- an Order and its ledger lines, as the fake database holds them ----------
const T0 = Date.parse("2026-12-01T10:00:00Z");
let tick = 0;
const order = (o = {}) => mk({ pricing_version: 2, commission_bps: 500, commission_cents: 0, auto_days: 14, stripe_payment_intent: "pi_" + uuid().slice(0, 8), ...o });
const line = (c, kind, cents, ref, extra = {}) => ({ id: uuid(), created_at: new Date(T0 + (++tick) * 60e3).toISOString(), order_id: c.id, kind, amount_cents: cents,
  fee_cents: 0, provider: "stripe", provider_ref: ref, status: "succeeded", note: "", entry_key: `${kind}:${ref}`, ...extra });
const fund = (c, cents, pi) => line(c, "fund", cents, pi, { connect_cents: 0 });
const payout = (c, cents, kept, tr, extra = {}) => line(c, "release", cents, tr, { commission_cents: kept, payout_cents: cents - kept, payout_purpose: "release", ...extra });
const refund = (c, cents, re, extra = {}) => line(c, "refund", cents, re, extra);
const pullBack = (c, cents, trr, dp) => line(c, "reversal", cents, trr, { note: "chargeback " + dp });
const repay = (c, cents, tr, dp) => line(c, "release", cents, tr, { commission_cents: 0, payout_cents: cents, payout_purpose: "repay", note: "chargeback_won " + dp });
const refundFailed = (c, cents, re) => line(c, "refund_failed", cents, re, { note: "refund_failed" });
const key = (scope, k) => ({ id: uuid(), created_at: new Date(T0).toISOString(), scope, key: k });
const event = (c, ev, data = {}) => ({ id: uuid(), created_at: new Date(T0).toISOString(), order_id: c.id, actor: null, event: ev, data });
const snap = (contracts, lines, more = {}) => ({ contracts, order_payments: lines, order_milestones: [], order_events: [], money_keys: [], ...more });

const refusedAs = (r) => r.refused.map(x => `${x.table === "order_payments" ? `${x.kind} ${x.provider_ref}` : x.table}: ${x.error}`).join("; ") || "none";
const listed = (r) => r.problems.map(p => p.problem).sort().join(",") || "none";
const decide = (r) => r.to_decide.map(p => p.item).sort().join(",") || "none";
const only = (r, re) => r.refused.length === 1 && (re.test(r.refused[0].error) || re.test(r.refused[0].constraint || ""));

// the right Order: €120 paid in two payments (€100, then a €20 top-up after a price increase both accepted), paid out in two
// payouts keeping 5% of the running total (€60: €3.00 kept; €50: €2.50 kept), and €10 given back in Cuvori's decision
const rightOrder = () => {
  const c = order({ amount_cents: 12000, price: 120, status: "completed", funded_cents: 12000, released_cents: 11000, refunded_cents: 1000 });
  const lines = [fund(c, 10000, "pi_a1"), fund(c, 2000, "pi_a2"), payout(c, 6000, 300, "tr_a1"), payout(c, 5000, 250, "tr_a2"), refund(c, 1000, "re_a1")];
  const keys = [key("transfer:" + c.id + ":1", "t1"), key("refund:" + c.id + ":1", "r1"), key("chargeback_result:" + c.id + ":dp_none", "none")];
  return { c, lines, keys };
};

await check("L1", async () => { // L1 a plan 2 Order written right: nothing refused, nothing listed, the 5% added up by the database
  const { c, lines, keys } = rightOrder();
  const r = await checkLedgerInDb(snap([c], lines, { money_keys: keys, order_events: [event(c, "completed")] }));
  const n = r.counters[c.id] || {}, s = r.summaries[c.id] || {};
  const left = spawnSync("psql", ["-h", process.env.PGDIR || "/tmp/cuvori-pgtest", "-p", "5499", "-U", "postgres", "-d", "postgres", "-At", "-c",
    `select count(*) from pg_database where datname like 'cuvori\\_ledger\\_${process.pid}\\_%'`], { encoding: "utf8" }).stdout.trim();
  vuln(r.refused.length || r.problems.length || r.to_decide.length || n.pricing_version !== 2 || n.commission_bps !== 500 || n.commission_cents !== 550
       || n.funded_cents !== 12000 || n.released_cents !== 11000 || n.refunded_cents !== 1000 || s.payouts_cents !== 10450 || s.freelancer_earnings_cents !== 10450 || s.refunded_cents !== 1000
       || (r.written || {}).order_payments !== 5 || (r.written || {}).money_keys !== 3 || (r.written || {}).order_events !== 1 || left !== "0",
    `L1 €120 paid in two payments, two payouts keeping 5% (€3.00 + €2.50), €10 refunded -> refused: ${refusedAs(r)}; listed: ${listed(r)}; to decide: ${decide(r)}; the Order: plan ${n.pricing_version}, ${n.commission_bps} bps, commission ${n.commission_cents} (added up by the database), counters ${n.funded_cents}/${n.released_cents}/${n.refunded_cents}; summary: sent ${s.payouts_cents}, earned ${s.freelancer_earnings_cents}; written ${JSON.stringify(r.written)}; scratch databases left: ${left} (must be none, none, none; 2, 500, 550, 12000/11000/1000; 10450, 10450; 5 lines, 3 keys, 1 event; 0)`);
});

// ---------- the broken ones: each refused, or listed, for its own reason ----------
await check("L2", async () => { // L2 two refunds written on one line ("re_1,re_2"): the same refund could be counted twice
  const c = order({ status: "refunded", funded_cents: 10000, refunded_cents: 10000 });
  const r = await checkLedgerInDb(snap([c], [fund(c, 10000, "pi_b"), refund(c, 6000, "re_b1"), refund(c, 4000, "re_b1,re_b2", { entry_key: "refund:re_b1_re_b2" })]));
  vuln(!only(r, /^provider_ref_one_id$/) || r.refused[0].provider_ref !== "re_b1,re_b2" || listed(r) !== "line_missing",
    `L2 a refund line naming two refunds "re_b1,re_b2" -> refused: ${refusedAs(r)}; listed: ${listed(r)} (must be refused as provider_ref_one_id, that line only; the Order then counts €40 refunded with no line: line_missing)`);
});
await check("L3", async () => { // L3 a pull-back naming its transfer instead of its own reversal (trr_)
  const c = order({ status: "completed", funded_cents: 10000, released_cents: 500, chargeback_id: "dp_c", chargeback_status: "lost" });
  const r = await checkLedgerInDb(snap([c], [fund(c, 10000, "pi_c"), payout(c, 10000, 500, "tr_c"), pullBack(c, 9500, "tr_c", "dp_c")]));
  vuln(!only(r, /^provider_ref_wrong_kind$/) || r.refused[0].kind !== "reversal",
    `L3 a pull-back naming the transfer tr_c -> refused: ${refusedAs(r)} (must be refused as provider_ref_wrong_kind)`);
});
await check("L4", async () => { // L4 a payout that doesn't say what it kept and what it sent
  const c = order({ status: "completed", funded_cents: 10000, released_cents: 10000 });
  const bare = payout(c, 10000, 0, "tr_d"); delete bare.commission_cents; delete bare.payout_cents; delete bare.payout_purpose;
  const r = await checkLedgerInDb(snap([c], [fund(c, 10000, "pi_d"), bare]));
  vuln(!only(r, /^commission_missing$/) || listed(r) !== "line_missing",
    `L4 a payout line without its commission -> refused: ${refusedAs(r)}; listed: ${listed(r)} (must be refused as commission_missing; the Order then counts a payout with no line: line_missing)`);
});
await check("L5", async () => { // L5 two lines with one entry key: the second is refused, the first stays
  const c = order({ status: "completed", funded_cents: 10000, released_cents: 10000 });
  const r = await checkLedgerInDb(snap([c], [fund(c, 10000, "pi_e"), payout(c, 4000, 200, "tr_e1", { entry_key: "release:tr_e" }), payout(c, 6000, 300, "tr_e2", { entry_key: "release:tr_e" })]));
  const n = r.counters[c.id] || {};
  vuln(!only(r, /duplicate key.*order_payments_entry_key_uq/) || r.refused[0].provider_ref !== "tr_e2" || n.commission_cents !== 200 || listed(r) !== "line_missing",
    `L5 the same entry key on two payouts -> refused: ${refusedAs(r)}; commission then ${n.commission_cents}; listed: ${listed(r)} (must refuse the second, tr_e2, as a duplicate of order_payments_entry_key_uq; 200; line_missing)`);
});
await check("L6", async () => { // L6 a payout that kept 2 cents less than 5% has happened at Stripe: recorded, and listed
  const c = order({ status: "completed", funded_cents: 10000, released_cents: 10000 });
  const r = await checkLedgerInDb(snap([c], [fund(c, 10000, "pi_f"), payout(c, 10000, 498, "tr_f")]));
  const p = r.problems.find(x => x.problem === "commission_off") || {};
  vuln(r.refused.length || listed(r) !== "commission_off" || p.kept_cents !== 498 || p.expected_cents !== 500,
    `L6 €100 paid out keeping €4.98 -> refused: ${refusedAs(r)}; listed: ${listed(r)} (kept ${p.kept_cents}, expected ${p.expected_cents}) (must be recorded and listed as commission_off, 498 against 500)`);
});
await check("L7", async () => { // L7 more out than in: the whole payment paid out, then refunded in the Stripe dashboard
  const c = order({ status: "refunded", funded_cents: 10000, released_cents: 10000, refunded_cents: 0 });
  const r = await checkLedgerInDb(snap([c], [fund(c, 10000, "pi_g"), payout(c, 10000, 500, "tr_g"), refund(c, 10000, "re_g", { note: "dashboard_refund" })]));
  vuln(r.refused.length || !/more_out_than_in/.test(listed(r)),
    `L7 €100 paid out, then €100 refunded -> refused: ${refusedAs(r)}; listed: ${listed(r)} (must be recorded and listed as more_out_than_in)`);
});
await check("L8", async () => { // L8 a re-payment after a chargeback that was not won; with the "chargeback won" event the same is right
  const make = () => { const c = order({ status: "completed", funded_cents: 10000, released_cents: 10000 });
    return { c, lines: [fund(c, 10000, "pi_h"), payout(c, 10000, 500, "tr_h"), pullBack(c, 9500, "trr_h", "dp_h"), repay(c, 9500, "tr_h2", "dp_h")] }; };
  const a = make(), b = make();
  const notWon = await checkLedgerInDb(snap([a.c], a.lines));
  const won = await checkLedgerInDb(snap([b.c], b.lines, { order_events: [event(b.c, "chargeback_won", { chargeback: "dp_h" })], money_keys: [key(`chargeback_result:${b.c.id}:dp_h`, "won")] }));
  vuln(notWon.refused.length || listed(notWon) !== "repay_off" || won.refused.length || listed(won) !== "none",
    `L8 €95 pulled back and paid again with no won chargeback -> refused: ${refusedAs(notWon)}; listed: ${listed(notWon)}; the same with the "chargeback won" event saved -> refused: ${refusedAs(won)}; listed: ${listed(won)} (must be recorded and listed as repay_off; then nothing listed)`);
});

// ---------- what the module itself must get right ----------
await check("L9", async () => { // L9 the parts of an Order are written too: a part paid out twice is listed; a payout naming a part that isn't there is refused
  const c = order({ status: "completed", funded_cents: 10000, released_cents: 8000, has_milestones: true });
  const ms = [1, 2].map(n => ({ id: uuid(), created_at: new Date(T0).toISOString(), order_id: c.id, position: n, title: "Part " + n, amount_cents: n === 1 ? 4000 : 6000, status: n === 1 ? "released" : "pending" }));
  const r = await checkLedgerInDb(snap([c], [fund(c, 10000, "pi_i"), payout(c, 4000, 200, "tr_i1", { milestone_id: ms[0].id }), payout(c, 4000, 200, "tr_i2", { milestone_id: ms[0].id }),
    payout(c, 2000, 100, "tr_i3", { milestone_id: uuid() })], { order_milestones: ms }));
  vuln(!only(r, /foreign key/) || r.refused[0].provider_ref !== "tr_i3" || !/milestone_payout_off/.test(listed(r)) || (r.written || {}).order_milestones !== 2,
    `L9 an Order with two parts, part 1 paid out twice, and a payout naming a part not in the snapshot -> refused: ${refusedAs(r)}; listed: ${listed(r)}; parts written: ${(r.written || {}).order_milestones} (must refuse tr_i3 by its foreign key; list milestone_payout_off; 2)`);
});
await check("L10", async () => { // L10 rows the live database refuses for their shape: a column the table doesn't have (PostgREST refuses the whole request), a line of an Order that isn't there; the fake's own id and created_at are never a refusal
  const c = order({ status: "funded", funded_cents: 10000 });
  const r = await checkLedgerInDb(snap([c], [fund(c, 10000, "pi_j"), { ...refund(c, 500, "re_j"), reason: "typo column" }, fund({ id: uuid() }, 500, "pi_j_other")],
    { money_keys: [key("lock:" + c.id, "x")], order_events: [{ ...event(c, "funded"), id: uuid() }] }));
  const why = r.refused.map(x => x.code === "PGRST204" ? "PGRST204" : x.error).sort().join(",");
  vuln(r.refused.length !== 2 || why !== "PGRST204,order_not_written" || (r.written || {}).order_payments !== 1 || (r.written || {}).money_keys !== 1 || (r.written || {}).order_events !== 1,
    `L10 a refund line with a column "reason" and a payment line of an Order not in the snapshot -> refused: ${refusedAs(r)}; written ${JSON.stringify(r.written)} (must be PGRST204 and order_not_written; 1 line, 1 key, 1 event)`);
});
await check("L11", async () => { // L11 the prices are the snapshot's: an Order without a plan gets plan 2 (5%, 14 days), an Order at today's prices stays at them, and its lines are judged as such
  const noPlan = mk({ status: "completed", funded_cents: 10000, released_cents: 10000 });
  const today = mk({ pricing_version: 1, commission_bps: 0, commission_cents: 0, status: "completed", funded_cents: 10000, released_cents: 10000 });
  const r = await checkLedgerInDb(snap([noPlan, today], [fund(noPlan, 10000, "pi_k1"), payout(noPlan, 10000, 500, "tr_k1"), fund(today, 10000, "pi_k2"), payout(today, 10000, 500, "tr_k2")]));
  const a = r.counters[noPlan.id] || {}, b = r.counters[today.id] || {};
  vuln(`${a.pricing_version}/${a.commission_bps}/${a.commission_cents}` !== "2/500/500" || `${b.pricing_version}/${b.commission_bps}/${b.commission_cents}` !== "1/0/0" || !only(r, /^pricing_fields_need_new_prices$/) || r.refused[0].provider_ref !== "tr_k2",
    `L11 an Order with no plan in the snapshot -> ${a.pricing_version}/${a.commission_bps}/${a.commission_cents}; one at today's prices -> ${b.pricing_version}/${b.commission_bps}/${b.commission_cents}; refused: ${refusedAs(r)} (must be 2/500/500 and 1/0/0; the 5% on today's prices refused as pricing_fields_need_new_prices)`);
});
await check("L12", async () => { // L12 the lines are written as the new payment code writes them, with its header: without it (today's code) every plan 2 line is refused
  const { c, lines } = rightOrder();
  const r = await checkLedgerInDb(snap([c], lines), { header: { "user-agent": "node" } });
  vuln(r.refused.length !== lines.length || r.refused.some(x => x.error !== "pricing_engine_too_old"),
    `L12 the right Order's ${lines.length} lines written by code that sends no "x-cuvori-pricing: 2" -> refused ${r.refused.length}: ${[...new Set(r.refused.map(x => x.error))].join(", ")} (must be all ${lines.length}, pricing_engine_too_old)`);
});
await check("L13", async () => { // L13 the commission total is the database's, from the lines it took, never the snapshot's: a fake total of 999 is not copied
  const { c, lines } = rightOrder(); c.commission_cents = 999;
  const r = await checkLedgerInDb(snap([c], [...lines, payout(c, 1000, 5000, "tr_a3")]));
  const n = r.counters[c.id] || {};
  vuln(n.commission_cents !== 550 || !only(r, /order_payments_pricing_ok/) || !r.notes.some(x => /999 in the snapshot.*550/.test(x.note)),
    `L13 the snapshot's commission total 999, and a payout keeping more than it paid out -> the database's total ${n.commission_cents}; refused: ${refusedAs(r)}; notes: ${r.notes.map(x => x.note).join("; ") || "none"} (must be 550; the payout refused by order_payments_pricing_ok; a note naming 999 and 550)`);
});

// ---------- a refund that fails at Stripe after its line was written (schema v56, refund_failed) ----------
await check("L14", async () => { // L14 the refund's money comes back to Cuvori: its line of its own, and the Order counts it back; the rest is as for the right Order
  const c = order({ status: "completed", funded_cents: 10000, released_cents: 10000, refunded_cents: 0 });
  const lines = [fund(c, 10000, "pi_l"), refund(c, 4000, "re_l"), refundFailed(c, 4000, "re_l"), payout(c, 10000, 500, "tr_l")];
  const r = await checkLedgerInDb(snap([c], lines));
  const s = r.summaries[c.id] || {};
  const badRef = order({ status: "funded", funded_cents: 10000, refunded_cents: 0 });
  const bad = await checkLedgerInDb(snap([badRef], [fund(badRef, 10000, "pi_l2"), refund(badRef, 4000, "re_l2"), refundFailed(badRef, 4000, "ch_l2"), refundFailed(badRef, 4000, "re_l2,re_l3")]));
  const why = bad.refused.map(x => x.error).sort().join(",");
  vuln(r.refused.length || listed(r) !== "none" || s.refunded_cents !== 0 || s.refund_failed_cents !== 4000 || why !== "provider_ref_one_id,provider_ref_wrong_kind",
    `L14 €40 refunded, the refund failed (its money back), then €100 paid out -> refused: ${refusedAs(r)}; listed: ${listed(r)}; summary refunded ${s.refunded_cents}, failed ${s.refund_failed_cents}; a failed refund naming a charge, or two refunds -> refused: ${why || "none"} (must be none, none, 0, 4000; provider_ref_one_id and provider_ref_wrong_kind)`);
});

console.log(out.join("\n"));
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(bad ? 1 : 0);
