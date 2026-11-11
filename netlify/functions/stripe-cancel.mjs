// POST { contract_id } (freelancer) — give a funded Order back: everything still held goes back to the
// client, except what a won chargeback pulled back from the freelancer and is still owed to them (theirs, paid
// to them once the Order is closed). A client who wants out after funding asks the freelancer (or opens a dispute); money never
// moves on one side's say-so in the other direction.
import { escrowEnabled, db, userFromRequest, json, bad, refuse, settle, readJson, safe, limitTries, heldCents, orderEvent, chargebackOpen, cut, closeCheckout, moneyUnchanged, owedBack, countFirst, payoutsNotCounted } from "../lib/cuvori.mjs";

// a database filter: the column is still what was read (null included)
const same = (col, v) => (v == null ? `${col}=is.null` : `${col}=eq.${Number(v)}`);

export default safe(async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  if (!escrowEnabled()) return refuse(503, "Protected payments are not configured yet", "payments_paused");
  const me = await userFromRequest(req);
  if (!me) return refuse(401, "Sign in first", "signed_out");
  if (me.banned) return refuse(403, "Account suspended", "account_suspended");
  const { contract_id: id, note, preview } = await readJson(req);
  // at most about 10 tries a minute and 50 a day: nobody can use up Stripe's limits for everyone (the page's question before
  // the confirmation, preview, has its own count, so it never uses up the cancel's)
  await limitTries(me, preview === true ? "pay_cancel_preview" : "pay_cancel");
  // the page's question is true, or nothing at all: anything else (the text "true", a number) is refused, never taken for a
  // real cancel that gives the whole Order back (check of 6 November)
  if (preview !== undefined && typeof preview !== "boolean") return refuse(400, "preview must be true or false", "cannot_cancel");
  let c = await db.contract(id);
  if (!c || c.editor !== me.id) return refuse(403, "Not your order", "not_your_order");
  if (c.payment_mode !== "escrow") return refuse(409, "This order is not holding money", "cannot_cancel");
  const held = heldCents(c);
  if (!held) return refuse(409, "This order is not holding money", "cannot_cancel");
  if (chargebackOpen(c)) return json(409, { error: "A card chargeback is open on this payment. Nothing can move until the bank decides.", code: "chargeback_open" });
  // what giving the Order back would send to the client, nothing changed: the page's confirmation shows it when a won
  // chargeback's re-payment may still be owed to the freelancer (that stays theirs, so less than all that is held goes back)
  // (and a payout Stripe made that the Order does not count yet, a part's or a re-payment: the cancel counts it first, below)
  if (preview === true) return json(200, { ok: true, refund_cents: Math.max(held - await owedBack(c) - await payoutsNotCounted(c), 0) });
  let row = c.status === "resolving" && c.resolution === "refund" && c.resolved_by === me.id ? c : null;   // resume
  if (!row) {
    if (!["funded", "delivered"].includes(c.status)) return refuse(409, "This order cannot be cancelled right now", "cannot_cancel");
    // Nothing can be paid into the Order once it is given back: its Stripe payment page is closed first.
    if ((await closeCheckout(c, false)) === "paid") return refuse(409, "A payment for this order has just come in. Reload the page and try again.", "payment_came_in");
    // a re-payment after a won chargeback that is still owed, or that Stripe made and the Order does not count yet, is made
    // or counted first, and so is a part's payout Stripe made whose answer was lost: what goes back, and what the history says
    // went back, is then what the Order really holds (check of 6 November: the client got back the freelancer's re-paid money;
    // check of 7 November: the history said 100.00 went back where 40.00 did)
    c = await countFirst(c);
    // what a won chargeback pulled back from the freelancer and is not paid back to them yet stays theirs (it is paid to
    // them once the Order is closed): only the rest goes back to the client (check of 2 November)
    const refund = Math.max(heldCents(c) - await owedBack(c), 0);
    const now = new Date().toISOString();
    // only while the price and what was paid in are still the ones read above: a payment recorded a moment ago is part of the refund
    // (and while what was paid out and given back is still what the refund was worked out from: a part paid out at this very
    // moment made the history line say 100.00 went back where 40.00 did; check of 7 November)
    const rows = await db.update("contracts", `id=eq.${c.id}&status=in.(funded,delivered)&${moneyUnchanged(c)}&${same("released_cents", c.released_cents)}&${same("refunded_cents", c.refunded_cents)}`, { status: "resolving", resolution: "refund", split_editor_cents: 0, refund_cents: refund, resolved_by: me.id, resolved_at: now, auto_release_at: null });
    row = rows && rows[0] || null;
    if (!row) return refuse(409, "The order changed a moment ago. Reload the page and try again.", "order_changed");
    await db.update("order_milestones", `order_id=eq.${c.id}&status=in.(pending,submitted)`, { auto_release_at: null }).catch(() => {});
    await orderEvent(row, "cancelled", { by: "freelancer", refund_cents: refund, note: typeof note === "string" ? cut(note, 500) : "" }, me.id);
  }
  const u = await settle(row, me.id, "cancel_refund");
  // (what went back: the settlement's own amount, which it lowers when the Order holds less than was worked out)
  return json(200, { ok: true, status: u && u.status, refunded: Number((u || row).refund_cents) || 0 });
});
