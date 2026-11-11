// Shared fakes for the payment-function attack suites: a small Stripe (with the rules that bite in
// production — idempotency, transfer caps per source charge, refund caps per payment, disputes,
// balance), a small Supabase REST, and helpers to sign webhooks.
process.env.STRIPE_SECRET_KEY = process.env.HARNESS_STRIPE_KEY || "sk_test_fake"; process.env.SUPABASE_SERVICE_ROLE_KEY = "service_fake"; process.env.STRIPE_WEBHOOK_SECRET = "whsec_fake"; process.env.SITE_URL = "https://cuvori.test"; process.env.SUPABASE_URL = process.env.SUPABASE_URL || "https://tnxujwlfatcvxzevllfr.supabase.co";
import crypto from "node:crypto";
export const F = (process.env.TARGET || new URL("..", import.meta.url).pathname.replace(/\/$/, "")) + "/netlify/functions/";
export const uuid = () => crypto.randomUUID();
const U = (role, extra = {}) => ({ id: uuid(), email: role + "@t.com", first_name: role, role: role.startsWith("ed") ? "editor" : "client", is_admin: false, banned: false, ...extra });
export const users = { ed: U("ed"), cl: U("cl"), adm: U("adm", { is_admin: true }), ed2: U("ed2"), cl2: U("cl2") };
export const tokens = { tok_ed: users.ed, tok_cl: users.cl, tok_adm: users.adm, tok_ed2: users.ed2, tok_cl2: users.cl2 };
export const conv = uuid();
export const DB = { rpc_calls: [], profiles: Object.values(users), user_flags: [], messages: [], contracts: [], order_events: [], order_payments: [], order_milestones: [], money_keys: [], site_settings: [],
  payout_details: [{ id: users.ed.id, methods: [], note: "", stripe_account_id: "acct_1EditorAAAAAAAA", stripe_payouts_enabled: true },
                   { id: users.ed2.id, methods: [], note: "", stripe_account_id: "acct_1SecondBBBBBBBB", stripe_payouts_enabled: true }] };
export const CONNECT = { percent: 0.25, fixed_cents: 210 };   // the fee table's "connect" row (schema v50); a test may change it
export const STRIPE = { platform: "acct_1CuvoriPlatformAA", sessions: {}, charges: {}, intents: {}, transfers: [], refunds: [], reversals: [], disputes: {}, idem: new Map(), balance: 0, settleDelay: false,
  // standalone fees (Stripe's billing under funds segregation): the fee rows its Fees report lists, the report runs asked for, their files
  feeRows: [], reports: { end: 0, runs: [], instant: false }, files: {},
  accounts: { acct_1EditorAAAAAAAA: { id: "acct_1EditorAAAAAAAA", payouts_enabled: true, charges_enabled: true, capabilities: { transfers: "active" }, requirements: { currently_due: [] }, metadata: { cuvori_user: users.ed.id } },
              acct_1SecondBBBBBBBB: { id: "acct_1SecondBBBBBBBB", payouts_enabled: true, charges_enabled: true, capabilities: { transfers: "active" }, requirements: { currently_due: [] }, metadata: { cuvori_user: users.ed2.id } } } };
// Funds segregation at the fake (Stripe's private preview "allocated funds"): null = the account has no access, and Stripe
// refuses the preview's parameters. A test sets { access: true, ... } (see fsReset). Every Stripe request's version is
// kept in STRIPE.versions, so a test can see which requests carried the preview version.
STRIPE.fs = null; STRIPE.versions = [];
export const FS_HEADER = "2026-10-28.preview; allocated_funds_preview=v1";
export function fsReset(opts = {}) {
  STRIPE.fs = { access: true, unsupported: "plain", wonTo: "payments", sweepLocked: false, checkoutRefuses: false, feeSubtracts: false, ...opts };
}
const NETWORK = { visa: "visa", mastercard: "mastercard", amex: "american_express", discover: "discover_global_network", diners: "discover_global_network", jcb: "discover_global_network", unionpay: "discover_global_network", cartes_bancaires: null };
const FS_OK = new Set(["visa", "mastercard", "amex", "discover"]);
const isPreview = (h) => !!h && h.version === FS_HEADER;
const hideAlloc = (ch, h) => { if (!ch || isPreview(h) || !("allocated_funds" in ch)) return ch; const { allocated_funds, ...rest } = ch; return rest; };
const allocOf = (ch) => ch && ch.allocated_funds && ch.allocated_funds.enabled ? ch.allocated_funds.balance : null;
// takes from what a payment holds apart (pending first: a linked payout may use it), returns what it could not cover
const takeAllocAvailFirst = (b, cents) => { const a = Math.min(b.available, cents); b.available -= a; let left = cents - a; const p = Math.min(b.pending, left); b.pending -= p; return left - p; };
const takeAlloc = (b, cents) => { const p = Math.min(b.pending, cents); b.pending -= p; let left = cents - p; const a = Math.min(b.available, left); b.available -= a; return left - a; };
// a chargeback at the fake under funds segregation: Stripe takes it from the money held apart first, then from Cuvori's
// balance, and its fee always from Cuvori's balance (Stripe's docs)
export function fsDispute(chid, amount, fee = 1500) {
  const ch = STRIPE.charges[chid], b = allocOf(ch), rest = b ? takeAlloc(b, amount) : amount;
  STRIPE.balance -= rest + fee; ch._disputeFromHeld = amount - rest; ch._disputeOpen = true; return { fromHeld: amount - rest, fromBalance: rest };
}
// the bank decides: won → the money comes back (where to is not in Stripe's docs: STRIPE.fs.wonTo), lost → it stays gone
export function fsDisputeClose(chid, won, amount) {
  const ch = STRIPE.charges[chid]; ch._disputeOpen = false;
  if (!won) return;
  const b = allocOf(ch), back = amount ?? ch.amount;
  if (b && STRIPE.fs.wonTo === "held") b.available += ch._disputeFromHeld || 0, STRIPE.balance += back - (ch._disputeFromHeld || 0);
  else STRIPE.balance += back;
}
export const hooks = { stripe: null, db: null, rpc: null };
// like the real database, a list read can apply its order, offset and limit: off unless a test turns it on (the other suites
// were written for the fake that returns every matching row)
export const DBQ = { paging: false };
function paged(rows, search) {
  const p = new URLSearchParams(search); let out = rows;
  const order = p.get("order");
  if (order) { const [col, dir] = order.split("."); out = [...out].sort((a, b) => { const x = a[col], y = b[col]; if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return (x < y ? -1 : x > y ? 1 : 0) * (dir === "desc" ? -1 : 1); }); }
  const off = Number(p.get("offset") || 0), lim = p.get("limit") != null ? Number(p.get("limit")) : Infinity;
  return out.slice(off, off + lim);
}
// the limit on tries (schema v31): off unless a test turns it on — the other suites press buttons far faster than people do
export const LIMITS = { strict: false, events: [] };
// The header the payment code for the new prices sends with every database request ("x-cuvori-pricing: 2", schema v56's
// pricing_engine): every Supabase request is counted here, and the ones without it are kept, so a check can say it was sent.
export const HDR = { seen: 0, missing: [] };
// Schema v56's rules on the ledger, the Order and its parts (sections 3-6 and 10 of schema_v56.sql), as the database
// enforces them: off unless a test turns it on (the other suites were written for the fake without them). See v56Write.
export const V56 = { on: false };
export const commissionOf = (cents, bps) => Math.floor((cents * bps + 5000) / 10000);   // pricing_commission: half up
const P2 = (c) => !!c && Number(c.pricing_version) >= 2 && c.payment_mode === "escrow";
const REF_KIND = { fund: /^pi_/, release: /^tr_/, refund: /^(re|pyr)_/, reversal: /^trr_/, chargeback: /^(dp|du)_/ };
const same = (a, b) => (a ?? null) === (b ?? null) || (a != null && b != null && String(a) === String(b));
const MONEY_COLS = ["status", "funded_cents", "released_cents", "refunded_cents", "split_editor_cents", "refund_cents", "resolution", "stripe_checkout_id", "stripe_payment_intent", "stripe_charge_id", "stripe_transfer_id", "stripe_refund_id", "stripe_reversal_id", "quote", "fee_cents", "connect_cents", "paid_mode", "funded_at", "chargeback_id", "chargeback_status", "chargeback_cents"];
const FROZEN_ALL = ["order_id", "kind", "amount_cents", "fee_cents", "connect_cents", "status", "provider", "provider_ref", "pricing_version", "entry_key", "commission_cents", "payout_cents", "payout_purpose"];
// order_payments_pricing (a line of a plan 2 Order: badly written lines refused) with the table's own check and unique indexes
function v56PaymentLine(row, engine) {
  const c = DB.contracts.find(x => x.id === row.order_id);
  row.pricing_version = c && c.pricing_version != null ? c.pricing_version : null;
  if (row.entry_key != null && !/^[a-z_]{2,40}:[A-Za-z0-9_:.,-]{1,240}$/.test(row.entry_key)) return ["23514", "order_payments_pricing_ok"];
  if (row.commission_cents != null && !(row.kind === "release" && row.commission_cents >= 0 && row.commission_cents <= row.amount_cents)) return ["23514", "order_payments_pricing_ok"];
  if (row.payout_cents != null && !(row.kind === "release" && row.commission_cents != null && row.payout_cents === row.amount_cents - row.commission_cents)) return ["23514", "order_payments_pricing_ok"];
  if (row.payout_purpose != null && !(row.kind === "release" && ["release", "release_late", "repay"].includes(row.payout_purpose))) return ["23514", "order_payments_pricing_ok"];
  if (!P2(c)) { if (row.commission_cents != null || row.payout_cents != null || row.payout_purpose != null) return ["P0001", "pricing_fields_need_new_prices"]; }
  else {
    if (engine < c.pricing_version) return ["P0001", "pricing_engine_too_old"];
    if (row.status !== "succeeded") return ["P0001", "ledger_line_must_be_succeeded"];
    if (row.entry_key == null) return ["P0001", "entry_key_missing"];
    if (row.provider !== "stripe") return ["P0001", "ledger_provider_stripe_only"];
    if (!row.provider_ref) return ["P0001", "provider_ref_missing"];
    if (!/^[A-Za-z0-9_]{1,255}$/.test(row.provider_ref)) return ["P0001", "provider_ref_one_id"];
    if (REF_KIND[row.kind] && !REF_KIND[row.kind].test(row.provider_ref)) return ["P0001", "provider_ref_wrong_kind"];
    if (row.kind === "fund") {
      row.fee_cents = row.fee_cents ?? 0; row.connect_cents = row.connect_cents ?? 0; row.fee_refund_cents = row.fee_refund_cents ?? 0;
      if ((row.fee_refund_cents !== 0 || row.fee_refund_ref != null) && !(row.fee_refund_cents >= 1 && row.fee_refund_cents <= row.fee_cents + row.connect_cents && /^(re|pyr)_[A-Za-z0-9_]{1,250}$/.test(row.fee_refund_ref || ""))) return ["P0001", "fee_refund_badly_written"];
    } else if ((row.fee_refund_cents || 0) !== 0 || row.fee_refund_ref != null) return ["P0001", "fee_refund_badly_written"];
    else if (row.kind === "release") {
      if (row.commission_cents == null || row.payout_cents == null || row.payout_purpose == null) return ["P0001", "commission_missing"];
      if (row.payout_purpose === "repay" && !/^chargeback_won [A-Za-z0-9_]{1,255}$/.test(row.note || "")) return ["P0001", "repay_line_names_chargeback"];
    } else if (row.kind === "reversal" && !/^chargeback [A-Za-z0-9_]{1,255}$/.test(row.note || "")) return ["P0001", "reversal_line_names_chargeback"];
  }
  if (row.entry_key != null && DB.order_payments.some(p => p.entry_key === row.entry_key)) return ["23505", "duplicate key value violates unique constraint \"order_payments_entry_key_uq\""];
  if (row.pricing_version >= 2 && row.provider_ref && ["fund", "release", "refund", "chargeback", "reversal"].includes(row.kind)
      && DB.order_payments.some(p => p.pricing_version >= 2 && p.kind === row.kind && p.provider_ref === row.provider_ref)) return ["23505", "duplicate key value violates unique constraint \"order_payments_v2_object_uq\""];
  if (row.kind === "fund" && row.provider === "stripe" && row.provider_ref && DB.order_payments.some(p => p.kind === "fund" && p.provider === "stripe" && p.provider_ref === row.provider_ref)) return ["23505", "duplicate key value violates unique constraint \"order_payments_fund_ref_uq\""];
  return null;
}
// order_payments_pricing_frozen: a line keeps what it says; a plan 2 line takes only Stripe's fee, the charge id and the
// refund of a card fee charged by mistake, each once
function v56PaymentFrozen(old, nw) {
  if (FROZEN_ALL.some(k => !same(old[k], nw[k]))) return "ledger_line_frozen";
  if (!(old.pricing_version >= 2)) return null;
  if (["id", "note", "created_at"].some(k => !same(old[k], nw[k]))) return "ledger_line_frozen";
  if (!same(old.fee_refund_cents, nw.fee_refund_cents) && !(old.kind === "fund" && (old.fee_refund_cents || 0) === 0 && old.fee_refund_ref == null
      && nw.fee_refund_cents >= 1 && nw.fee_refund_cents <= (old.fee_cents || 0) + (old.connect_cents || 0) && /^(re|pyr)_[A-Za-z0-9_]{1,250}$/.test(nw.fee_refund_ref || ""))) return "ledger_line_frozen";
  if (!same(old.fee_refund_ref, nw.fee_refund_ref) && !(old.kind === "fund" && old.fee_refund_ref == null && (old.fee_refund_cents || 0) === 0 && /^(re|pyr)_[A-Za-z0-9_]{1,250}$/.test(nw.fee_refund_ref || "") && (nw.fee_refund_cents || 0) > 0)) return "ledger_line_frozen";
  if (!same(old.milestone_id, nw.milestone_id) && nw.milestone_id != null) return "ledger_line_frozen";
  if (!same(old.provider_fee_cents, nw.provider_fee_cents) && (old.provider_fee_cents != null || nw.provider_fee_cents == null || nw.provider_fee_cents < 0)) return "ledger_line_frozen";
  if (!same(old.charge_ref, nw.charge_ref) && old.charge_ref != null) return "ledger_line_frozen";
  return null;
}
// contracts_pricing (old payment code and the commission total), contracts_money_first (release_paused, release_too_early) and v18's
// contracts_money_sane (never more paid out and given back than paid in)
function v56Contract(old, nw, patch, engine) {
  if ("commission_cents" in patch && !same(patch.commission_cents, old.commission_cents)) return ["P0001", "pricing_counters_from_ledger_only"];
  if (P2(old) && engine < old.pricing_version && MONEY_COLS.some(k => JSON.stringify(old[k] ?? null) !== JSON.stringify(nw[k] ?? null))) return ["P0001", "pricing_engine_too_old"];
  if (nw.payment_mode === "escrow" && nw.status === "releasing" && nw.resolution === "release" && (old.status !== "releasing" || old.resolution !== "release")
      && (!["funded", "delivered"].includes(old.status) || old.chargeback_status === "open" || nw.chargeback_status === "open")) return ["P0001", "release_paused"];
  // an automatic payout (nobody named as having decided) starts only once the review period is over (release_too_early)
  if (nw.payment_mode === "escrow" && nw.status === "releasing" && nw.resolution === "release" && (old.status !== "releasing" || old.resolution !== "release")
      && nw.resolved_by == null && (!old.auto_release_at || Date.parse(old.auto_release_at) > Date.now())) return ["P0001", "release_too_early"];
  const f = nw.funded_cents, r = nw.released_cents, b = nw.refunded_cents;
  if (f != null && r != null && b != null && (f < 0 || r < 0 || b < 0 || r + b > Math.max(f, 0))) return ["23514", "new row for relation \"contracts\" violates check constraint \"contracts_money_sane\""];
  return null;
}
// order_milestones_pricing: old payment code, and nothing paid out for a part while the Order is in dispute or a chargeback is open
function v56Milestone(old, nw, engine) {
  const c = DB.contracts.find(x => x.id === old.order_id);
  if (P2(c) && engine < c.pricing_version && ["status", "transfer_ref", "released_at"].some(k => !same(old[k], nw[k]))) return "pricing_engine_too_old";
  if (c && c.payment_mode === "escrow" && ["pending", "submitted"].includes(old.status) && ["approved", "released"].includes(nw.status)
      && (!["funded", "delivered"].includes(c.status) || c.chargeback_status === "open")) return "release_paused";
  return null;
}
const pgErr = ([code, message]) => new Response(JSON.stringify({ code, message }), { status: code === "23505" ? 409 : 400, headers: { "content-type": "application/json" } });
// the next payout's commission on the running total of the Order's normal payout lines (schema v56, pricing_next_commission)
function nextCommission(args) {
  const g = args.p_gross;
  if (!Number.isInteger(g) || g <= 0) return [400, { code: "P0001", message: "bad_amount" }];
  const c = DB.contracts.find(x => x.id === args.p_order);
  if (!c || c.pricing_version == null) return [200, null];
  const before = DB.order_payments.filter(p => p.order_id === c.id && p.kind === "release" && ["release", "release_late"].includes(p.payout_purpose) && p.status === "succeeded").reduce((a, p) => a + p.amount_cents, 0);
  return [200, commissionOf(before + g, c.commission_bps) - commissionOf(before, c.commission_bps)];
}
export const urls = [];
const tick = () => new Promise(r => setImmediate(r));
const rid = (p) => p + "_" + Math.random().toString(36).slice(2, 10);

function parseFilter(q) { const p = new URLSearchParams(q); const f = []; for (const [k, v] of p) { if (["select", "limit", "order"].includes(k)) continue; const m = v.match(/^(eq|neq|lte|gte|lt|gt|in|is|like)\.(.*)$/); if (m) f.push({ k, op: m[1], v: m[1] === "in" ? m[2].replace(/^\(|\)$/g, "").split(",").map(decodeURIComponent) : m[2] }); } return f; }
const match = (row, f) => f.every(x => x.op === "eq" ? String(row[x.k]) === x.v : x.op === "neq" ? String(row[x.k]) !== x.v : x.op === "in" ? x.v.includes(String(row[x.k])) : x.op === "lte" ? (row[x.k] != null && row[x.k] <= x.v) : x.op === "lt" ? (row[x.k] != null && row[x.k] < x.v) : x.op === "gt" ? (row[x.k] != null && row[x.k] > x.v) : x.op === "like" ? new RegExp("^" + decodeURIComponent(x.v).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(String(row[x.k] ?? "")) : x.op === "gte" ? (row[x.k] != null && row[x.k] >= x.v) : x.op === "is" ? (x.v === "null" ? row[x.k] == null : row[x.k] != null) : true);
const res = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const err = (status, message, code) => [status, { error: { message, code, type: "invalid_request_error" } }];

// a client "pays" a checkout session: creates the payment intent + charge and returns the session object Stripe would send.
// A page made with capture_method=manual (hold first, charge after) only places a hold: the PaymentIntent waits in
// requires_capture, nothing is charged and there is no fee until it is captured (and none at all if it is cancelled).
// opts.feeLater: Stripe's fee is not known yet when the card is charged (the test sets charge.balance_transaction later).
// opts.standalone: standalone fees (what funds segregation switches the account to): the payment's balance entry shows a fee
// of 0 and the whole amount; the real fee (opts.feeTax added as tax) is only in the Fees report, as one row for the charge.
export function pay(sessionId, opts = {}) {
  const s = STRIPE.sessions[sessionId]; if (!s) throw new Error("no session " + sessionId);
  const brand = opts.brand || "visa", blocked = Object.entries(s.params || {}).filter(([k]) => k.startsWith("payment_method_options[card][restrictions][brands_blocked]")).map(([, v]) => v);
  if (NETWORK[brand] && blocked.includes(NETWORK[brand])) throw new Error(`the page does not take ${brand} cards`);   // like Checkout: the card is refused on the page
  const pi = rid("pi"), ch = rid("ch"); const total = s.amount_total;
  const fee = opts.fee != null ? opts.fee : Math.round(total * 0.015 + 25);
  const hold = ((s.params || {})["payment_intent_data[capture_method]"]) === "manual";
  // funds segregation switches the whole account to standalone fees (Stripe's docs)
  const sa = opts.standalone ?? !!(STRIPE.fs && STRIPE.fs.access), created = Math.floor(Date.now() / 1000);
  const bt = { id: rid("txn"), fee: sa ? 0 : fee, fee_details: sa ? [] : [{ type: "stripe_fee", amount: fee }], net: sa ? total : total - fee, status: STRIPE.settleDelay ? "pending" : "available", currency: "eur" };
  if (sa) STRIPE.feeRows.push({ incurred_by: ch, incurred_by_type: "charge", amount: fee, tax: opts.feeTax || 0, currency: "eur", created });
  const prm = s.params || {}, group = prm["payment_intent_data[transfer_group]"] || null;
  const md = Object.fromEntries(Object.entries(prm).filter(([k]) => k.startsWith("payment_intent_data[metadata][")).map(([k, v]) => [k.slice(30, -1), v]));
  STRIPE.intents[pi] = { id: pi, amount: total, amount_received: hold ? 0 : total, latest_charge: ch, status: hold ? "requires_capture" : "succeeded", capture_method: hold ? "manual" : "automatic", transfer_group: group, metadata: md, created,
    allocated_requested: prm["payment_intent_data[allocated_funds][enabled]"] === "true" };
  STRIPE.charges[ch] = { id: ch, currency: "eur", amount: total, amount_refunded: 0, sourced: 0, payment_intent: pi, captured: !hold, balance_transaction: hold || opts.feeLater ? null : bt, _bt: bt, _btLater: !!opts.feeLater, payment_method_details: { card: { fingerprint: "fp_" + (opts.card || "one"), brand, last4: "4242" } }, created, transfer_group: group };
  if (!hold && !STRIPE.settleDelay) STRIPE.balance += total - bt.fee;
  s.status = "complete"; s.payment_status = hold ? "unpaid" : "paid"; s.payment_intent = pi;
  return { ...s };
}

// a finished Fees report run: its CSV, like Stripe's itemized report by the time a fee was incurred (amounts in major units),
// with the charges' fee rows of its interval, plus rows that are not card payments' fees
export function finishReport(run) {
  const cell = (v) => /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  const eur = (c) => (c / 100).toFixed(2);
  const rows = STRIPE.feeRows.filter(r => r.created >= run.parameters.interval_start && r.created < run.parameters.interval_end)
    .map(r => [r.incurred_by, r.incurred_by_type, eur(r.amount), eur(r.tax), r.currency, "Payments, card"]);
  rows.push(["po_" + run.id, "payout", "0.35", "0.00", "eur", "Connect, payout"], ["", "", "2.00", "0.00", "eur", "Connect, monthly active account"]);
  const file = "file_" + run.id.replace(/[^A-Za-z0-9]/g, "");
  STRIPE.files[file] = [["incurred_by", "incurred_by_type", "amount", "tax", "currency", "fee_description"], ...rows].map(r => r.map(cell).join(",")).join("\n") + "\n";
  run.status = "succeeded"; run.result = { id: file, object: "file", url: `https://files.stripe.com/v1/files/${file}/contents` };
}
export function stripeHandle(path, method, p, h = {}) {
  const seg = path.split("/");
  // ---- funds segregation (only when a test gives the account the preview) ----
  if (path === "/balance_transfers" && method === "POST") {
    if (!STRIPE.fs || !STRIPE.fs.access || !isPreview(h)) return err(404, "Unrecognized request URL (POST: /v1/balance_transfers)");
    const amount = +p.get("amount"), chid = p.get("source_balance[allocated_funds][charge]"), ch = STRIPE.charges[chid], b = allocOf(ch);
    if (p.get("source_balance[type]") !== "allocated_funds" || p.get("source_balance[allocated_funds][type]") !== "charge" || p.get("destination_balance[type]") !== "payments") return err(400, "Invalid balance transfer");
    if (!b) return err(400, "No allocated funds for charge " + chid);
    if (p.get("currency") !== ch.currency) return err(400, "The currency must match the currency the charge settled in");
    const free = b.available - (STRIPE.fs.sweepLocked ? 0 : ch._locked || 0);
    if (!(amount > 0) || amount > free) return err(400, "Insufficient allocated funds available on charge " + chid + (ch._locked ? " (funds reversed during a dispute stay allocated: contact Stripe)" : ""));
    b.available -= amount; if (STRIPE.fs.sweepLocked) ch._locked = Math.max(0, (ch._locked || 0) - amount); STRIPE.balance += amount;
    const bt = { id: rid("baltr"), object: "balance_transfer", amount, currency: ch.currency, source_balance: { type: "allocated_funds", allocated_funds: { type: "charge", charge: chid } }, destination_balance: { type: "payments" } };
    (STRIPE.balanceTransfers = STRIPE.balanceTransfers || []).push(bt); return [200, bt];
  }
  if (seg[1] === "payment_intents" && seg[2] && !seg[3] && method === "POST") {      // asking a hold to be held apart before it is charged
    const pi = STRIPE.intents[seg[2]]; if (!pi) return err(404, "No such payment_intent", "resource_missing");
    if (p.get("allocated_funds[enabled]") != null) {
      if (!STRIPE.fs || !STRIPE.fs.access || !isPreview(h)) return err(400, "Received unknown parameter: allocated_funds");
      if (pi.status !== "requires_capture") return err(400, "allocated_funds can only be set before capture");
      pi.allocated_requested = p.get("allocated_funds[enabled]") === "true";
    }
    return [200, { ...pi }];
  }
  if (path === "/reporting/report_types" && method === "GET") return [200, { object: "list", data: [{ id: "balance.summary.1", data_available_start: 1500000000, data_available_end: STRIPE.reports.end }, { id: "all_fees.incurred_at.itemized.2", data_available_start: 1500000000, data_available_end: STRIPE.reports.end }] }];
  if (path === "/reporting/report_runs" && method === "GET") return [200, { object: "list", data: [...STRIPE.reports.runs].reverse() }];
  if (path === "/reporting/report_runs" && method === "POST") {
    const run = { id: rid("frr"), object: "reporting.report_run", report_type: p.get("report_type"), status: "pending", result: null, created: Math.floor(Date.now() / 1000),
      parameters: { interval_start: +p.get("parameters[interval_start]"), interval_end: +p.get("parameters[interval_end]"), columns: [...p.keys()].filter(k => k.startsWith("parameters[columns]")).map(k => p.get(k)) } };
    if (!(run.parameters.interval_end <= STRIPE.reports.end)) return err(400, "interval_end must be at most data_available_end");
    STRIPE.reports.runs.push(run); if (STRIPE.reports.instant) finishReport(run); return [200, run];
  }
  if (path === "/account" && method === "GET") return [200, { id: STRIPE.platform, object: "account" }];   // the Stripe account the keys belong to
  if (path === "/account_links") return [200, { url: "https://connect.stripe.com/setup/" + p.get("account") }];
  if (path === "/accounts" && method === "POST") { const id = rid("acct"); STRIPE.accounts[id] = { id, payouts_enabled: false, charges_enabled: false, requirements: { currently_due: ["external_account"] }, metadata: { cuvori_user: p.get("metadata[cuvori_user]") } }; return [200, STRIPE.accounts[id]]; }
  if (seg[1] === "accounts" && method === "GET") return STRIPE.accounts[seg[2]] ? [200, STRIPE.accounts[seg[2]]] : err(404, "No such account: " + seg[2], "resource_missing");
  if (path === "/transfers" && method === "GET") return [200, { data: STRIPE.transfers.filter(t => t.transfer_group === p.get("transfer_group")) }];
  if (path === "/refunds" && method === "GET") return [200, { data: STRIPE.refunds.filter(r => r.payment_intent === p.get("payment_intent")) }];
  if (seg[1] === "checkout" && seg[2] === "sessions" && seg[4] === "expire") { const s = STRIPE.sessions[seg[3]]; if (!s) return err(404, "No such checkout.session", "resource_missing"); if (s.status !== "open") return err(400, "Only Checkout Sessions with a status in [\"open\"] can be expired."); s.status = "expired"; return [200, s]; }   // like Stripe: a paid page cannot be expired
  if (seg[1] === "checkout" && seg[2] === "sessions" && seg[3] && method === "GET") return STRIPE.sessions[seg[3]] ? [200, STRIPE.sessions[seg[3]]] : err(404, "No such checkout.session", "resource_missing");
  // like Stripe's "List all Checkout Sessions": filtered by the payment it made (payment_intent), newest first
  if (path === "/checkout/sessions" && method === "GET") return [200, { object: "list", has_more: false, data: Object.values(STRIPE.sessions).filter(s => !p.get("payment_intent") || s.payment_intent === p.get("payment_intent")).sort((a, b) => b.created - a.created).slice(0, Number(p.get("limit") || 10)) }];
  if (path === "/checkout/sessions") {
    if (p.get("payment_intent_data[allocated_funds][enabled]") != null && (!STRIPE.fs || !STRIPE.fs.access || !isPreview(h) || STRIPE.fs.checkoutRefuses)) return err(400, "Received unknown parameter: payment_intent_data[allocated_funds]");
    if ([...p.keys()].some(k => k.startsWith("payment_method_options[card][restrictions]")) && (h.version || "2024-06-20") === "2024-06-20") return err(400, "Received unknown parameter: payment_method_options[card][restrictions]");   // from 2025-02-24 on
    const id = rid("cs"); const a0 = +p.get("line_items[0][price_data][unit_amount]"), a1 = +(p.get("line_items[1][price_data][unit_amount]") || 0), a2 = +(p.get("line_items[2][price_data][unit_amount]") || 0);
    STRIPE.sessions[id] = { id, object: "checkout.session", created: Math.floor(Date.now() / 1000), mode: "payment", status: "open", payment_status: "unpaid", payment_intent: null, url: "https://checkout.stripe.com/" + id, client_reference_id: p.get("client_reference_id"), amount_total: a0 + a1 + a2, currency: p.get("line_items[0][price_data][currency]"), amounts: [a0, a1],
      metadata: { ...Object.fromEntries([...p.keys()].filter(k => /^metadata\[[a-z_]+\]$/.test(k)).map(k => [k.slice(9, -1), p.get(k)])), contract_id: p.get("metadata[contract_id]"), amount_cents: p.get("metadata[amount_cents]"), fee_cents: p.get("metadata[fee_cents]"), ...(p.get("metadata[connect_cents]") != null ? { connect_cents: p.get("metadata[connect_cents]") } : {}), kind: p.get("metadata[kind]"), ...(p.get("metadata[quote]") != null ? { quote: p.get("metadata[quote]") } : {}) }, params: Object.fromEntries(p) };
    return [200, STRIPE.sessions[id]];
  }
  if (seg[1] === "charges" && seg[2] && method === "GET") { const ch = STRIPE.charges[seg[2]]; return ch ? [200, hideAlloc(ch, h)] : err(404, "No such charge", "resource_missing"); }
  if (path === "/charges" && method === "GET") return [200, { object: "list", has_more: false, data: Object.values(STRIPE.charges).filter(ch => !p.get("transfer_group") || ch.transfer_group === p.get("transfer_group")).filter(ch => !p.get("payment_intent") || ch.payment_intent === p.get("payment_intent")) }];
  if (seg[1] === "transfers" && seg[2] && seg[3] === "reversals" && method === "GET") { const t = STRIPE.transfers.find(x => x.id === seg[2]); return t ? [200, { object: "list", has_more: false, data: STRIPE.reversals.filter(r => r.transfer === t.id) }] : err(404, "No such transfer", "resource_missing"); }
  if (seg[1] === "transfers" && seg[2] && !seg[3] && method === "GET") { const t = STRIPE.transfers.find(x => x.id === seg[2]); return t ? [200, t] : err(404, "No such transfer", "resource_missing"); }
  if (path === "/disputes" && method === "GET") return [200, { data: Object.entries(STRIPE.disputes).filter(([chid]) => STRIPE.charges[chid] && (!p.get("payment_intent") || STRIPE.charges[chid].payment_intent === p.get("payment_intent")) && (!p.get("charge") || chid === p.get("charge")))
    .map(([chid, d]) => ({ id: d.id || "dp_" + chid, object: "dispute", charge: chid, payment_intent: STRIPE.charges[chid].payment_intent, amount: d.amount ?? STRIPE.charges[chid].amount, status: d.status, ...(typeof d.is_charge_refundable === "boolean" ? { is_charge_refundable: d.is_charge_refundable } : {}) })) }];   // a payment's chargebacks (is_charge_refundable: only when a test sets it)
  if (seg[1] === "disputes" && seg[2] && method === "GET") { const d = STRIPE.disputeObjs && STRIPE.disputeObjs[seg[2]]; return d ? [200, d] : err(404, "No such dispute", "resource_missing"); }
  if (seg[1] === "payment_intents" && method === "GET") { const pi = STRIPE.intents[seg[2]]; if (!pi) return err(404, "No such payment_intent", "resource_missing"); return [200, { ...pi, latest_charge: hideAlloc(STRIPE.charges[pi.latest_charge], h) }]; }
  if (path === "/transfers" && method === "POST") {
    const amount = +p.get("amount"), src = p.get("source_transaction"), dest = p.get("destination");
    if (!STRIPE.accounts[dest]) return err(400, "No such destination: " + dest, "resource_missing");
    if (!STRIPE.accounts[dest].payouts_enabled) return err(400, "Your destination account needs to have at least one of the following capabilities enabled: transfers", "insufficient_capabilities_for_transfer");
    const fsFee = p.get("application_fee_amount") != null ? +p.get("application_fee_amount") : 0;
    if (src && allocOf(STRIPE.charges[src])) {
      const c = STRIPE.charges[src], b = allocOf(c);
      if (!isPreview(h)) return err(400, "Transfers of allocated funds need the allocated_funds_preview header");
      if (!(amount > 0) || !Number.isInteger(amount) || !Number.isInteger(fsFee) || fsFee < 0) return err(400, "Invalid positive integer: amount");
      // feeSubtracts: the other reading of Stripe's docs, where the 5% comes out of the transfer's own amount
      const need = STRIPE.fs.feeSubtracts ? amount : amount + fsFee;
      if (need > b.available + b.pending) return err(400, "The amount of this transfer exceeds the allocated funds available on the source charge");
      takeAlloc(b, need); c.sourced += need; STRIPE.balance += fsFee;
    } else if (fsFee) return err(400, "application_fee_amount can only be used with a source_transaction whose funds are allocated");
    else if (src) { const c = STRIPE.charges[src]; if (!c) return err(400, "No such charge: " + src, "resource_missing"); if (c.captured === false) return err(400, "The source charge has not been captured."); if (c.sourced + amount > c.amount - c.amount_refunded) return err(400, "The amount of this transfer exceeds the amount available on the source charge", "invalid_request_error"); c.sourced += amount; }
    else { if (STRIPE.balance < amount) return err(400, "You have insufficient funds in your Stripe account. One likely reason is that your balance is pending settlement.", "balance_insufficient"); STRIPE.balance -= amount; }
    if (!(amount > 0) || !Number.isInteger(amount)) return err(400, "Invalid positive integer: amount");    // like Stripe: a transfer of 0 is refused
    // every metadata key sent is kept (the new prices' payouts carry gross, commission and payout in it); created in seconds, like Stripe
    const md = Object.fromEntries([...p.keys()].filter(k => /^metadata\[[a-z_]+\]$/.test(k)).map(k => [k.slice(9, -1), p.get(k)]));
    const t = { id: rid("tr"), object: "transfer", created: (Date.now() + STRIPE.transfers.length) / 1000, amount, currency: p.get("currency"), destination: dest, reversed: false, amount_reversed: 0, contract: p.get("metadata[contract_id]"), metadata: { ...md, contract_id: p.get("metadata[contract_id]"), milestone_id: p.get("metadata[milestone_id]") || "", purpose: p.get("metadata[purpose]") || "release", attempt: p.get("metadata[attempt]") || "" }, transfer_group: p.get("transfer_group"), source_transaction: src || null };
    if (fsFee) { t.application_fee_amount = fsFee; t.application_fee = { id: rid("fee"), object: "application_fee", amount: fsFee, currency: t.currency, fee_source: { type: "transfer", transfer: t.id } }; }
    // what reached the freelancer's account (the amount, or under the other reading of the docs, the amount less the 5%)
    t._received = STRIPE.fs && STRIPE.fs.feeSubtracts ? amount - fsFee : amount;
    STRIPE.transfers.push(t); return [200, t];
  }
  if (seg[1] === "transfers" && seg[3] === "reversals" && method === "POST") { const t = STRIPE.transfers.find(x => x.id === seg[2]); if (!t) return err(404, "No such transfer", "resource_missing"); const amount = +(p.get("amount") || (t.amount - t.amount_reversed)); if (amount + t.amount_reversed > t.amount) return err(400, "Reversal amount exceeds the transfer amount"); t.amount_reversed += amount; t.reversed = t.amount_reversed === t.amount; const r = { id: rid("trr"), object: "transfer_reversal", amount, transfer: t.id, created: (Date.now() + STRIPE.reversals.length) / 1000, metadata: { contract_id: p.get("metadata[contract_id]") || "", reason: p.get("metadata[reason]") || "" } }; STRIPE.reversals.push(r);
    const sch = t.source_transaction && STRIPE.charges[t.source_transaction], sb = allocOf(sch);
    // a pull-back of money that a payment's own transfer sent out returns it to that payment: the payment can be refunded
    // again up to that amount (the "not yet transferred" rule below counts the pull-back)
    if (sch) sch.sourced = Math.max(0, sch.sourced - amount);
    // like Stripe's docs: a pull-back of money held apart goes back into it; during a chargeback it stays there whatever the bank decides
    if (sb) { sb.available += amount; if (sch._disputeOpen || (STRIPE.disputes[sch.id] && !["won", "lost", "warning_closed"].includes(STRIPE.disputes[sch.id].status))) sch._locked = (sch._locked || 0) + amount; }
    else STRIPE.balance += amount;
    return [200, r]; }
  if (path === "/refunds" && method === "POST") {
    const pi = p.get("payment_intent"), amount = +p.get("amount"); const intent = STRIPE.intents[pi]; if (!intent) return err(404, "No such payment_intent: " + pi, "resource_missing");
    const ch = STRIPE.charges[intent.latest_charge]; if (ch.captured === false) return err(400, "This PaymentIntent has not been captured: cancel it instead of refunding it.", "charge_not_captured"); { const d = STRIPE.disputes[ch.id];      // like Stripe: no refund while a chargeback is open; an inquiry ("warning_…") can be refunded; after a lost chargeback, only what the bank did not take back; never when the chargeback's record says the payment cannot be refunded
      if (d && (d.is_charge_refundable === false || !["won", "lost", "warning_needs_response", "warning_under_review", "warning_closed", "prevented"].includes(d.status) || (d.status === "lost" && amount > ch.amount - (d.amount ?? ch.amount) - ch.amount_refunded)))
        return err(400, "Charge " + ch.id + " has been charged back; cannot issue a refund.", "charge_disputed"); }
    if (amount > ch.amount - ch.amount_refunded) return err(400, "Refund amount (€" + (amount / 100).toFixed(2) + ") is greater than unrefunded amount on charge (€" + ((ch.amount - ch.amount_refunded) / 100).toFixed(2) + ")", "amount_too_large");
    if (ch.sourced > ch.amount - ch.amount_refunded - amount) return err(400, "Cannot refund more than the amount not yet transferred from this charge");
    ch.amount_refunded += amount;
    { const b = allocOf(ch); STRIPE.balance -= b ? takeAllocAvailFirst(b, amount) : amount; }
    const r = { id: rid("re"), created: (Date.now() + STRIPE.refunds.length) / 1000, amount, contract: p.get("metadata[contract_id]"), metadata: { contract_id: p.get("metadata[contract_id]"), reason: p.get("metadata[reason]") || "", ...(p.get("metadata[kind]") ? { kind: p.get("metadata[kind]") } : {}) }, payment_intent: pi, charge: ch.id, status: "succeeded" }; STRIPE.refunds.push(r); return [200, r];
  }
  if (seg[1] === "payment_intents" && seg[3] === "capture" && method === "POST") {
    const p = STRIPE.intents[seg[2]]; if (!p) return err(404, "No such payment_intent: " + seg[2], "resource_missing");
    if (p.status !== "requires_capture") return err(400, `This PaymentIntent could not be captured because it has a status of ${p.status}.`, "payment_intent_unexpected_state");
    const ch = STRIPE.charges[p.latest_charge];
    if (p.allocated_requested) {
      if (!STRIPE.fs || !STRIPE.fs.access || !isPreview(h)) return err(400, "This PaymentIntent asks for allocated funds: send the allocated_funds_preview header");
      if (!FS_OK.has(ch.payment_method_details.card.brand) && STRIPE.fs.unsupported === "refuse") return err(400, "Allocated funds are not supported for this payment method");
    }
    p.status = "succeeded"; p.amount_received = p.amount; ch.captured = true; ch.balance_transaction = ch._btLater ? null : ch._bt;
    if (p.allocated_requested && FS_OK.has(ch.payment_method_details.card.brand)) {
      // held apart: not in Cuvori's balance at all (Stripe's docs: "Funds in this state don't appear in your platform balance")
      ch.allocated_funds = { enabled: true, balance: { available: STRIPE.settleDelay ? 0 : ch.amount, pending: STRIPE.settleDelay ? ch.amount : 0, currency: ch.currency } };
    } else if (!STRIPE.settleDelay) STRIPE.balance += ch.amount - ch._bt.fee;
    return [200, { ...p }];
  }
  if (seg[1] === "payment_intents" && seg[3] === "cancel" && method === "POST") {
    const p = STRIPE.intents[seg[2]]; if (!p) return err(404, "No such payment_intent: " + seg[2], "resource_missing");
    if (!["requires_capture", "requires_payment_method", "requires_confirmation", "requires_action"].includes(p.status)) return err(400, `You cannot cancel this PaymentIntent because it has a status of ${p.status}.`, "payment_intent_unexpected_state");
    const ch = STRIPE.charges[p.latest_charge]; p.status = "canceled"; p.cancellation_reason = p.cancellation_reason || null;
    if (ch && !ch.captured) { ch.amount_refunded = ch.amount; ch.refunded = true; }                  // the hold is released: nothing was ever charged, no fee
    return [200, { ...p }];
  }
  return err(404, "unknown " + path);
}

globalThis.fetch = async (url, init = {}) => {
  urls.push((init.method || "GET") + " " + url);
  await tick();
  const u = new URL(url); const method = init.method || "GET"; const body = init.body;
  if (u.hostname === "api.stripe.com") {
    const p = new URLSearchParams(method === "GET" ? u.search : (body || "")); const path = u.pathname.replace("/v1", "");
    const key = init.headers["Idempotency-Key"];
    if (key && method === "POST") {
      const prev = STRIPE.idem.get(key);
      if (prev && prev.inflight) return res(409, { error: { type: "invalid_request_error", code: "idempotency_key_in_use", message: "There is currently another in-progress request using this idempotent key. Please try again later." } });   // Stripe's documented code for it (its docs do not say which type comes with it)
      if (prev && prev.body !== body) return res(400, { error: { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters they were first used with." } });
      if (prev) return new Response(JSON.stringify(prev.data), { status: prev.status, headers: { "content-type": "application/json", "Idempotent-Replayed": "true" } });   // like Stripe: a replay says so
      STRIPE.idem.set(key, { inflight: true, body });
    }
    let status, data;
    const hd = { version: (init.headers || {})["Stripe-Version"] || null };
    STRIPE.versions.push({ method, path, version: hd.version });
    try { const h = hooks.stripe && await hooks.stripe(path, method, p, hd); [status, data] = h || stripeHandle(path, method, p, hd); }
    catch (e) { if (key && method === "POST") STRIPE.idem.delete(key); throw e; }
    finally { await tick(); }
    if (status >= 400 && status < 500 && data && data.error && !data.error.type) data = { ...data, error: { ...data.error, type: "invalid_request_error" } };   // real Stripe always names the error type
    if (key && method === "POST") STRIPE.idem.set(key, { body, status, data });
    return res(status, data);
  }
  if (u.hostname === "files.stripe.com") {          // a report's file: only with the secret key, like Stripe
    if ((init.headers || {}).Authorization !== "Bearer " + process.env.STRIPE_SECRET_KEY) return res(401, { error: { message: "Invalid API Key provided" } });
    const t = STRIPE.files[u.pathname.split("/")[3]]; return t == null ? res(404, { error: { message: "No such file" } }) : new Response(t, { status: 200, headers: { "content-type": "text/csv" } });
  }
  // every request to Supabase: was the new prices' header sent with it?
  const ph = String((init.headers || {})["x-cuvori-pricing"] ?? ""), engine = /^[0-9]{1,3}$/.test(ph) ? Number(ph) : 0;
  if (u.pathname.startsWith("/rest/v1/") || u.pathname.startsWith("/auth/v1/")) { if (ph === "2") HDR.seen++; else if (HDR.missing.length < 50) HDR.missing.push(method + " " + u.pathname); }
  if (u.pathname === "/auth/v1/user") { const t = (init.headers.Authorization || "").replace("Bearer ", ""); return tokens[t] ? res(200, tokens[t]) : res(403, { code: 403, error_code: "bad_jwt", msg: "invalid JWT: unable to parse or verify signature" }); }
  if (u.pathname.startsWith("/rest/v1/rpc/")) { const fn = u.pathname.split("/")[4], args = JSON.parse(body); DB.rpc_calls.push({ fn, args });
    if (hooks.rpc) { const h = await hooks.rpc(fn, args); if (h) return res(h[0], h[1]); }
    if (fn === "pricing_next_commission") { const [st, d] = nextCommission(args); return res(st, d); }
    if (fn === "order_quote") { const p = args.p_price_cents; if (!Number.isInteger(p) || p < 0) return res(400, { message: "bad_price" }); const pct = args.p_country == null || args.p_country === "US" ? 3.25 : 1.5; /* no country = the ceiling row, what the page and the checkout use */
      // like schema v50: Stripe's payout fees as their own line (the "connect" row: 0.25% + 210 cents; a top-up pays the percentage only), and the card fee on price + that line
      const connect = p > 0 ? Math.ceil(p * CONNECT.percent / 100) + (args.p_topup ? 0 : CONNECT.fixed_cents) : 0, base = p + connect;
      const total = Math.ceil((base + 25) / (1 - pct / 100)); return res(200, { price_cents: p, processing_cents: total - base, connect_cents: connect, cuvori_cents: 0, total_cents: total, currency: "EUR", payer: "client", percent: pct, fixed_cents: 25, connect_schedule_id: 4, connect_percent: CONNECT.percent, connect_fixed_cents: CONNECT.fixed_cents, topup: !!args.p_topup }); }
    if (fn === "expire_jobs") return res(200, 0);
    if (fn === "rate_limit_for") return res(200, true);      // the older per-minute-only limit (schema v30): always lets through here
    if (fn === "rate_limit_tries") {                   // like the database function (schema v31): this person's tries of this kind, per minute and per day
      if (!LIMITS.strict) return res(200, "ok");
      const now = Date.now(), same = (e) => e.user_id === args.p_user && e.kind === args.p_kind;
      LIMITS.events = LIMITS.events.filter(e => !(same(e) && e.at < now - 86400e3));
      const mine = LIMITS.events.filter(same);
      if (mine.filter(e => e.at >= now - 60e3).length >= args.p_per_minute) return res(200, "minute");
      if (mine.length >= args.p_per_day) return res(200, "day");
      LIMITS.events.push({ user_id: args.p_user, kind: args.p_kind, at: now }); return res(200, "ok");
    }
    return res(200, null); }
  if (u.pathname.startsWith("/rest/v1/")) {
    const table = u.pathname.split("/")[3]; const f = parseFilter(u.search.slice(1)); const rows = DB[table]; if (!rows) return res(404, { message: `relation "${table}" does not exist` });
    if (hooks.db) { const h = await hooks.db(method, table, u.search, body); if (h) return h; }
    // like the real database: text holding half an emoji (a lone surrogate) is refused, never stored
    if ((method === "POST" || method === "PATCH") && body) { const bad = (v) => typeof v === "string" ? !v.isWellFormed() : v && typeof v === "object" ? Object.values(v).some(bad) : false; if (bad(JSON.parse(body))) return res(400, { code: "22P05", message: "unsupported Unicode escape sequence" }); }
    if (method === "GET") { const hit = rows.filter(r => match(r, f)); return res(200, DBQ.paging ? paged(hit, u.search.slice(1)) : hit); }
    if (V56.on && (method === "PATCH" || method === "POST") && body) {
      // schema v56's triggers, every row first (one refused row: nothing is written, as in one database statement)
      const patch = JSON.parse(body);
      if (method === "POST" && table === "order_payments") { const why = v56PaymentLine(patch, engine); if (why) return pgErr(why); init.body = JSON.stringify(patch); }
      if (method === "POST" && table === "money_keys") { const o = String(patch.scope || "").split(":")[1], c = DB.contracts.find(x => x.id === o); if (P2(c) && engine < c.pricing_version) return pgErr(["P0001", "pricing_engine_too_old"]); }
      if (method === "PATCH") for (const old of rows.filter(r => match(r, f))) {
        const nw = { ...old, ...patch };
        const why = table === "order_payments" ? (v56PaymentFrozen(old, nw) && ["P0001", v56PaymentFrozen(old, nw)]) : table === "contracts" ? v56Contract(old, nw, patch, engine) : table === "order_milestones" ? (v56Milestone(old, nw, engine) && ["P0001", v56Milestone(old, nw, engine)]) : null;
        if (why) return pgErr(why);
      }
    }
    const body2 = init.body;
    if (V56.on && method === "POST" && table === "order_payments") {
      // order_payments_pricing_totals: the Order's commission total follows its plan 2 payout lines
      const row = JSON.parse(body2), c = DB.contracts.find(x => x.id === row.order_id);
      if (row.pricing_version >= 2 && row.kind === "release" && row.status === "succeeded" && (row.commission_cents || 0) > 0 && c) c.commission_cents = (c.commission_cents || 0) + row.commission_cents;
      const out = { id: uuid(), created_at: new Date().toISOString(), ...row }; if (out.created_at == null) out.created_at = new Date().toISOString(); rows.push(out); return res(201, [out]);
    }
    if (method === "PATCH") { const patch = JSON.parse(body); const o = rows.filter(r => match(r, f));
      // like the database (schema v32): money is recorded on an Order only in the mode the database is in, never mixed
      if (table === "contracts" && patch.paid_mode) {
        const dbMode = (DB.site_settings.find(r => r.key === "stripe_mode") || {}).value === "live" ? "live" : "test";
        for (const r of o) {
          if (r.paid_mode && r.paid_mode !== patch.paid_mode) return res(400, { code: "P0001", message: "stripe_mode_mixed" });
          if ((r.paid_mode !== patch.paid_mode || (patch.funded_cents || 0) > (r.funded_cents || 0)) && patch.paid_mode !== dbMode) return res(400, { code: "P0001", message: "stripe_mode_changed" });
        }
      }
      o.forEach(r => Object.assign(r, patch)); return res(200, o); }
    if (method === "POST") { const row = { id: uuid(), created_at: new Date().toISOString(), ...JSON.parse(body) }; if (table === "money_keys" && rows.some(r => r.scope === row.scope)) return res(409, { code: "23505", message: "duplicate key value violates unique constraint \"money_keys_pkey\"" }); if (table === "payout_details" && rows.some(r => r.id === row.id)) return res(409, { code: "23505", message: "duplicate key value violates unique constraint \"payout_details_pkey\"" }); if (table === "site_settings" && rows.some(r => r.key === row.key)) return String((init.headers || {}).Prefer || "").includes("ignore-duplicates") ? res(201, []) : res(409, { code: "23505", message: "duplicate key value violates unique constraint \"site_settings_pkey\"" }); rows.push(row); return res(201, [row]); }
    if (method === "DELETE") { const keep = rows.filter(r => !match(r, f)); const gone = rows.length - keep.length; rows.length = 0; rows.push(...keep); return res(200, []); }
  }
  throw new Error("unexpected fetch " + url);
};
export const req = (method, path, { token, body, raw, headers } = {}) => new Request("https://cuvori.test/.netlify/functions/" + path, { method, headers: { ...(token ? { authorization: "Bearer " + token } : {}), ...(headers || {}) }, body: raw != null ? raw : body !== undefined ? JSON.stringify(body) : undefined });
export const sigFor = (payload, t = Math.floor(Date.now() / 1000), secret = "whsec_fake") => ({ t, v1: crypto.createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex") });
export const signed = (obj, secret) => { if (obj && /^charge\.dispute\./.test(obj.type || "") && obj.data && obj.data.object) { STRIPE.disputeObjs = STRIPE.disputeObjs || {}; STRIPE.disputeObjs[obj.data.object.id] = { ...(STRIPE.disputeObjs[obj.data.object.id] || {}), ...obj.data.object }; } const raw = JSON.stringify({ id: rid("evt"), ...obj }); const s = sigFor(raw, undefined, secret); return { raw, headers: { "stripe-signature": `t=${s.t},v1=${s.v1}` } }; };
export const call = async (fn, r) => { try { const x = await fn(r); let j = null; try { j = await x.clone().json(); } catch {} return { status: x.status, json: j, headers: x.headers }; } catch (e) { return { status: 500, thrown: e.constructor.name + ": " + e.message }; } };
export const mk = (o = {}) => { const c = { id: uuid(), conversation_id: conv, editor: users.ed.id, client: users.cl.id, proposed_by: users.ed.id, title: "Job", price: 100, currency: "EUR", pricing: "project", status: "accepted", payment_mode: "escrow", amount_cents: 10000, fee_cents: 0, funded_cents: 0, released_cents: 0, refunded_cents: 0, has_milestones: false, stripe_payment_intent: null, ...o }; DB.contracts.push(c); return c; };
export const past = (h = 1) => new Date(Date.now() - h * 3600e3).toISOString();
export const moneyOut = (c) => ({ transferred: STRIPE.transfers.filter(t => t.contract === c.id).reduce((a, t) => a + t.amount - t.amount_reversed, 0), refunded: STRIPE.refunds.filter(r => r.contract === c.id && r.metadata.kind !== "fee_surplus").reduce((a, r) => a + r.amount, 0), feeBack: STRIPE.refunds.filter(r => r.contract === c.id && r.metadata.kind === "fee_surplus").reduce((a, r) => a + r.amount, 0), orphans: STRIPE.refunds.filter(r => r.contract === c.id && r.metadata.reason).reduce((a, r) => a + r.amount, 0) });
export const reset = () => { hooks.stripe = null; hooks.db = null; hooks.rpc = null; STRIPE.settleDelay = false; };
export const onlyDue = (c) => { for (const x of DB.contracts) if (x !== c && ["delivered", "releasing", "resolving"].includes(x.status)) x.status = "completed"; for (const m of DB.order_milestones) if (m.order_id !== c.id && m.status !== "released") m.status = "released"; };
export const fns = async () => ({
  connect: (await import(F + "stripe-connect.mjs")).default, checkout: (await import(F + "stripe-checkout.mjs")).default, webhook: (await import(F + "stripe-webhook.mjs")).default,
  release: (await import(F + "stripe-release.mjs")).default, resolve: (await import(F + "stripe-resolve.mjs")).default, cancel: (await import(F + "stripe-cancel.mjs")).default,
  autoRelease: (await import(F + "stripe-auto-release.mjs")).default, status: (await import(F + "stripe-status.mjs")).default,
  confirm: await import(F + "stripe-confirm.mjs").then(m => m.default).catch(() => null) });
// fund an order the way a real client does: checkout -> pay -> webhook
export async function fund(fx, c, opts = {}) {
  const r0 = await call(fx.checkout, req("POST", "x", { token: opts.token || "tok_cl", body: { contract_id: c.id, ...(opts.body || {}) } }));
  if (r0.status !== 200) return { checkout: r0 };
  const s = pay(c.stripe_checkout_id, opts);
  const w = await call(fx.webhook, req("POST", "x", signed({ type: "checkout.session.completed", data: { object: s } })));
  return { checkout: r0, session: s, webhook: w };
}
