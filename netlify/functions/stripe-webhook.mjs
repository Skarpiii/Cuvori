// Stripe → Cuvori. Hardened copy.
// Platform endpoint events: checkout.session.completed, checkout.session.async_payment_succeeded,
//   charge.refunded, charge.dispute.created, charge.dispute.closed. Connect endpoint (separate secret): account.updated.
import { verifyWebhook, db, orderEvent, json, bad, stripe, isAcct, WEBHOOK_SECRET, applyPaidSession, contractByPi, onDisputeCreated, onDisputeClosed, heldCents, HOLDING, centsOf, lockOrder } from "../lib/cuvori.mjs";
const nz = (v) => (Number.isInteger(v) && v > 0 ? v : 0);

export default async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  const raw = await req.text();
  const sig = req.headers.get("stripe-signature");
  const CONNECT_SECRET = process.env.STRIPE_CONNECT_WEBHOOK_SECRET || "";
  let event = null, fromConnect = false;
  try { event = verifyWebhook(raw, sig, WEBHOOK_SECRET); } catch {}
  if (!event && CONNECT_SECRET) { try { event = verifyWebhook(raw, sig, CONNECT_SECRET); fromConnect = true; } catch {} }
    if (!event) return bad("Invalid signature", 400);

  try {
    const o = event.data && event.data.object || {};
    if (!fromConnect && (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded")) {
      const r = await applyPaidSession(o);
      if (r === "pending") return bad("Still being recorded by another request; send again", 500);   // Stripe retries later; by then it is recorded, or taken over
    } else if (event.type === "account.updated") {
      if (!isAcct(o.id)) return json(200, { ignored: true });
      const a = await stripe("GET", `/accounts/${o.id}`);                  // current state, not the (possibly stale / replayed) payload
      const enabled = !!(a.payouts_enabled && a.charges_enabled);
      await db.update("payout_details", `stripe_account_id=eq.${a.id}`, { stripe_payouts_enabled: enabled });
    } else if (!fromConnect && event.type === "charge.dispute.created") {
      await onDisputeCreated(o);
    } else if (!fromConnect && event.type === "charge.dispute.closed") {
      await onDisputeClosed(o);
    } else if (!fromConnect && event.type === "charge.refunded") {
      // A refund made in the Stripe dashboard (not by Cuvori) must be mirrored. Cuvori's own refunds carry the
      // order id (or a reason) in their metadata and are already dealt with, so they are filtered out here —
      // this event fires for those too, and again for every further refund on the same payment.
      const c0 = await contractByPi(o.payment_intent);
      if (c0 && o.amount_refunded > 0) {
        const unlock = await lockOrder(c0.id);                              // never while a release or settlement is moving this Order's money
        try { await mirrorOutsideRefund((await db.contract(c0.id)) || c0, o); } finally { await unlock(); }
      }
    }
  } catch (e) {
    console.error("webhook handler", event.id, e && e.stack || e);
    return bad("Handler error", 500);                                       // Stripe retries
  }
  return json(200, { received: true });
};

// A refund made in the Stripe dashboard, mirrored into the books (called under the order lock, with a fresh row).
async function mirrorOutsideRefund(c, o) {
  const list = await stripe("GET", "/refunds", { payment_intent: o.payment_intent, limit: 100 });
  const listed = (list.data || []).filter(r => r.status !== "failed" && r.status !== "canceled");
  const outside = listed.length ? listed.filter(r => !(r.metadata && (r.metadata.contract_id || r.metadata.reason))) : [{ id: o.id, amount: o.amount_refunded }];   // no list: trust the event
  const cents = Math.min(outside.reduce((a, r) => a + r.amount, 0), o.amount_refunded);
  if (cents <= 0) return;
  const funds = (await db.select("order_payments", `order_id=eq.${c.id}&kind=eq.fund&status=eq.succeeded&select=provider_ref,amount_cents`)) || [];
  const thisFund = funds.find(f => f.provider_ref === o.payment_intent);
  const orderMoney = Math.min(cents, thisFund ? thisFund.amount_cents : (nz(c.funded_cents) || centsOf(c) || cents));   // the Order money in it (the rest was the processing fee)
  // what earlier events for this payment already mirrored (rows from before this version carry the charge id in provider_ref)
  const mirroredRows = [...((await db.select("order_payments", `order_id=eq.${c.id}&kind=eq.refund&note=eq.dashboard_refund&charge_ref=eq.${encodeURIComponent(o.id)}&select=amount_cents`)) || []),
                        ...((await db.select("order_payments", `order_id=eq.${c.id}&kind=eq.refund&note=eq.dashboard_refund&charge_ref=is.null&provider_ref=eq.${encodeURIComponent(o.id)}&select=amount_cents`)) || [])];
  const mirrored = mirroredRows.reduce((a, r) => a + r.amount_cents, 0);
  const part = Math.max(orderMoney - mirrored, 0);                                     // new since the last event for this payment
  if (part <= 0) return;
  const onlyPayment = funds.length <= 1 && (c.stripe_payment_intent === o.payment_intent || !!thisFund);
  const now = new Date().toISOString(), refs = outside.map(r => r.id).join(",").slice(0, 200), held = heldCents(c);
  if (onlyPayment && o.refunded) {
    // the one payment behind this order is back with the client in full: the order is refunded, whatever was still held is gone
    const twice = Math.max(part - held, 0);                                            // already paid to the freelancer as well: money went out twice
    const u = await db.claim(c.id, HOLDING, { status: "refunded", closed_at: now, resolution: "refund", auto_release_at: null, refunded_cents: nz(c.refunded_cents) + held,
      money_error: twice > 0 ? `refund made outside Cuvori: ${(twice / 100).toFixed(2)} had already been paid to the freelancer — check by hand` : null });
    if (u) {
      await db.insert("order_payments", { order_id: c.id, kind: "refund", amount_cents: part, provider: "stripe", provider_ref: refs, charge_ref: o.id, status: "succeeded", note: "dashboard_refund" }).catch(() => {});
      await orderEvent(u, "refunded", { outside: true, amount_cents: o.amount_refunded }, null);
      return;
    }
  }
  // part of a payment, one payment of several (a top-up), or an order no longer holding: the order now has less
  // than it shows, or money went out twice. A person decides; the books take the loss now.
  const bump = Math.min(part, held);                                                   // the counters never claim more than was held
  const why = `Refund of ${(cents / 100).toFixed(2)} ${String(o.currency || c.currency || "").toUpperCase()} made outside Cuvori on payment ${o.payment_intent}; the order holds ${(bump / 100).toFixed(2)} less than before${part > bump ? `; ${((part - bump) / 100).toFixed(2)} of it had already been paid out — money went out twice` : ""}`;
  let u = await db.claim(c.id, ["funded", "delivered"], { status: "disputed", dispute_reason: why.slice(0, 2000), disputed_at: now, dispute_by: c.client, auto_release_at: null, money_error: why.slice(0, 300), refunded_cents: nz(c.refunded_cents) + bump })
    || (await db.update("contracts", `id=eq.${c.id}`, { money_error: why.slice(0, 300), refunded_cents: nz(c.refunded_cents) + bump }))[0];
  await db.insert("order_payments", { order_id: c.id, kind: "refund", amount_cents: part, provider: "stripe", provider_ref: refs, charge_ref: o.id, status: "succeeded", note: "dashboard_refund" }).catch(() => {});
  await orderEvent(u || c, "disputed", { outside_refund: true, amount_cents: part, note: "Refund made outside Cuvori — Cuvori checks this by hand" }, null);
  // nothing held any more (every payment went back from the dashboard): the order is refunded, not stuck in a dispute nobody can decide
  if (u && HOLDING.includes(u.status) && heldCents(u) === 0) {
    const v = await db.claim(c.id, HOLDING, { status: "refunded", closed_at: now, resolved_at: now, resolution: "refund", auto_release_at: null });
    if (v) await orderEvent(v, "refunded", { outside: true, amount_cents: nz(v.refunded_cents) }, null);
  }
}
