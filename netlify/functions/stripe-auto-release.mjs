// Hourly. Hardened copy: compare-and-set claim, skips banned freelancers, resumes stuck releases.
// Releases whole Orders and single milestones whose review window has passed with no answer.
import { escrowEnabled, db, settle, releaseMilestone, json, heldCents, isBanned, payoutAccount } from "../lib/cuvori.mjs";

export const config = { schedule: "@hourly" };

export default async () => {
  // jobs first: open posts past their date become "expired" (the owner can renew; the feed no longer shows them). Needs no Stripe.
  let expired = 0;
  try { expired = Number(await db.rpc("expire_jobs", {})) || 0; } catch (e) { console.error("expire_jobs failed", e.message); }
  if (!escrowEnabled()) return json(200, { skipped: "escrow not configured", expired });
  const now = new Date().toISOString();
  const due = await db.select("contracts", `status=eq.delivered&payment_mode=eq.escrow&auto_release_at=lte.${encodeURIComponent(now)}&select=*&order=auto_release_at.asc&limit=50`);
  const stuck = await db.select("contracts", `status=eq.releasing&payment_mode=eq.escrow&select=*&limit=50`);
  const done = [], failed = [];
  for (const c of [...(due || []), ...(stuck || [])]) {
    try {
      const cents = heldCents(c);
      if (!cents) throw new Error("amount missing");
      let row = c;
      if (c.status === "delivered") {
        if (await isBanned(c.editor)) { failed.push({ id: c.id, why: "freelancer banned" }); continue; }
        const acct = await payoutAccount(c.editor);
        if (!acct || !acct.payouts_enabled) { failed.push({ id: c.id, why: "freelancer account not ready" }); continue; }
        row = await db.claim(c.id, ["delivered"], { status: "releasing", resolution: "release", split_editor_cents: cents, refund_cents: 0, resolved_at: now, auto_release_at: null });
        if (!row) continue;                                               // disputed / sent back meanwhile
      }
      await settle(row, null, "auto_release");
      done.push(c.id);
    } catch (e) { failed.push({ id: c.id, why: e.message }); console.error("auto-release failed for", c.id, e.message); }
  }
  // milestones: submitted, review window over, Order still funded and not disputed
  const ms = await db.select("order_milestones", `status=eq.submitted&auto_release_at=lte.${encodeURIComponent(now)}&select=*&order=auto_release_at.asc&limit=50`);
  for (const m of (ms || [])) {
    try {
      const c = await db.contract(m.order_id);
      if (!c || c.payment_mode !== "escrow" || !["funded", "delivered"].includes(c.status)) continue;
      if (await isBanned(c.editor)) { failed.push({ id: m.id, why: "freelancer banned" }); continue; }
      const acct = await payoutAccount(c.editor);
      if (!acct || !acct.payouts_enabled) { failed.push({ id: m.id, why: "freelancer account not ready" }); continue; }
      await releaseMilestone(c, m, null, "auto_release");
      done.push(m.id);
    } catch (e) { failed.push({ id: m.id, why: e.message }); console.error("milestone auto-release failed for", m.id, e.message); }
  }
  return json(200, { released: done, failed: failed.length, expired });
};
