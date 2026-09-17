// Hourly. Hardened copy: compare-and-set claim, skips banned editors, resumes stuck releases.
import { escrowEnabled, db, settle, json, centsOf, isBanned, payoutAccount } from "../lib/cuvori.mjs";

export const config = { schedule: "@hourly" };

export default async () => {
  if (!escrowEnabled()) return json(200, { skipped: "escrow not configured" });
  const now = new Date().toISOString();
  const due = await db.select("contracts", `status=eq.delivered&payment_mode=eq.escrow&auto_release_at=lte.${encodeURIComponent(now)}&select=*&order=auto_release_at.asc&limit=50`);
  const stuck = await db.select("contracts", `status=eq.releasing&payment_mode=eq.escrow&select=*&limit=50`);
  const done = [], failed = [];
  for (const c of [...(due || []), ...(stuck || [])]) {
    try {
      const cents = centsOf(c);
      if (!cents) throw new Error("amount missing");
      let row = c;
      if (c.status === "delivered") {
        if (await isBanned(c.editor)) { failed.push({ id: c.id, why: "editor banned" }); continue; }
        const acct = await payoutAccount(c.editor);
        if (!acct || !acct.payouts_enabled) { failed.push({ id: c.id, why: "editor account not ready" }); continue; }
        row = await db.claim(c.id, ["delivered"], { status: "releasing", resolution: "release", split_editor_cents: cents, refund_cents: 0, resolved_at: now, auto_release_at: null });
        if (!row) continue;                                               // disputed / sent back meanwhile
      }
      await settle(row, c.editor, "auto_release");
      done.push(c.id);
    } catch (e) { failed.push({ id: c.id, why: e.message }); console.error("auto-release failed for", c.id, e.message); }
  }
  return json(200, { released: done, failed: failed.length });
};
