// Hourly. Hardened copy: compare-and-set claim, skips banned freelancers, resumes stuck releases.
// Releases whole Orders and single milestones whose review window has passed with no answer, finishes
// releases and decisions that failed at the provider earlier (money settling, account not ready), and
// expires stale job posts. Everything it does is idempotent; running it twice changes nothing.
import { escrowEnabled, db, settle, releaseMilestone, json, heldCents, isBanned, payoutAccount, accountReady, chargebackOpen } from "../lib/cuvori.mjs";

export const config = { schedule: "@hourly" };
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();

export default async () => {
  // jobs first: open posts past their date become "expired" (the owner can renew; the feed no longer shows them). Needs no Stripe.
  let expired = 0;
  try { expired = Number(await db.rpc("expire_jobs", {})) || 0; } catch (e) { console.error("expire_jobs failed", e.message); }
  if (!escrowEnabled()) return json(200, { skipped: "escrow not configured", expired });
  const now = new Date().toISOString();
  const due = await db.select("contracts", `status=eq.delivered&payment_mode=eq.escrow&auto_release_at=lte.${encodeURIComponent(now)}&select=*&order=auto_release_at.asc&limit=50`);
  // stuck: a release or a decision whose money move failed earlier; not one that started a moment ago
  const stuck = await db.select("contracts", `status=in.(releasing,resolving)&payment_mode=eq.escrow&resolved_at=lte.${encodeURIComponent(ago(10))}&select=*&limit=50`);
  const done = [], failed = [], skipped = [];
  for (const c of [...(due || []), ...(stuck || [])]) {
    try {
      if (chargebackOpen(c)) { skipped.push({ id: c.id, why: "chargeback open" }); continue; }
      const cents = heldCents(c);
      if (!cents) throw new Error("amount missing");
      let row = c;
      if (c.status === "delivered") {
        if (await isBanned(c.editor)) { failed.push({ id: c.id, why: "freelancer banned" }); continue; }
        const acct = await payoutAccount(c.editor);
        if (!accountReady(acct)) { failed.push({ id: c.id, why: "freelancer account not ready" }); continue; }
        row = await db.claim(c.id, ["delivered"], { status: "releasing", resolution: "release", split_editor_cents: cents, refund_cents: 0, resolved_at: now, auto_release_at: null });
        if (!row) continue;                                               // disputed / sent back meanwhile
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
      const acct = await payoutAccount(c.editor);
      if (!accountReady(acct)) { failed.push({ id: m.id, why: "freelancer account not ready" }); continue; }
      await releaseMilestone(c, m, null, m.status === "approved" ? "approve" : "auto_release");
      done.push(m.id);
    } catch (e) { failed.push({ id: m.id, why: e.message }); console.error("milestone auto-release failed for", m.id, e.message); }
  }
  return json(200, { released: done, failed: failed.length, failures: failed.slice(0, 20), skipped, expired });
};
