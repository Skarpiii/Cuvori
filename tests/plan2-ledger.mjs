// The ledger rules of the new prices (plan 2, schema v56) and a reconciliation against Stripe, in JavaScript, for the
// payment suites (tests/attack-plan2.mjs). Works on the fakes of tests/fn-harness.mjs: DB (the tables) and STRIPE.
//   checkLines(DB)              every plan 2 ledger line against v56's rules (order_payments_pricing and the table's
//                               check): succeeded, from Stripe, an entry key of the right form, used once and named after
//                               the line's own Stripe object, exactly one Stripe id of the line's kind, one line per Stripe
//                               object per kind, a payout that says what it kept and sent (sent = paid out - kept, kept
//                               between 0 and the amount), a re-payment that reads "chargeback_won <dispute id>" and keeps
//                               nothing, a pull-back that reads "chargeback <dispute id>", no card fee on a payment unless
//                               it was refunded on the payment's own line
//   reconcile(DB, STRIPE, c)    one Order: its totals against its lines (paid in = payment lines; paid out = payouts less
//                               pull-backs; refunded = what the refund and chargeback lines count; the commission total =
//                               the payout lines' commission), the commission against 5% of the running total (a cent per
//                               line added afterwards at most), every Stripe object of the Order with exactly one line of
//                               the same amount (payments, transfers with their gross / commission / payout, pull-backs,
//                               refunds), what the freelancer has at Stripe = what the lines sent less pull-backs, the
//                               client never paying more than the agreed price, and on a finished Order nothing held:
//                               Cuvori keeps its commission and nothing else (less what the lines say went out twice or to
//                               a bank)
//   ledgerCheck(DB)             admin_pricing_check (schema v56, section 8) in JavaScript: { problems, to_decide }
export const commission = (cents, bps) => Math.floor((cents * bps + 5000) / 10000);
export const P2 = (c) => !!c && Number(c.pricing_version) >= 2 && c.payment_mode === "escrow";
const PREFIX = { fund: /^pi_/, release: /^tr_/, refund: /^(re|pyr)_/, refund_failed: /^(re|pyr)_/, reversal: /^trr_/, chargeback: /^(dp|du)_/ };
// what a refund or chargeback line puts on the Order's refund total (the payment code's countedOf)
export const countedOf = (l) => { const m = /^(?:dashboard_refund|chargeback_lost) counted (\d+)$/.exec(String(l.note || "")); return m ? Math.min(Number(m[1]), l.amount_cents) : l.amount_cents; };
const sum = (xs, f = (x) => x.amount_cents) => xs.reduce((a, x) => a + f(x), 0);
const short = (id) => String(id || "").slice(0, 8);

export function checkLines(DB, orders = null) {
  const out = [];
  const p2 = new Set(DB.contracts.filter(P2).map(c => c.id));
  const keys = new Map();
  for (const l of DB.order_payments) if (l.entry_key != null) keys.set(l.entry_key, (keys.get(l.entry_key) || 0) + 1);
  const objs = new Map();
  for (const l of DB.order_payments) if (p2.has(l.order_id) && l.provider_ref) objs.set(l.kind + " " + l.provider_ref, (objs.get(l.kind + " " + l.provider_ref) || 0) + 1);
  for (const l of DB.order_payments) {
    if (!p2.has(l.order_id) && !(l.pricing_version >= 2)) {
      // today's prices: the new fields stay empty, and no entry key (undo_v56 goes by them)
      if (l.entry_key != null || l.commission_cents != null || l.payout_cents != null || l.payout_purpose != null) out.push(`a line of an Order at today's prices carries the new prices' fields (${l.kind} ${l.provider_ref})`);
      continue;
    }
    if (orders && !orders.includes(l.order_id)) continue;
    const w = (m) => out.push(`${l.kind} line ${l.provider_ref || "(no id)"} of order ${short(l.order_id)}: ${m}`);
    if (!(l.pricing_version >= 2)) w("the database did not mark it plan 2");
    if (l.status !== "succeeded") w(`status ${l.status}`);
    if (l.provider !== "stripe") w(`provider ${l.provider}`);
    if (!/^[a-z_]{2,40}:[A-Za-z0-9_:.,-]{1,240}$/.test(l.entry_key || "")) w(`entry key ${JSON.stringify(l.entry_key)}`);
    else if (l.entry_key !== `${l.kind}:${l.provider_ref}`) w(`entry key ${l.entry_key} does not name its own Stripe object`);
    if (keys.get(l.entry_key) > 1) w(`entry key used ${keys.get(l.entry_key)} times`);
    if (!/^[A-Za-z0-9_]{1,255}$/.test(l.provider_ref || "")) w("not exactly one Stripe id");
    else if (PREFIX[l.kind] && !PREFIX[l.kind].test(l.provider_ref)) w(`a ${l.kind} line names ${l.provider_ref}`);
    if (objs.get(l.kind + " " + l.provider_ref) > 1) w(`${objs.get(l.kind + " " + l.provider_ref)} lines for one Stripe object`);
    if (l.kind === "fund") {
      const fee = (l.fee_cents || 0) + (l.connect_cents || 0);
      if (fee > 0 && (l.fee_refund_cents || 0) !== fee) w(`the client paid a card fee of ${fee} and got back ${l.fee_refund_cents || 0}`);
      if ((l.fee_refund_cents || 0) > 0 && !/^(re|pyr)_/.test(l.fee_refund_ref || "")) w("a card-fee refund without its own refund id");
    } else if ((l.fee_refund_cents || 0) !== 0 || l.fee_refund_ref != null) w("a card-fee refund on a line that is not a payment");
    if (l.kind === "release") {
      if (l.commission_cents == null || l.payout_cents == null || l.payout_purpose == null) w("a payout that does not say what it kept and sent");
      else {
        if (l.payout_cents !== l.amount_cents - l.commission_cents) w(`sent ${l.payout_cents} is not ${l.amount_cents} - ${l.commission_cents}`);
        if (l.commission_cents < 0 || l.commission_cents > l.amount_cents) w(`kept ${l.commission_cents} of ${l.amount_cents}`);
        if (!["release", "release_late", "repay"].includes(l.payout_purpose)) w(`purpose ${l.payout_purpose}`);
        if (l.payout_purpose === "repay" && (!/^chargeback_won [A-Za-z0-9_]{1,255}$/.test(l.note || "") || l.commission_cents !== 0)) w(`a re-payment reading ${JSON.stringify(l.note)}, keeping ${l.commission_cents}`);
        if (l.payout_purpose !== "repay" && /^chargeback_won/.test(l.note || "")) w("a re-payment written as a normal payout");
      }
    } else if (l.commission_cents != null || l.payout_cents != null || l.payout_purpose != null) w("payout fields on a line that is not a payout");
    if (l.kind === "reversal" && !/^chargeback [A-Za-z0-9_]{1,255}$/.test(l.note || "")) w(`a pull-back reading ${JSON.stringify(l.note)}`);
    if (l.kind === "chargeback" && !/^chargeback_lost( counted \d+)?$/.test(l.note || "")) w(`a chargeback line reading ${JSON.stringify(l.note)}`);
  }
  return out;
}

// One Order against its lines and Stripe. opts.short: cents of commission the Order may be short (a payout that could not
// keep its cent: Stripe can't send €0). opts.open: money may still be at a bank (a chargeback open).
export function reconcile(DB, STRIPE, c, opts = {}) {
  const out = [], w = (m) => out.push(`order ${short(c.id)}: ${m}`);
  const L = DB.order_payments.filter(l => l.order_id === c.id && l.status === "succeeded");
  const of = (k) => L.filter(l => l.kind === k);
  const fund = sum(of("fund")), rel = sum(of("release")), rev = sum(of("reversal")), refund = sum(of("refund")), bank = sum(of("chargeback"));
  // a refund that failed at Stripe afterwards (its own refund_failed line): what the Order had counted of it comes off again
  const failedBack = sum(of("refund_failed"), f => Math.min(f.amount_cents, sum(of("refund").filter(l => String(l.provider_ref).split(",").includes(f.provider_ref)), countedOf)));
  const failedAll = sum(of("refund_failed"));
  const counted = sum([...of("refund"), ...of("chargeback")], countedOf) - failedBack;
  if ((c.funded_cents || 0) !== fund) w(`paid in ${c.funded_cents}, payment lines ${fund}`);
  if ((c.released_cents || 0) !== rel - rev) w(`paid out ${c.released_cents}, payout lines ${rel} less pull-backs ${rev}`);
  if ((c.refunded_cents || 0) !== counted) w(`refunded ${c.refunded_cents}, the refund and chargeback lines count ${counted}`);
  const kept = sum(of("release"), l => l.commission_cents || 0);
  if ((c.commission_cents || 0) !== kept) w(`commission total ${c.commission_cents}, payout lines ${kept}`);
  const normal = of("release").filter(l => l.payout_purpose === "release" || l.payout_purpose === "release_late");
  const due = commission(sum(normal), c.commission_bps), late = normal.filter(l => l.payout_purpose === "release_late").length;
  if (kept > due || due - kept > late + (opts.short || 0)) w(`commission ${kept}, 5% of the ${sum(normal)} paid out is ${due} (allowed short: ${late + (opts.short || 0)})`);
  if (of("release").some(l => l.payout_purpose === "repay" && l.commission_cents)) w("a re-payment kept commission");
  // payments: every captured payment of the Order that is the Order's (not a late payment sent back, not a hold let go) has one line
  const charges = Object.values(STRIPE.charges).filter(ch => ch.transfer_group === `contract_${c.id}` && ch.captured !== false);
  const lateBack = (ch) => STRIPE.refunds.some(r => r.charge === ch.id && r.metadata && r.metadata.kind === "late_payment");
  for (const ch of charges) {
    const lines = of("fund").filter(l => l.provider_ref === ch.payment_intent);
    if (lateBack(ch)) { if (lines.length) w(`late payment ${ch.payment_intent} has a payment line`); if (ch.amount_refunded !== ch.amount) w(`late payment ${ch.payment_intent}: ${ch.amount_refunded} of ${ch.amount} went back (the new prices send it back in full)`); continue; }
    if (lines.length !== 1) { w(`payment ${ch.payment_intent} has ${lines.length} payment lines`); continue; }
    const l = lines[0];
    if (ch.amount !== l.amount_cents + (l.fee_cents || 0) + (l.connect_cents || 0)) w(`payment ${ch.payment_intent}: Stripe charged ${ch.amount}, its line says ${l.amount_cents} + fees ${(l.fee_cents || 0) + (l.connect_cents || 0)}`);
  }
  for (const l of of("fund")) if (!charges.some(ch => ch.payment_intent === l.provider_ref)) w(`payment line ${l.provider_ref} has no captured payment at Stripe`);
  // payouts: every transfer one line, with its own amounts
  const ts = STRIPE.transfers.filter(t => t.metadata && t.metadata.contract_id === c.id);
  for (const t of ts) {
    const lines = of("release").filter(l => l.provider_ref === t.id);
    if (lines.length !== 1) { w(`transfer ${t.id} has ${lines.length} payout lines`); continue; }
    const l = lines[0], md = t.metadata || {};
    const repay = /^retransfer_/.test(md.purpose || "");
    const g = repay ? t.amount : Number(md.gross_cents), k = repay ? 0 : Number(md.commission_cents);
    if (!repay && (!md.pricing_version || Number(md.payout_cents) !== t.amount || g - k !== t.amount)) w(`transfer ${t.id} does not carry its gross, commission and payout (${JSON.stringify(md)})`);
    if (l.amount_cents !== g || l.commission_cents !== k || l.payout_cents !== t.amount) w(`transfer ${t.id} (${g} - ${k} = ${t.amount}) has a line of ${l.amount_cents} - ${l.commission_cents} = ${l.payout_cents}`);
    if (repay && l.note !== `chargeback_won ${md.purpose.slice(11)}`) w(`re-payment ${t.id} reads ${JSON.stringify(l.note)}`);
  }
  for (const l of of("release")) if (!ts.some(t => t.id === l.provider_ref)) w(`payout line ${l.provider_ref} has no transfer at Stripe`);
  // pull-backs: every reversal one line of its amount, naming its chargeback
  const rs = STRIPE.reversals.filter(r => ts.some(t => t.id === r.transfer));
  for (const r of rs) {
    const lines = of("reversal").filter(l => l.provider_ref === r.id);
    if (lines.length !== 1 || lines[0].amount_cents !== r.amount) { w(`pull-back ${r.id} (${r.amount}) has ${lines.length} lines${lines.length ? " of " + lines.map(x => x.amount_cents).join("/") : ""}`); continue; }
    if (r.metadata && r.metadata.reason && lines[0].note !== `chargeback ${r.metadata.reason}`) w(`pull-back ${r.id} for ${r.metadata.reason} reads ${JSON.stringify(lines[0].note)}`);
  }
  for (const l of of("reversal")) if (!rs.some(r => r.id === l.provider_ref)) w(`pull-back line ${l.provider_ref} has no reversal at Stripe`);
  const atFreelancer = sum(ts, t => t.amount - (t.amount_reversed || 0)), byLines = sum(of("release"), l => l.payout_cents) - rev;
  if (atFreelancer !== byLines) w(`the freelancer has ${atFreelancer} at Stripe, the lines sent ${byLines} net of pull-backs`);
  // refunds: Cuvori's (never the card-fee refund or a late payment's) and the dashboard's, one line each, of the same amount
  const pis = new Set(of("fund").map(l => l.provider_ref));
  const refunds = STRIPE.refunds.filter(r => pis.has(r.payment_intent) && r.status !== "failed" && r.status !== "canceled" && !(r.metadata && (r.metadata.kind === "fee_surplus" || r.metadata.kind === "late_payment")));
  for (const r of refunds) {
    const lines = of("refund").filter(l => l.provider_ref === r.id);
    if (lines.length !== 1 || lines[0].amount_cents !== r.amount) w(`refund ${r.id} (${r.amount}) has ${lines.length} lines${lines.length ? " of " + lines.map(x => x.amount_cents).join("/") : ""}`);
  }
  for (const l of of("refund")) if (!refunds.some(r => r.id === l.provider_ref) && !of("refund_failed").some(f => f.provider_ref === l.provider_ref)) w(`refund line ${l.provider_ref} has no refund at Stripe`);
  for (const f of of("refund_failed")) if (!STRIPE.refunds.some(r => r.id === f.provider_ref && ["failed", "canceled"].includes(r.status))) w(`refund_failed line ${f.provider_ref} names no failed refund at Stripe`);
  if (sum(refunds, r => r.amount) !== refund - failedAll) w(`Stripe refunded ${sum(refunds, r => r.amount)} of the Order's money, the refund lines say ${refund} less ${failedAll} failed`);
  // the client never paid more than the agreed price (after refunds and what a bank took back), and no card fee stays charged
  // what a bank took for good: the dispute's balance entries when Stripe gave some back ("partially won"), else its amount
  const tookOf = (chid, d) => Array.isArray(d.balance_transactions) ? -sum(d.balance_transactions, b => b.amount) : (d.amount ?? STRIPE.charges[chid].amount);
  const lost = Object.entries(STRIPE.disputes).filter(([chid, d]) => d.status === "lost" && charges.some(ch => ch.id === chid)).reduce((a, [chid, d]) => a + tookOf(chid, d), 0);
  const clientNet = sum(charges, ch => ch.amount - ch.amount_refunded) - lost;
  if (clientNet > c.amount_cents) w(`the client has paid ${clientNet} net, the agreed price is ${c.amount_cents}`);
  if (fund - (refund - failedAll) - bank > c.amount_cents) w(`the lines show ${fund - refund - bank} paid in net, the agreed price is ${c.amount_cents}`);
  const cardFees = sum(of("fund"), l => (l.fee_cents || 0) + (l.connect_cents || 0) - (l.fee_refund_cents || 0));
  if (cardFees) w(`the client still pays ${cardFees} of card fees`);
  // what Cuvori has of the Order at Stripe = what it holds + its commission, less what the lines say went out twice or to a
  // bank beyond what the Order still held; on a finished Order it holds nothing
  const held = (c.funded_cents || 0) - (c.released_cents || 0) - (c.refunded_cents || 0);
  const atCuvori = sum(charges.filter(ch => !lateBack(ch)), ch => ch.amount - ch.amount_refunded) - lost - atFreelancer
    + sum(of("fund"), l => (l.fee_refund_cents || 0)) - sum(of("fund"), l => (l.fee_cents || 0) + (l.connect_cents || 0));   // card fees charged by mistake and sent back: not the Order's
  const uncounted = sum([...of("refund"), ...of("chargeback")], l => l.amount_cents - countedOf(l));
  if (!opts.open && atCuvori !== held + kept - uncounted) w(`Cuvori has ${atCuvori} of the Order at Stripe; it holds ${held}, kept ${kept}, and the lines say ${uncounted} went out twice or to a bank`);
  // (a refund that failed after the Order closed leaves the money with Cuvori until the admin sends it again: listed by the check)
  if (["completed", "refunded", "cancelled"].includes(c.status) && held !== 0 && !failedBack) w(`finished (${c.status}) but still holds ${held}`);
  if (held < 0) w(`holds ${held}`);
  return out;
}

// admin_pricing_check (schema v56, section 8), on the fake tables
export function ledgerCheck(DB) {
  const problems = [], decide = [];
  const lines = (id) => DB.order_payments.filter(p => p.order_id === id && p.status === "succeeded");
  const purposeOf = (p) => p.payout_purpose ?? (/^chargeback_won/.test(p.note || "") ? "repay" : "release");
  for (const c of DB.contracts.filter(P2)) {
    const L = lines(c.id), k = (kind) => L.filter(p => p.kind === kind);
    const released = sum(k("release").filter(p => ["release", "release_late"].includes(p.payout_purpose))), released_all = sum(k("release"));
    const kept = sum(k("release"), p => p.commission_cents || 0), paid_in = sum(k("fund"));
    const card_fees = sum(k("fund"), p => (p.fee_cents || 0) + (p.connect_cents || 0) - (p.fee_refund_cents || 0));
    const refunded = sum(k("refund")) - sum(k("refund_failed")), to_bank = sum(k("chargeback")), payouts = sum(k("release"), p => p.payout_cents || 0), pulled_back = sum(k("reversal"));
    const repaid_total = sum(k("release").filter(p => p.payout_purpose === "repay"));
    const count_in = c.funded_cents || 0, count_out = c.released_cents || 0, count_back = c.refunded_cents || 0;
    const pullsOf = (d) => sum(k("reversal").filter(r => r.note === "chargeback " + d));
    const cbLines = k("chargeback");
    const lost_cb = ((c.chargeback_status || "") === "lost" && k("reversal").some(r => r.note === "chargeback " + c.chargeback_id) || cbLines.some(l => k("reversal").some(r => r.note === "chargeback " + l.provider_ref))) && kept > 0;
    const cb_pulled = pullsOf(c.chargeback_id), cb_repaid = sum(k("release").filter(p => p.payout_purpose === "repay" && p.note === "chargeback_won " + c.chargeback_id));
    const lost_loss = cbLines.reduce((a, l) => { const pulled = pullsOf(l.provider_ref); return a + Math.max(0, Math.min(l.amount_cents - pulled, Math.ceil(pulled * c.commission_bps / (10000 - c.commission_bps)))); }, 0);
    const lost_pulled = sum(k("reversal").filter(r => cbLines.some(l => r.note === "chargeback " + l.provider_ref)));
    const cb_recorded = sum(cbLines.filter(l => l.provider_ref === c.chargeback_id));
    const still_here = paid_in - refunded - to_bank - (payouts - pulled_back);
    const P = (problem, x = {}) => problems.push({ order: c.id, problem, ...x });
    if (kept !== commission(released, c.commission_bps)) P("commission_off", { kept_cents: kept, expected_cents: commission(released, c.commission_bps) });
    if ((c.commission_cents || 0) !== kept) P("totals_differ");
    if (paid_in - refunded - to_bank > c.amount_cents) P("paid_more_than_agreed");
    if (card_fees > 0) P("client_charged_card_fee");
    if (still_here < 0) P("more_out_than_in");
    if (still_here >= 0 && still_here < kept - lost_loss) P("commission_without_money");
    const rp = new Map();
    for (const p of k("release").filter(p => p.payout_purpose === "repay")) { const d = (/^chargeback_won (.+)$/.exec(p.note || "") || [])[1]; rp.set(d, (rp.get(d) || 0) + p.amount_cents); }
    for (const [d, repaid] of rp) {
      const won = (c.chargeback_id === d && c.chargeback_status === "won") || DB.order_events.some(e => e.order_id === c.id && e.event === "chargeback_won" && e.data && e.data.chargeback === d);
      if (repaid > pullsOf(d) || !won) P("repay_off", { chargeback: d });
    }
    const lineMissing = count_in > paid_in || count_out > released_all - pulled_back || count_back > refunded + to_bank;
    if (["completed", "refunded", "cancelled"].includes(c.status) && still_here > kept && (c.chargeback_status || "") !== "open"
        && !((c.chargeback_status || "") === "won" && cb_pulled > cb_repaid && /^chargeback won/.test(c.money_error || "")) && !lineMissing) P("money_left_at_cuvori", { still_here_cents: still_here, commission_cents: kept });
    if (released > paid_in) P("commission_twice");
    if ((c.chargeback_status || "") === "lost" && c.chargeback_cents != null && cb_recorded < c.chargeback_cents) P("chargeback_not_recorded");
    if (lineMissing) P("line_missing");
    if (lost_cb) decide.push({ order: c.id, item: "commission_on_lost_chargeback" });
    if (["completed", "refunded", "cancelled"].includes(c.status) && (c.chargeback_status || "") !== "open" && pulled_back - lost_pulled > repaid_total && kept > 0 && still_here <= kept) decide.push({ order: c.id, item: "commission_on_pulled_back_payout" });
  }
  // every Order paid through Cuvori, at any prices
  for (const c of DB.contracts.filter(c => c.payment_mode === "escrow")) {
    const L = lines(c.id), k = (kind) => L.filter(p => p.kind === kind);
    const count_in = !(c.funded_cents || 0) && ["funded", "delivered", "disputed", "releasing", "resolving"].includes(c.status) ? c.amount_cents || 0 : c.funded_cents || 0;
    if (count_in < sum(k("fund")) || (c.released_cents || 0) < sum(k("release")) - sum(k("reversal")) || (c.refunded_cents || 0) < sum(k("refund").concat(k("chargeback")), P2(c) ? countedOf : undefined) - sum(k("refund_failed"))) problems.push({ order: c.id, problem: "counter_behind_ledger" });
    for (const m of DB.order_milestones.filter(m => m.order_id === c.id)) {
      const pl = k("release").filter(p => p.milestone_id === m.id && ["release", "release_late"].includes(purposeOf(p)));
      // (a payout from money held apart: one line per payment it came from, each naming it, and at most one from the balance)
      const linked = pl.filter(p => p.charge_ref), split = pl.length > 1 && (pl.length - linked.length > 1 || new Set(linked.map(p => p.charge_ref)).size !== linked.length);
      if (pl.length && (split || sum(pl) !== m.amount_cents)) problems.push({ order: c.id, problem: "milestone_payout_off" });
    }
  }
  const fundRefs = new Map();
  for (const p of DB.order_payments.filter(p => p.kind === "fund" && p.provider === "stripe" && p.provider_ref)) fundRefs.set(p.provider_ref, (fundRefs.get(p.provider_ref) || 0) + 1);
  for (const [ref, n] of fundRefs) if (n > 1) { const p = DB.order_payments.find(x => x.provider_ref === ref); problems.push({ order: p.order_id, problem: "payment_line_twice" }); }
  return { problems, to_decide: decide };
}
// what admin_pricing_check lists for one Order: "problem" kinds, then "to_decide:" items, sorted
export const listed = (DB, c) => { const r = ledgerCheck(DB); return [...r.problems.filter(p => p.order === c.id).map(p => p.problem), ...r.to_decide.filter(d => d.order === c.id).map(d => "to_decide:" + d.item)].sort(); };
