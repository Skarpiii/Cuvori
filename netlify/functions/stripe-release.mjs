// POST { contract_id, milestone_id? } (client) — "Approve & release". Whole Order, or one milestone.
import { escrowEnabled, db, userFromRequest, json, bad, settle, releaseMilestone, readJson, safe, isBanned, heldCents, owedCents, closeCheckout, moneyUnchanged, MIN_TOPUP_CENTS, payoutAccount, accountReady, chargebackOpen } from "../lib/cuvori.mjs";

export default safe(async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  if (!escrowEnabled()) return bad("Protected payments are not configured yet", 503);
  const me = await userFromRequest(req);
  if (!me) return bad("Sign in first", 401);
  if (me.banned) return bad("Account suspended", 403);
  const { contract_id: id, milestone_id } = await readJson(req);
  const c = await db.contract(id);
  if (!c || c.client !== me.id) return bad("Not your order", 403);
  if (c.payment_mode !== "escrow") return bad("Nothing to release right now", 409);
  if (chargebackOpen(c)) return bad("A card chargeback is open on this payment. Nothing can move until the bank decides.", 409);
  if (await isBanned(c.editor)) return bad("This order is under review by Cuvori", 409);

  if (milestone_id) {
    if (!["funded", "delivered"].includes(c.status)) return bad("Nothing to release right now", 409);
    const m = await db.milestone(milestone_id);
    if (!m || m.order_id !== c.id) return bad("Not your milestone", 403);
    const acct = await payoutAccount(c.editor);
    if (!accountReady(acct)) return bad("The freelancer's Stripe account is not ready yet", 409);
    const transfer = await releaseMilestone(c, m, me.id, "approve");
    return json(200, { ok: true, transfer, released: m.amount_cents });
  }

  if (c.has_milestones) return bad("This order is released milestone by milestone", 409);
  const cents = heldCents(c);
  if (!cents) return bad("Order amount missing", 409);
  let row = c.status === "releasing" && c.resolution === "release" ? c : null;          // resume an interrupted release
  if (!row) {
    if (!["funded", "delivered"].includes(c.status)) return bad("Nothing to release right now", 409);
    // A price increase both sides accepted is paid in before the client can approve and close the Order: once it is
    // closed, the increase can never be paid through Cuvori. If something is wrong, a dispute is the way. An increase
    // under the €0.50 top-up minimum (only on Orders from before the database refused them) can never be charged, so it
    // does not block the release.
    if (owedCents(c) >= MIN_TOPUP_CENTS) return bad("The price increase you agreed to is not paid yet. Fund it first, then release the payment. If something is wrong, open a dispute.", 409);
    const acct = await payoutAccount(c.editor);
    if (!accountReady(acct)) return bad("The freelancer's Stripe account is not ready yet", 409);
    // Nothing can be paid into the Order once it is closed: its Stripe payment page is closed first.
    if ((await closeCheckout(c)) === "paid") return bad("A payment for this order has just come in. Reload the page and try again.", 409);
    const now = new Date().toISOString();
    // Only while the price and what was paid in are still the ones checked above: an increase accepted or a payment
    // recorded a moment ago would otherwise be left out of the release.
    const rows = await db.update("contracts", `id=eq.${c.id}&status=in.(funded,delivered)&${moneyUnchanged(c)}`, { status: "releasing", resolution: "release", split_editor_cents: cents, refund_cents: 0, resolved_by: me.id, resolved_at: now, auto_release_at: null });
    row = rows && rows[0] || null;
    if (!row) return bad("The order changed a moment ago. Reload the page and try again.", 409);
  }
  const u = await settle(row, me.id, "approve");
  return json(200, { ok: true, transfer: u && u.stripe_transfer_id, released: cents });
});
