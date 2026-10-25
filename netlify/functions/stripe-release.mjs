// POST { contract_id, milestone_id? } (client) — "Approve & release". Whole Order, or one milestone.
import { escrowEnabled, db, userFromRequest, json, bad, refuse, settle, releaseMilestone, readJson, safe, isBanned, limitTries, heldCents, owedCents, closeCheckout, moneyUnchanged, MIN_TOPUP_CENTS, orderPayoutAccount, accountReady, chargebackOpen } from "../lib/cuvori.mjs";

export default safe(async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  if (!escrowEnabled()) return refuse(503, "Protected payments are not configured yet", "payments_paused");
  const me = await userFromRequest(req);
  if (!me) return refuse(401, "Sign in first", "signed_out");
  if (me.banned) return refuse(403, "Account suspended", "account_suspended");
  await limitTries(me, "pay_release");        // at most about 10 tries a minute and 50 a day: nobody can use up Stripe's limits for everyone
  const { contract_id: id, milestone_id } = await readJson(req);
  const c = await db.contract(id);
  if (!c || c.client !== me.id) return refuse(403, "Not your order", "not_your_order");
  if (c.payment_mode !== "escrow") return refuse(409, "Nothing to release right now", "nothing_to_release");
  if (chargebackOpen(c)) return json(409, { error: "A card chargeback is open on this payment. Nothing can move until the bank decides.", code: "chargeback_open" });
  if (await isBanned(c.editor)) return refuse(409, "This order is under review by Cuvori", "under_review");

  if (milestone_id) {
    if (!["funded", "delivered"].includes(c.status)) return refuse(409, "Nothing to release right now", "nothing_to_release");
    const m = await db.milestone(milestone_id);
    if (!m || m.order_id !== c.id) return refuse(403, "Not your milestone", "milestone_changed");
    const acct = await orderPayoutAccount(c);
    if (!accountReady(acct)) return json(409, { error: "The freelancer's Stripe account is not ready yet", code: "freelancer_not_ready" });
    const transfer = await releaseMilestone(c, m, me.id, "approve");
    return json(200, { ok: true, transfer, released: m.amount_cents });
  }

  if (c.has_milestones) return refuse(409, "This order is released milestone by milestone", "by_milestone");
  const resume = c.status === "releasing" && c.resolution === "release";               // resume an interrupted release
  // the state first: Release on an Order that is already closed (a second tab, a second click) is told there is nothing
  // to release, never "amount missing", which would sound as if money were lost
  if (!resume && !["funded", "delivered"].includes(c.status)) return refuse(409, "Nothing to release right now", "nothing_to_release");
  const cents = heldCents(c);
  if (!cents) return refuse(409, "Order amount missing", "nothing_to_release");
  let row = resume ? c : null;
  if (!row) {
    // A price increase both sides accepted is paid in before the client can approve and close the Order: once it is
    // closed, the increase can never be paid through Cuvori. If something is wrong, a dispute is the way. An increase
    // under the €0.50 top-up minimum (only on Orders from before the database refused them) can never be charged, so it
    // does not block the release.
    if (owedCents(c) >= MIN_TOPUP_CENTS) return refuse(409, "The price increase you agreed to is not paid yet. Fund it first, then release the payment. If something is wrong, open a dispute.", "topup_unpaid");
    const acct = await orderPayoutAccount(c);
    if (!accountReady(acct)) return json(409, { error: "The freelancer's Stripe account is not ready yet", code: "freelancer_not_ready" });
    // Nothing can be paid into the Order once it is closed: its Stripe payment page is closed first.
    if ((await closeCheckout(c)) === "paid") return refuse(409, "A payment for this order has just come in. Reload the page and try again.", "payment_came_in");
    const now = new Date().toISOString();
    // Only while the price and what was paid in are still the ones checked above: an increase accepted or a payment
    // recorded a moment ago would otherwise be left out of the release.
    const rows = await db.update("contracts", `id=eq.${c.id}&status=in.(funded,delivered)&${moneyUnchanged(c)}`, { status: "releasing", resolution: "release", split_editor_cents: cents, refund_cents: 0, resolved_by: me.id, resolved_at: now, auto_release_at: null });
    row = rows && rows[0] || null;
    if (!row) return refuse(409, "The order changed a moment ago. Reload the page and try again.", "order_changed");
  }
  const u = await settle(row, me.id, "approve");
  return json(200, { ok: true, transfer: u && u.stripe_transfer_id, released: cents });
});
