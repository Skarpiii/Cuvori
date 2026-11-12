// Stripe → Cuvori. Hardened copy.
// Platform endpoint events: checkout.session.completed, checkout.session.async_payment_succeeded,
//   charge.refunded, charge.dispute.created, charge.dispute.funds_withdrawn, charge.dispute.closed, charge.refund.updated
//   (refund.updated, refund.failed on newer API versions). Connect endpoint
//   (separate secret): account.updated.
import { verifyWebhook, db, orderEvent, json, bad, stripe, isAcct, WEBHOOK_SECRET, applyPaidSession, contractByPi, onDisputeCreated, onDisputeClosed, heldCents, HOLDING, centsOf, lockOrder, acctCols, accountReady, CONNECT_WEBHOOK_SECRET, addNote, stepsOver, isPlan2, mirrorOutsideRefundV2, recordFailedRefund, failedBackOf, failedRefundsFirst, updateNoted } from "../lib/cuvori.mjs";
const nz = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
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

// A refund made in the Stripe dashboard, mirrored into the books (called under the order lock, with a fresh row).
async function mirrorOutsideRefund(c, o) {
  const list = await stripe("GET", "/refunds", { payment_intent: o.payment_intent, limit: 100 });
  // Stripe's list is what counts. Only when it lists no refund at all is the event trusted; refunds it lists as failed or
  // cancelled are nothing to mirror (check of 7 November: the notice of Cuvori's own card-fee refund, delivered after that
  // refund had failed, was counted as a refund made in the dashboard, and the Order went into a dispute over 1.86)
  const all = (list.data || []).filter(r => r && r.id);
  // a refund Stripe lists as failed whose "failed" notice Cuvori has not handled yet is handled first (check of 8 November:
  // made again before that notice, the refund was counted twice until it came; on a database without v56 for good)
  c = await failedRefundsFirst(c, all, o.payment_intent);
  const listed = all.filter(r => r.status !== "failed" && r.status !== "canceled");
  const outside = all.length ? listed.filter(r => !(r.metadata && (r.metadata.contract_id || r.metadata.reason))) : [{ id: o.id, amount: o.amount_refunded }];   // no list: trust the event
  const cents = Math.min(outside.reduce((a, r) => a + r.amount, 0), o.amount_refunded);
  if (cents <= 0) return;
  const funds = (await db.select("order_payments", `order_id=eq.${c.id}&kind=eq.fund&status=eq.succeeded&select=provider_ref,amount_cents`)) || [];
  const thisFund = funds.find(f => f.provider_ref === o.payment_intent);
  const orderMoney = Math.min(cents, thisFund ? thisFund.amount_cents : (nz(c.funded_cents) || centsOf(c) || cents));   // the Order money in it (the rest was the processing fee)
  // what earlier events for this payment already put in the books: their lines (rows from before this version carry the
  // charge id in provider_ref). The lines are written FIRST and are what says a refund is in the books: when the counter
  // was raised first, a lost answer or a line that failed to save made the next event for the payment count the same
  // refund again, and the client's later refund came up short by that much (check of 1 November).
  const DASH_NOTES = "note=in.(dashboard_refund,dashboard_refund_paid_out)";
  const mirroredRows = [...((await db.select("order_payments", `order_id=eq.${c.id}&kind=eq.refund&${DASH_NOTES}&charge_ref=eq.${encodeURIComponent(o.id)}&select=kind,amount_cents,provider_ref`)) || []),
                        ...((await db.select("order_payments", `order_id=eq.${c.id}&kind=eq.refund&note=eq.dashboard_refund&charge_ref=is.null&provider_ref=eq.${encodeURIComponent(o.id)}&select=kind,amount_cents,provider_ref`)) || [])];
  // a refund among them that failed at Stripe afterwards was taken off the books again (its refund_failed line): it is no
  // longer in the books, so the refund made again in its place is new (check of 7 November: following the Order's note,
  // the admin refunded 40.00 again in the dashboard; it was taken for the failed one, never counted, and the freelancer was
  // then paid the client's 40.00 as well). Only one taken off: on a database without v56 it stays counted (no such line),
  // and the refund made again in its place is that same money (check of 8 November)
  const failedRows = (await db.select("order_payments", `order_id=eq.${c.id}&kind=eq.refund_failed&status=eq.succeeded&select=kind,amount_cents,provider_ref`)) || [];
  const mirrored = Math.max(mirroredRows.reduce((a, r) => a + r.amount_cents, 0) - failedBackOf([...mirroredRows.map(r => ({ ...r, note: null })), ...failedRows]), 0);
  const part = Math.max(orderMoney - mirrored, 0);                                     // new since the last event for this payment
  const now = new Date().toISOString(), refs = outside.map(r => r.id).join(",").slice(0, 200), held = heldCents(c);
  const bump = Math.min(part, held);                                                   // the counters never claim more than was held
  const twice = part - bump;                                                           // already paid to the freelancer as well: money went out twice
  if (part > 0) {
    // 1. the lines: the part that was still held, and the part already paid out (its own line: never counted as held money).
    //    A line that can't be saved fails this event, so Stripe sends it again and nothing is counted on a guess.
    const base = { order_id: c.id, kind: "refund", provider: "stripe", provider_ref: refs, charge_ref: o.id, status: "succeeded" };
    if (bump > 0) await db.insert("order_payments", { ...base, amount_cents: bump, note: "dashboard_refund" });
    if (twice > 0) await db.insert("order_payments", { ...base, amount_cents: twice, note: "dashboard_refund_paid_out" });
  }
  // 2. the counter follows the lines: what they show given back that the Order doesn't count yet (this refund, or one an
  //    earlier event wrote down and broke off before counting). Never more than is held.
  // (a refund that failed at Stripe afterwards came off the total again: its refund_failed line takes it off here too)
  const back = (await db.select("order_payments", `order_id=eq.${c.id}&status=eq.succeeded&kind=in.(refund,chargeback,refund_failed)&select=kind,amount_cents,provider_ref,note`)) || [];
  // (a failed refund comes off only what was counted of it: a part of it already paid out twice, "dashboard_refund_paid_out",
  // never was; check of 7 November, re-check)
  const counts = back.filter(r => r.note !== "dashboard_refund_paid_out");
  const behind = Math.min(Math.max(counts.filter(r => r.kind !== "refund_failed").reduce((a, r) => a + r.amount_cents, 0) - failedBackOf(counts) - nz(c.refunded_cents), 0), held);
  if (part <= 0 && behind <= 0) return;
  // the counter moves only from the value read here (under the Order's lock): a second try never adds it twice
  const sameCounter = c.refunded_cents == null ? "refunded_cents=is.null" : `refunded_cents=eq.${c.refunded_cents}`;
  const onlyPayment = funds.length <= 1 && (c.stripe_payment_intent === o.payment_intent || !!thisFund);
  if (onlyPayment && o.refunded) {
    // the one payment behind this order is back with the client in full: the order is refunded, whatever was still held is gone
    // the Order's money steps are over; money paid out twice is said for the admin, and any other note stays (also one another
    // step saved meanwhile: the note is worked out from the note as it is when written, updateNoted)
    const rows = await updateNoted(c, `id=eq.${c.id}&status=in.(${HOLDING.join(",")})&${sameCounter}`, { status: "refunded", closed_at: now, resolution: "refund", auto_release_at: null, refunded_cents: nz(c.refunded_cents) + behind },
      (n) => twice > 0 ? addNote(stepsOver(n), `refund made outside Cuvori: ${(twice / 100).toFixed(2)} had already been paid to the freelancer — check by hand`) : stepsOver(n));
    const u = rows && rows[0] || null;
    if (u) { await orderEvent(u, "refunded", { outside: true, amount_cents: o.amount_refunded }, null); return; }
  }
  // part of a payment, one payment of several (a top-up), or an order no longer holding: the order now has less
  // than it shows, or money went out twice. A person decides; the books take the loss now.
  const why = `Refund of ${(cents / 100).toFixed(2)} ${String(o.currency || c.currency || "").toUpperCase()} made outside Cuvori on payment ${o.payment_intent}; the order holds ${(behind / 100).toFixed(2)} less than before${twice > 0 ? `; ${(twice / 100).toFixed(2)} of it had already been paid out — money went out twice` : ""}`;
  const note = (n) => addNote(n, why.slice(0, 300));                                   // after the notes already there, never in their place
  let u = ((await updateNoted(c, `id=eq.${c.id}&status=in.(funded,delivered)&${sameCounter}`, { status: "disputed", dispute_reason: why.slice(0, 2000), disputed_at: now, dispute_by: c.client, auto_release_at: null, refunded_cents: nz(c.refunded_cents) + behind }, note)) || [])[0]
    || ((await updateNoted(c, `id=eq.${c.id}&${sameCounter}`, { refunded_cents: nz(c.refunded_cents) + behind }, note)) || [])[0];
  // the counter moved under someone else's hands (it can't under the lock): this event fails, and Stripe sends it again
  if (!u) throw new Error(`refund made outside Cuvori on ${o.payment_intent}: the Order changed while it was counted`);
  await orderEvent(u, "disputed", { outside_refund: true, amount_cents: part || behind, note: "Refund made outside Cuvori — Cuvori checks this by hand" }, null);
  // nothing held any more (every payment went back from the dashboard): the order is refunded, not stuck in a dispute nobody can decide
  if (u && HOLDING.includes(u.status) && heldCents(u) === 0) {
    const v = await db.claim(c.id, HOLDING, { status: "refunded", closed_at: now, resolved_at: now, resolution: "refund", auto_release_at: null });
    if (v) await orderEvent(v, "refunded", { outside: true, amount_cents: nz(v.refunded_cents) }, null);
  }
}
