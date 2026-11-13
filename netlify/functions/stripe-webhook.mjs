// Stripe → Cuvori. Hardened copy.
// Platform endpoint events: checkout.session.completed, checkout.session.async_payment_succeeded,
//   charge.refunded, charge.dispute.created, charge.dispute.funds_withdrawn, charge.dispute.closed, charge.refund.updated
//   (refund.updated, refund.failed on newer API versions). Connect endpoint
//   (separate secret): account.updated.
import { verifyWebhook, db, json, bad, stripe, isAcct, WEBHOOK_SECRET, applyPaidSession, contractByPi, onDisputeCreated, onDisputeClosed, lockOrder, acctCols, accountReady, CONNECT_WEBHOOK_SECRET, isPlan2, mirrorOutsideRefundV2, recordFailedRefund, mirrorOutsideRefund } from "../lib/cuvori.mjs";
// the events Cuvori acts on (the first six from Cuvori's own Stripe account, account.updated from the freelancers' accounts)
// (a refund that fails at Stripe after it was recorded: "charge.refund.updated" on the API version Cuvori uses, and the newer
// "refund.updated" / "refund.failed")
const HANDLED = ["checkout.session.completed", "checkout.session.async_payment_succeeded", "charge.refunded", "charge.dispute.created", "charge.dispute.funds_withdrawn", "charge.dispute.closed", "account.updated",
  "charge.refund.updated", "refund.updated", "refund.failed"];

export default async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  const raw = await req.text();
  const sig = req.headers.get("stripe-signature");
  const CONNECT_SECRET = CONNECT_WEBHOOK_SECRET;
  let event = null, fromConnect = false;
  try { event = verifyWebhook(raw, sig, WEBHOOK_SECRET); } catch {}
  if (!event && CONNECT_SECRET) { try { event = verifyWebhook(raw, sig, CONNECT_SECRET); fromConnect = true; } catch {} }
    if (!event) return bad("Invalid signature", 400);

  // Cuvori reads Stripe's classic "Snapshot" events: the object the event is about travels inside it (data.object). A
  // "Thin" event (Stripe's newer format, offered when an event destination is created) carries only a reference, and an
  // event Cuvori handles cannot be acted on without its object. Such an event is refused, never answered "received": Stripe
  // then shows it as failed in Workbench and sends it again, so nothing is lost while the destination is set up again with
  // Snapshot (SETUP.md, Part 5 step 4). Events Cuvori does not handle stay "received", so an extra one never fails the endpoint.
  // Stripe's own "is this destination ready?" test (a ping) carries nothing to record: it is answered so the test passes
  if (event.type === "v2.core.event_destination.ping") return json(200, { received: true, ping: true });
  const obj = event.data && event.data.object;
  const thin = event.object === "v2.core.event" || /^v\d+\./.test(String(event.type || "")) || (!!event.related_object && !event.data);
  const unreadable = HANDLED.includes(event.type) && !(obj && typeof obj === "object" && !Array.isArray(obj) && typeof obj.id === "string" && obj.id);
  if (thin || unreadable) {
    console.error("webhook event Cuvori cannot read", event.id, event.type, thin ? "(a Thin event: the Stripe event destination must send Snapshot events)" : "(no object inside it: Snapshot events carry it)");
    return bad("Cuvori reads Snapshot events only, and this event does not carry the object it is about. Set the Stripe event destination's payload style to Snapshot.", 400);
  }

  try {
    const o = event.data && event.data.object || {};
    if (!fromConnect && (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded")) {
      const r = await applyPaidSession(o);
      if (r === "pending") return bad("Still being recorded by another request; send again", 500);   // Stripe retries later; by then it is recorded, or taken over
    } else if (event.type === "account.updated") {
      if (!isAcct(o.id)) return json(200, { ignored: true });
      const a = await stripe("GET", `/accounts/${o.id}`);                  // current state, not the (possibly stale / replayed) payload
      const enabled = accountReady(a);                                      // the one rule, the same as Fund, releases and Payout details use
      const col = acctCols();                                               // the saved account of this Stripe mode; the other mode's is never touched
      await db.update("payout_details", `${col.id}=eq.${a.id}`, { [col.ready]: enabled });
    } else if (!fromConnect && event.type === "charge.dispute.created") {
      await onDisputeCreated(o);
    } else if (!fromConnect && event.type === "charge.dispute.funds_withdrawn") {
      // Stripe took the money for a chargeback: also how the bank's inquiry shows when it becomes a chargeback (the same
      // dispute, no new "created" notice). Recorded like a new chargeback; one already recorded is not counted twice.
      await onDisputeCreated(o);
    } else if (!fromConnect && event.type === "charge.dispute.closed") {
      await onDisputeClosed(o);
    } else if (!fromConnect && ["charge.refund.updated", "refund.updated", "refund.failed"].includes(event.type)) {
      // a refund that failed (or was canceled) at Stripe after it was recorded: the money is back at Cuvori
      if (o.object === "refund" && ["failed", "canceled"].includes(o.status)) await recordFailedRefund(o);
    } else if (!fromConnect && event.type === "charge.refunded") {
      // A refund made in the Stripe dashboard (not by Cuvori) must be mirrored. Cuvori's own refunds carry the
      // order id (or a reason) in their metadata and are already dealt with, so they are filtered out here —
      // this event fires for those too, and again for every further refund on the same payment.
      const c0 = await contractByPi(o.payment_intent);
      if (c0 && o.amount_refunded > 0) {
        const unlock = await lockOrder(c0.id);                              // never while a release or settlement is moving this Order's money
        // (an Order at the new prices: one line per refund, each with its own Stripe id and entry key, mirrorOutsideRefundV2)
        try { const cur = (await db.contract(c0.id)) || c0; await (isPlan2(cur) ? mirrorOutsideRefundV2(cur, o) : mirrorOutsideRefund(cur, o)); } finally { await unlock(); }
      }
    }
  } catch (e) {
    console.error("webhook handler", event.id, e && e.stack || e);
    return bad("Handler error", 500);                                       // Stripe retries
  }
  return json(200, { received: true });
};
