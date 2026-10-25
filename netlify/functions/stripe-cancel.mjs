// POST { contract_id } (freelancer) — give a funded Order back: everything still held goes back to the
// client. A client who wants out after funding asks the freelancer (or opens a dispute); money never
// moves on one side's say-so in the other direction.
import { escrowEnabled, db, userFromRequest, json, bad, refuse, settle, readJson, safe, limitTries, heldCents, orderEvent, chargebackOpen, cut, closeCheckout, moneyUnchanged } from "../lib/cuvori.mjs";

export default safe(async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  if (!escrowEnabled()) return refuse(503, "Protected payments are not configured yet", "payments_paused");
  const me = await userFromRequest(req);
  if (!me) return refuse(401, "Sign in first", "signed_out");
  if (me.banned) return refuse(403, "Account suspended", "account_suspended");
  await limitTries(me, "pay_cancel");          // at most about 10 tries a minute and 50 a day: nobody can use up Stripe's limits for everyone
  const { contract_id: id, note } = await readJson(req);
  const c = await db.contract(id);
  if (!c || c.editor !== me.id) return refuse(403, "Not your order", "not_your_order");
  if (c.payment_mode !== "escrow") return refuse(409, "This order is not holding money", "cannot_cancel");
  const held = heldCents(c);
  if (!held) return refuse(409, "This order is not holding money", "cannot_cancel");
  if (chargebackOpen(c)) return json(409, { error: "A card chargeback is open on this payment. Nothing can move until the bank decides.", code: "chargeback_open" });
  let row = c.status === "resolving" && c.resolution === "refund" && c.resolved_by === me.id ? c : null;   // resume
  if (!row) {
    if (!["funded", "delivered"].includes(c.status)) return refuse(409, "This order cannot be cancelled right now", "cannot_cancel");
    // Nothing can be paid into the Order once it is given back: its Stripe payment page is closed first.
    if ((await closeCheckout(c, false)) === "paid") return refuse(409, "A payment for this order has just come in. Reload the page and try again.", "payment_came_in");
    const now = new Date().toISOString();
    // only while the price and what was paid in are still the ones read above: a payment recorded a moment ago is part of the refund
    const rows = await db.update("contracts", `id=eq.${c.id}&status=in.(funded,delivered)&${moneyUnchanged(c)}`, { status: "resolving", resolution: "refund", split_editor_cents: 0, refund_cents: held, resolved_by: me.id, resolved_at: now, auto_release_at: null });
    row = rows && rows[0] || null;
    if (!row) return refuse(409, "The order changed a moment ago. Reload the page and try again.", "order_changed");
    await db.update("order_milestones", `order_id=eq.${c.id}&status=in.(pending,submitted)`, { auto_release_at: null }).catch(() => {});
    await orderEvent(row, "cancelled", { by: "freelancer", refund_cents: held, note: typeof note === "string" ? cut(note, 500) : "" }, me.id);
  }
  const u = await settle(row, me.id, "cancel_refund");
  return json(200, { ok: true, status: u && u.status, refunded: held });
});
