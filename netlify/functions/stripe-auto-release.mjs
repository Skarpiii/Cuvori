// Hourly. Hardened copy: compare-and-set claim, skips banned freelancers, resumes stuck releases.
// Releases whole Orders and single milestones whose review window has passed with no answer, finishes
// releases and decisions that failed at the provider earlier (money settling, account not ready), and
// expires stale job posts. Everything it does is idempotent; running it twice changes nothing.
import { escrowEnabled, db, settle, releaseMilestone, json, heldCents, isBanned, orderPayoutAccount, accountReady, chargebackOpen, repayWon, coverChargeback, settleFee, closeCheckout, moneyUnchanged } from "../lib/cuvori.mjs";

export const config = { schedule: "@hourly" };
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();

export default async () => {
  // jobs first: open posts past their date become "expired" (the owner can renew; the feed no longer shows them). Needs no Stripe.
  let expired = 0;
  try { expired = Number(await db.rpc("expire_jobs", {})) || 0; } catch (e) { console.error("expire_jobs failed", e.message); }
  if (!escrowEnabled()) return json(200, { skipped: "escrow not configured", expired });
  // "Stripe check" notes on unpaid Orders, written more than a day ago (or before notes had a time): nothing needs doing
  // on those — no money was taken — so they leave the admin panel's "Needs a hand" list. Other notes are never touched.
  const dayAgo = encodeURIComponent(ago(24 * 60));
  for (const note of ["Stripe check failed:", "Stripe account check:"]) for (const when of [`lt.${dayAgo}`, "is.null"])
    await db.update("contracts", `status=eq.accepted&money_error=like.${encodeURIComponent(note)}*&money_error_at=${when}`, { money_error: null }).catch(e => console.error("clearing old Stripe check notes failed", e.message));
  const now = new Date().toISOString();
  const due = await db.select("contracts", `status=eq.delivered&payment_mode=eq.escrow&auto_release_at=lte.${encodeURIComponent(now)}&select=*&order=auto_release_at.asc&limit=50`);
  // stuck: a release or a decision whose money move failed earlier; not one that started a moment ago
  const stuck = await db.select("contracts", `status=in.(releasing,resolving)&payment_mode=eq.escrow&resolved_at=lte.${encodeURIComponent(ago(10))}&select=*&limit=50`);
  const done = [], failed = [], skipped = [];
  for (const c of [...(due || []), ...(stuck || [])]) {
    try {
      if (chargebackOpen(c)) { skipped.push({ id: c.id, why: "chargeback open" }); continue; }
      const cents = heldCents(c);
      let row = c;
      if (c.status === "delivered") {
        if (!cents) throw new Error("amount missing");
        if (await isBanned(c.editor)) { failed.push({ id: c.id, why: "freelancer banned" }); continue; }
        const acct = await orderPayoutAccount(c);
        if (!accountReady(acct)) { failed.push({ id: c.id, why: "freelancer account not ready" }); continue; }
        // Nothing can be paid into the Order once it is closed: its Stripe payment page is closed first. What is held is
        // paid out even when an accepted price increase was never paid in, so a client who goes silent cannot hold back
        // the freelancer's money.
        if ((await closeCheckout(c)) === "paid") { skipped.push({ id: c.id, why: "a payment has just come in; released on the next run" }); continue; }
        const rows = await db.update("contracts", `id=eq.${c.id}&status=eq.delivered&${moneyUnchanged(c)}`, { status: "releasing", resolution: "release", split_editor_cents: cents, refund_cents: 0, resolved_at: now, auto_release_at: null });
        row = rows && rows[0] || null;
        if (!row) continue;                                               // disputed / sent back / paid into meanwhile
        await settle(row, null, "auto_release");
      } else {
        const ev = c.status === "releasing" ? (c.resolved_by ? "approve" : "auto_release") : (c.resolution === "refund" && c.resolved_by === c.editor ? "cancel_refund" : `resolved_${c.resolution}`);
        await settle(row, null, ev);
      }
      done.push(c.id);
    } catch (e) { failed.push({ id: c.id, why: e.message }); console.error("auto-release failed for", c.id, e.message); }
  }
  // milestones: submitted with the review window over, or approved by the client but never paid out (provider trouble)
  const ms = [...(await db.select("order_milestones", `status=eq.submitted&auto_release_at=lte.${encodeURIComponent(now)}&select=*&order=auto_release_at.asc&limit=50`) || []),
              ...(await db.select("order_milestones", `status=eq.approved&transfer_ref=is.null&select=*&limit=50`) || [])];
  for (const m of ms) {
    try {
      const c = await db.contract(m.order_id);
      if (!c || c.payment_mode !== "escrow" || !["funded", "delivered"].includes(c.status)) continue;
      if (chargebackOpen(c)) { skipped.push({ id: m.id, why: "chargeback open" }); continue; }
      if (await isBanned(c.editor)) { failed.push({ id: m.id, why: "freelancer banned" }); continue; }
      const acct = await orderPayoutAccount(c);
      if (!accountReady(acct)) { failed.push({ id: m.id, why: "freelancer account not ready" }); continue; }
      await releaseMilestone(c, m, null, m.status === "approved" ? "approve" : "auto_release");
      done.push(m.id);
    } catch (e) { failed.push({ id: m.id, why: e.message }); console.error("milestone auto-release failed for", m.id, e.message); }
  }
  // chargebacks whose pull-back from the freelancer did not go through at the time (provider said no, or did not answer)
  const owedBack = (await db.select("contracts", `chargeback_status=eq.open&payment_mode=eq.escrow&money_error=like.chargeback:*&select=id,chargeback_id,money_error&limit=20`).catch(() => [])) || [];
  for (const c of owedBack) {
    if (!String(c.money_error || "").startsWith("chargeback:")) continue;
    try { await coverChargeback(c.id, c.chargeback_id); done.push(c.id); }
    catch (e) { failed.push({ id: c.id, why: e.message }); console.error("pull-back retry failed for", c.id, e.message); }
  }
  // freelancers still owed a re-payment after a won chargeback (the provider could not pay at the time)
  const owed = (await db.select("contracts", `chargeback_status=eq.won&payment_mode=eq.escrow&money_error=like.chargeback%20won*&select=*&limit=20`).catch(() => [])) || [];
  for (const c of owed) {
    if (!String(c.money_error || "").startsWith("chargeback won")) continue;
    try { if (await repayWon(c)) done.push(c.id); else failed.push({ id: c.id, why: c.money_error }); }
    catch (e) { failed.push({ id: c.id, why: e.message }); console.error("re-payment retry failed for", c.id, e.message); }
  }
  // payments whose processing-fee surplus has not gone back to the card yet (the provider's fee was not known at the
  // time, or the refund failed); older than a couple of minutes so it never races the payment being recorded
  let feesSettled = 0;
  const unsettled = (await db.select("order_payments", `kind=eq.fund&status=eq.succeeded&provider=eq.stripe&fee_refund_cents=is.null&created_at=lt.${encodeURIComponent(ago(2))}&select=*&order=created_at.asc&limit=50`).catch(() => [])) || [];
  for (const row of unsettled) {
    try { const c = await db.contract(row.order_id); if (!c) continue; if ((await settleFee(c, row)) !== "pending") feesSettled++; }
    catch (e) { failed.push({ id: row.order_id, why: "fee: " + e.message }); console.error("fee settle retry failed for", row.order_id, e.message); }
  }
  return json(200, { released: done, failed: failed.length, failures: failed.slice(0, 20), skipped, expired, feesSettled });
};
