// POST { contract_id, decision, editor_percent, note } — admin only. Hardened copy.
// Decides a dispute (release / refund / split), and can take over a release that got stuck before any
// transfer was made (freelancer's account closed, for example) so the client is not left waiting for ever.
import { escrowEnabled, db, userFromRequest, json, bad, settle, readJson, safe, limitTries, heldCents, chargebackOpen, transfersOf, lockOrder, cut, closeCheckout, moneyUnchanged, recordDecision, dropDecision, announceDecision } from "../lib/cuvori.mjs";

export default safe(async (req) => {
  if (req.method !== "POST") return bad("Method not allowed", 405);
  if (!escrowEnabled()) return bad("Escrow payments are not configured yet", 503);
  const me = await userFromRequest(req);
  if (!me || !me.is_admin || me.banned) return bad("Admins only", 403);
  await limitTries(me, "pay_resolve", 10, 200);   // at most about 10 tries a minute and 200 a day (admins decide many disputes in a busy day)
  const body = await readJson(req);
  const decision = body.decision;
  if (!["release", "refund", "split"].includes(decision)) return bad("decision must be release, refund or split");
  const note = typeof body.note === "string" ? cut(body.note, 2000) : "";
  const c = await db.contract(body.contract_id);
  if (!c) return bad("Not found", 404);
  if (c.payment_mode !== "escrow") return bad("This order is not holding money", 409);
  if (chargebackOpen(c)) return json(409, { error: "A card chargeback is open on this payment. Nothing can move until the bank decides.", code: "chargeback_open" });
  const total = heldCents(c);                                            // what is still held: released milestones stay released
  if (!total) return bad("This order is not holding money", 409);

  // The decision is on record before anything changes (who decided, whose claim the Order holds, what, the written reason):
  // one that can't be saved changes nothing, and the admin is asked to try again. Both sides are told it once its money
  // has moved (announceDecision): by this request, the admin's try again, or the hourly run when the money step stopped at
  // Stripe. A decision that can't be carried out is told to nobody. (check of 26 November: told only here, the hourly run
  // finished a stopped one in silence; check of 27 November: saved only after the Order was claimed for it, a decision
  // the admin was told "nothing has moved" about was carried out by the hourly job within the hour, told to nobody; and
  // told before its money moved, it was told also when it could never be carried out)
  // The chat message and the mark come from the admin: the one who decided, or the admin finishing a freelancer's cancel
  // that stopped (check of 27 November: that note went out as the freelancer's).
  const disputed = !!c.disputed_at || c.status === "disputed";
  let row;
  if (c.status === "resolving") {                                        // resume: the recorded decision wins
    if (c.resolution !== decision) return bad(`A '${c.resolution}' decision is already in progress for this order`, 409);
    row = c;
    const by = row.resolved_by || me.id;
    await recordDecision(row, { actor: [c.editor, c.client].includes(by) ? me.id : by, by }, note, disputed, true);
  } else {
    // Nothing can be paid into the Order once it is decided: its Stripe payment page is closed first.
    if ((await closeCheckout(c, false)) === "paid") return bad("A payment for this order has just come in. Reload the page and decide again.", 409);
    let editorCents;
    if (decision === "release") editorCents = total;
    else if (decision === "refund") editorCents = 0;
    else {
      const p = typeof body.editor_percent === "number" ? body.editor_percent : NaN;
      if (!Number.isFinite(p) || p <= 0 || p >= 100) return bad("editor_percent must be a number between 0 and 100 (exclusive) for a split");
      editorCents = Math.round(total * p / 100);
    }
    const refundCents = total - editorCents;
    const now = new Date().toISOString();
    const from = ["funded", "delivered", "disputed"];
    // saved before the Order is claimed for it; its record goes again when the claim does not go through
    await recordDecision({ id: c.id, resolution: decision, resolved_at: now }, { actor: me.id, by: me.id }, note, disputed);
    let claimed = false, unsure = false;
    try {
      // under the order lock: a release that is being finished right now (the client's retry, the hourly job) cannot
      // land its transfer between this check and the claim
      const unlock = await lockOrder(c.id);
      try {
        // a release that never got its transfer (no id, none at the provider) can be taken over
        if (c.status === "releasing" && !c.stripe_transfer_id) {
          const made = (await transfersOf(c)).filter(t => !t.reversed && !(t.metadata.milestone_id || ""));
          if (made.length) return bad("A transfer for this order already exists at the provider; let the release finish (it is retried every hour)", 409);
          from.push("releasing");
        }
        // a fresh decision: ids left by an interrupted earlier settlement must not make this one skip a move (what they
        // moved is already in the counters; the provider is asked before any transfer or refund is made anyway)
        // only while the price and what was paid in are still the ones the decision was worked out from. The Order's note
        // is left as it is: a stopped step's note goes once the settlement goes through, any other note stays until the
        // admin marks it as handled (a decision does not sort out, say, a top-up that may not be recorded).
        unsure = true;                                                    // a claim whose answer is lost may have gone through
        const rows = await db.update("contracts", `id=eq.${c.id}&status=in.(${from.join(",")})&${moneyUnchanged(c)}`, { status: "resolving", resolution: decision, split_editor_cents: editorCents, refund_cents: refundCents, resolved_by: me.id, resolved_at: now, auto_release_at: null, stripe_transfer_id: null, stripe_refund_id: null });
        unsure = false;
        row = rows && rows[0] || null;
      } finally { await unlock(); }
      if (!row) return bad("The order changed a moment ago. Reload the page and decide again.", 409);
      claimed = true;
    } finally { if (!claimed && !unsure) await dropDecision(c.id, now); }   // surely not claimed: the decision's record goes
  }
  const u = await settle(row, me.id, `resolved_${decision}`);
  // carried out: told now (a database that does not answer leaves it to the hourly run)
  await announceDecision({ ...c, ...row }).catch(e => console.error("decision not told yet; the hourly run tells it", c.id, e && e.message));
  return json(200, { ok: true, status: u && u.status, editorCents: row.split_editor_cents, refundCents: row.refund_cents });
});
