// POST { contract_id, decision, editor_percent, note } — admin only. Hardened copy.
// Decides a dispute (release / refund / split), and can take over a release that got stuck before any
// transfer was made (freelancer's account closed, for example) so the client is not left waiting for ever.
import { escrowEnabled, db, stripe, userFromRequest, json, bad, settle, readJson, safe, limitTries, heldCents, chargebackOpen, transfersOf, lockOrder, cut, closeCheckout, moneyUnchanged, FEE_REFUND, isPi, isPlan2, fail, owedBack, decisionRecorded, countFirst, freelancerCancel, announceDecision } from "../lib/cuvori.mjs";

// What of a stuck decision has moved at Stripe already (null: nothing). Its own transfer to the freelancer (a whole-order
// transfer tagged with this decision, or an untagged one from older code that the books don't show), and refunds Cuvori
// made on the Order's payments that the books don't show (a refund carries no tag of its decision: any refund of Cuvori's
// at Stripe beyond the refund lines in the ledger can be this decision's).
async function decisionMoved(c) {
  if (c.stripe_transfer_id) return `transfer ${c.stripe_transfer_id}`;
  if (c.stripe_refund_id) return `refund ${c.stripe_refund_id}`;
  const lines = (await db.select("order_payments", `order_id=eq.${c.id}&status=eq.succeeded&kind=in.(release,refund,fund)&select=kind,provider_ref,amount_cents,note`)) || [];
  const attempt = String(c.resolved_at || "");
  const t = (await transfersOf(c)).find(t => !t.reversed && !(t.metadata.milestone_id || "") && (((t.metadata.purpose || "release") === "release"
    && (t.metadata.attempt ? t.metadata.attempt === attempt : !lines.some(l => l.kind === "release" && l.provider_ref === t.id)))
    // under the new prices a decision first pays back what a won chargeback pulled back: such a re-payment is this decision's
    // too while the books don't show it. One they show is the freelancer's money paid back, never part of what the decision
    // divides: what is still held is worked out without it, so another decision can take this one's place (check of 7
    // November: the re-payment kept a stuck 'release' in place for good after the freelancer was banned)
    || (isPlan2(c) && /^retransfer_/.test(t.metadata.purpose || "") && !!attempt && t.metadata.attempt === attempt && !lines.some(l => l.kind === "release" && l.provider_ref === t.id))));
  if (t) return `transfer ${t.id}`;
  const pis = [...new Set([c.stripe_payment_intent, ...lines.filter(l => l.kind === "fund").map(l => l.provider_ref)].filter(isPi))];
  let atStripe = 0;
  for (const pi of pis) atStripe += (((await stripe("GET", "/refunds", { payment_intent: pi, limit: 100 })).data) || [])
    .filter(r => r && r.status !== "failed" && r.status !== "canceled" && r.metadata && (r.metadata.contract_id || r.metadata.reason) && !FEE_REFUND(r) && r.metadata.kind !== "late_payment")
    .reduce((a, r) => a + r.amount, 0);
  // (refunds made in the Stripe dashboard are not Cuvori's: under the new prices their lines read "dashboard_refund" or
  // "dashboard_refund counted <cents>")
  const booked = lines.filter(l => l.kind === "refund" && (isPlan2(c) ? !/^dashboard_refund/.test(l.note || "") : l.note !== "dashboard_refund")).reduce((a, l) => a + l.amount_cents, 0);
  return atStripe > booked ? `a refund of ${atStripe - booked} cents the books don't show yet` : null;
}

// The decision is on record before any money moves, once per decision (its claim time, resolved_at, names it): who decided
// what, the amounts and the written reason, in the Order's history, which nobody can change afterwards (and in the admin
// log, schema v56). A decision that replaces a stuck one names the one it replaced. Saved, or nothing moves: the admin is
// asked to try again, and the retry finds the decision recorded on the Order and saves it then; the hourly run never
// carries out a decision that is not on record (decisionMissing). True when written now.
async function recordDecision(row, actor, d) {
  const attempt = String(row.resolved_at || "");
  const have = ((await db.select("order_events", `order_id=eq.${row.id}&event=eq.decision&select=data`)) || []).some(e => e && e.data && e.data.attempt === attempt);
  if (have) return false;
  // (tell_once: told to both sides once, by whichever step carries it out, announceDecision; a decision without it was made
  // by an older version, which told it in its first try)
  const data = { attempt, decision: row.resolution, editor_cents: row.split_editor_cents, refund_cents: row.refund_cents,
    ...(Number.isFinite(d.percent) ? { editor_percent: d.percent } : {}), note: d.note || "", ...(d.replaced ? { replaced: d.replaced } : {}), tell_once: true };
  try { await db.insert("order_events", { order_id: row.id, actor, event: "decision", data }); }
  catch (e) { console.error("the decision could not be recorded", row.id, e.message); throw fail("The decision could not be recorded yet. Nothing has moved; please try again in a minute.", 503, "provider_down"); }
  await db.insert("admin_audit", { actor, action: "order.decide", target_table: "contracts", target_id: row.id, detail: data }).catch(() => {});   // (the admin log comes with schema v56)
  return true;
}

// a database filter: the column is still what was read (null included)
const same = (col, v) => (v == null ? `${col}=is.null` : `${col}=eq.${Number(v)}`);

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
  let c = await db.contract(body.contract_id);
  if (!c) return bad("Not found", 404);
  // nobody decides about their own money: an Order on which the admin is the client or the freelancer is decided by another admin
  if (c.client === me.id || c.editor === me.id) return bad("You are the client or the freelancer on this Order, so another admin has to decide it.", 403);
  if (c.payment_mode !== "escrow") return bad("This order is not holding money", 409);
  if (chargebackOpen(c)) return json(409, { error: "A card chargeback is open on this payment. Nothing can move until the bank decides.", code: "chargeback_open" });
  // what is still held (released milestones stay released), less what a won chargeback pulled back from the freelancer and
  // is still owed to them: that is theirs, paid to them once the Order is closed, never divided (check of 2 November)
  const total = Math.max(heldCents(c) - await owedBack(c), 0);
  if (!total) return bad("This order is not holding money", 409);
  // An Order in a dispute, or a release or decision that got stuck, is what the admin decides. Any other Order (funded or
  // delivered, nobody disputing) is the two people's own business: deciding it needs a written reason both of them read.
  const stuck = c.status === "resolving" || (c.status === "releasing" && !c.stripe_transfer_id);
  if (c.status !== "disputed" && !stuck && note.trim().length < 10)
    return bad("Nobody has disputed this Order. To decide it anyway, write a note to both sides (at least 10 characters) saying why Cuvori decides it.", 409);

  // A re-payment after a won chargeback that is still owed, or that Stripe made and the Order does not count yet, is made or
  // counted first: the decision's amounts, and what its history line says, are then what really moves (check of 6 November;
  // it only ever lowers what is held by what is the freelancer's already, so the checks above stay right). So is a part's
  // payout Stripe made whose answer was lost (check of 7 November: a 'split' recorded and answered 50.00/50.00 where
  // 20.00/20.00 moved)
  c = await countFirst(c);
  // The freelancer's own cancel whose refund stopped at Stripe: 'refund' finishes it as it is. It is not a decision of
  // Cuvori's, so none is recorded for it (check of 6 November: the history recorded it as Cuvori's decision, made by the
  // freelancer); the admin log says who finished it.
  if (c.status === "resolving" && decision === "refund" && freelancerCancel(c)) {
    await db.insert("admin_audit", { actor: me.id, action: "order.finish_cancel", target_table: "contracts", target_id: c.id, detail: { refund_cents: c.refund_cents, cancelled_by: "freelancer", at: c.resolved_at || null } }).catch(() => {});
    const u = await settle(c, me.id, "cancel_refund");
    // (what moved: the settlement's own amounts, which it lowers when the Order holds less than was worked out)
    return json(200, { ok: true, status: u && u.status, editorCents: Number((u || c).split_editor_cents) || 0, refundCents: Number((u || c).refund_cents) || 0 });
  }
  // resume: the recorded decision wins. A 'split' decided again at another percentage is another decision: it takes the
  // stuck one's place below (only while nothing of it has moved), never carried out with the stuck one's amounts while its
  // history says the new percentage (check of 6 November). The same percentage gives exactly the same amounts: a cent of
  // leeway took 61% for 60% on a 1.00 Order (check of 6 November, second round). A stuck 'split' whose settlement shrank its
  // amounts reads as another one: it is replaced at the same percentage while nothing of it has moved, otherwise refused
  // (the hourly run finishes it).
  const pct0 = typeof body.editor_percent === "number" ? body.editor_percent : NaN;
  const samePct = (x) => { const e = Number(x.split_editor_cents) || 0, all = e + (Number(x.refund_cents) || 0); return Number.isFinite(pct0) && Math.round(all * pct0 / 100) === e; };
  let row;
  if (c.status === "resolving" && c.resolution === decision && (decision !== "split" || samePct(c))) row = c;
  else if (c.status === "resolving") {
    // Another decision in place of one that is stuck (a 'release' or 'split' whose freelancer was banned or whose Stripe
    // account was closed afterwards would otherwise hold the client's money for ever): only while nothing of it has moved.
    // Stripe is asked, not only Cuvori's records, since a transfer or refund whose answer was lost is in neither.
    // The payment page is closed first, before the Order's lock is taken, as for a fresh decision: a payment on it that the
    // Order has not recorded is recorded under that same lock, so closing it while holding the lock waited 5 seconds and
    // failed, and the stuck decision could never be replaced (check of 2 November). What it changed is seen under the lock.
    if ((await closeCheckout(c, false)) === "paid") return bad("A payment for this order has just come in. Reload the page and decide again.", 409);
    const unlock = await lockOrder(c.id);
    try {
      const cur = await db.contract(c.id);
      if (!cur || cur.status !== "resolving" || cur.resolved_at !== c.resolved_at || cur.funded_cents !== c.funded_cents || cur.amount_cents !== c.amount_cents) return bad("The order changed a moment ago. Reload the page and decide again.", 409);
      const moved = await decisionMoved(cur);
      if (moved) return bad(`Part of the '${cur.resolution}' decision has already moved at Stripe (${moved}); it can't be replaced. Let it finish: it is retried every hour.`, 409);
      const held = Math.max(heldCents(cur) - await owedBack(cur), 0);           // (never what is owed back to the freelancer)
      const p = typeof body.editor_percent === "number" ? body.editor_percent : NaN;
      if (decision === "split" && (!Number.isFinite(p) || p <= 0 || p >= 100)) return bad("editor_percent must be a number between 0 and 100 (exclusive) for a split");
      const editorCents = decision === "release" ? held : decision === "refund" ? 0 : Math.round(held * p / 100);
      const rows = await db.update("contracts", `id=eq.${c.id}&status=eq.resolving&${cur.resolved_at ? `resolved_at=eq.${encodeURIComponent(cur.resolved_at)}` : "resolved_at=is.null"}&${moneyUnchanged(cur)}`, { resolution: decision, split_editor_cents: editorCents, refund_cents: held - editorCents, resolved_by: me.id, resolved_at: new Date().toISOString(), auto_release_at: null, stripe_transfer_id: null, stripe_refund_id: null });
      row = rows && rows[0] || null;
    } finally { await unlock(); }
    if (!row) return bad("The order changed a moment ago. Reload the page and decide again.", 409);
    console.error("a stuck decision was replaced", c.id, c.resolution, "->", decision, "by", me.id);
    row.replaced = { decision: c.resolution, editor_cents: c.split_editor_cents, refund_cents: c.refund_cents, by: c.resolved_by || null, at: c.resolved_at || null };
  } else {
    // Nothing can be paid into the Order once it is decided: its Stripe payment page is closed first.
    if ((await closeCheckout(c, false)) === "paid") return bad("A payment for this order has just come in. Reload the page and decide again.", 409);
    const p = typeof body.editor_percent === "number" ? body.editor_percent : NaN;
    if (decision === "split" && (!Number.isFinite(p) || p <= 0 || p >= 100)) return bad("editor_percent must be a number between 0 and 100 (exclusive) for a split");
    const now = new Date().toISOString();
    const from = ["funded", "delivered", "disputed"];
    // under the order lock: a release that is being finished right now (the client's retry, the hourly job) cannot
    // land its transfer between this check and the claim
    const unlock = await lockOrder(c.id);
    try {
      // The amounts from the Order as it is now, under its lock (a part's payout takes the same lock), and the decision
      // records exactly those: worked out from the row read before the lock, a part paid out meanwhile made the settlement
      // shrink both shares, while the record kept the first amounts (check of 2 November).
      const cur = await db.contract(c.id);
      if (!cur) return bad("The order changed a moment ago. Reload the page and decide again.", 409);
      const held = Math.max(heldCents(cur) - await owedBack(cur), 0);           // (never what is owed back to the freelancer)
      if (!held) return bad("This order is not holding money", 409);
      const editorCents = decision === "release" ? held : decision === "refund" ? 0 : Math.round(held * p / 100);
      const refundCents = held - editorCents;
      // a release that never got its transfer (no id, none at the provider) can be taken over
      if (c.status === "releasing" && !c.stripe_transfer_id) {
        const made = (await transfersOf(c)).filter(t => !t.reversed && !(t.metadata.milestone_id || ""));
        if (made.length) return bad("A transfer for this order already exists at the provider; let the release finish (it is retried every hour)", 409);
        from.push("releasing");
      }
      // a fresh decision: ids left by an interrupted earlier settlement must not make this one skip a move (what they
      // moved is already in the counters; the provider is asked before any transfer or refund is made anyway)
      // only while the price and what was paid in are still the ones the decision was worked out from (and what was paid
      // out and given back, which the amounts are worked out from). The Order's note
      // is left as it is: a stopped step's note goes once the settlement goes through, any other note stays until the
      // admin marks it as handled (a decision does not sort out, say, a top-up that may not be recorded).
      const rows = await db.update("contracts", `id=eq.${c.id}&status=in.(${from.join(",")})&${moneyUnchanged(c)}&${same("released_cents", cur.released_cents)}&${same("refunded_cents", cur.refunded_cents)}`,
        { status: "resolving", resolution: decision, split_editor_cents: editorCents, refund_cents: refundCents, resolved_by: me.id, resolved_at: now, auto_release_at: null, stripe_transfer_id: null, stripe_refund_id: null });
      row = rows && rows[0] || null;
    } finally { await unlock(); }
    if (!row) return bad("The order changed a moment ago. Reload the page and decide again.", 409);
    row.was_disputed = c.status === "disputed";
  }
  const pct = typeof body.editor_percent === "number" ? body.editor_percent : NaN;
  await recordDecision(row, row.resolved_by || me.id, { percent: decision === "split" ? pct : NaN, note, replaced: row.replaced });
  await decisionRecorded(row);                                          // on record now: the note saying it was not goes
  // both sides are told the decision once, also when this is the admin's try again after a lost answer (announceDecision)
  const told = await announceDecision({ ...c, ...row });
  const u = await settle(row, me.id, `resolved_${decision}`);
  if (!told) await announceDecision({ ...c, ...row });                  // told after all, once the database answers again
  // (what moved: the settlement's own amounts, which it lowers when the Order holds less than was worked out)
  return json(200, { ok: true, status: u && u.status, editorCents: Number((u || row).split_editor_cents) || 0, refundCents: Number((u || row).refund_cents) || 0 });
});
