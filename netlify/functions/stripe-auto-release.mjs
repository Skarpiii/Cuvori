// Hourly. Hardened copy: compare-and-set claim, skips banned freelancers, resumes stuck releases.
// Releases whole Orders and single milestones whose review window has passed with no answer, finishes
// releases and decisions that failed at the provider earlier (money settling, account not ready), and
// expires stale job posts. Everything it does is idempotent; running it twice changes nothing.
import { escrowEnabled, db, settle, releaseMilestone, json, heldCents, isBanned, orderPayoutAccount, accountReady, chargebackOpen, repayWon, coverChargeback, settleFee, closeCheckout, moneyUnchanged, repairFirstLines, repairPayoutLines, retryLateRefunds, acctCols, payoutWaits, tellDecisions } from "../lib/cuvori.mjs";

export const config = { schedule: "@hourly" };
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();

// Each list (Orders due, stuck payouts and decisions, parts) is worked in batches of 50, oldest first. What can't be paid
// out now is set aside before it takes a place, so Orders that fail every hour hold back none of the others (check of
// 26 November, as pricing-v2 since its audit of 31 October: only the 50 oldest were tried, and those that failed stayed the
// oldest for good) — up to the 1,000 oldest of a list (PAGES pages of PAGE rows) read in a run.
const BATCH = 50, PAGE = 200, PAGES = 5;
// The freelancers among `ids` who can't be paid right now, from the database alone (no Stripe call): banned (no profile
// counts as banned, as everywhere), or their Stripe setup not finished by the "ready" mark that every account check and
// Stripe's account notice keep in line with Stripe. id -> why. The mark is only read when these keys' mode can be told
// (otherwise nobody is set aside for it). A profile answer without a clear yes or no for "banned" decides nothing here:
// that freelancer goes after the others, and the Order's own check (isBanned, which stops on such an answer) decides
// (check of 30 November: it was taken for "banned", the payout held and the admin told the freelancer could not receive
// payments).
async function unpayable(ids) {
  const out = new Map(), all = [...new Set(ids)];
  let col = null; try { col = acctCols(); } catch {}
  for (let i = 0; i < all.length; i += 100) {
    const part = all.slice(i, i + 100), list = part.join(",");
    const profiles = (await db.select("profiles", `id=in.(${list})&select=id,banned`)) || [];
    const ready = col ? ((await db.select("payout_details", `id=in.(${list})&select=id,${col.ready}`)) || []) : null;
    for (const id of part) {
      const p = profiles.find(x => x.id === id);
      if (!p || p.banned === true) out.set(id, "freelancer banned");
      else if (p.banned !== false) out.set(id, "banned mark unclear");
      else if (ready && !(ready.find(x => x.id === id) || {})[col.ready]) out.set(id, "freelancer account not ready");
    }
  }
  return out;
}
// The hour's batch. hold(row) says why a row can't be paid out now (a chargeback open): it is set aside. So is one whose
// freelancer is banned (unless banned ones only go last: a step already started may have its transfer at Stripe and only
// needs to be counted). A freelancer whose ready mark says their Stripe setup isn't finished goes after everyone else:
// Stripe is asked about them only when there is room, so a mark that is behind still catches up.
async function sortOut(rows, editorOf, hold, aside, into, bannedLast = false) {
  const cannot = await unpayable(rows.map(editorOf).filter(Boolean));
  for (const r of rows) {
    const no = cannot.get(editorOf(r));
    const why = (await hold(r)) || (no === "freelancer banned" && !bannedLast ? no : null);
    if (why) { await aside(r, why); continue; }
    (no ? into.later : into.ready).push(r);
  }
}
const batch = (into) => [...into.ready, ...into.later].slice(0, BATCH);
// a list read page by page, oldest first, until the hour's batch is full of rows that can be worked on. Each page starts
// where the one before ended, and only an empty page is the end: one answer holds at most what Supabase's "Max rows"
// allows (1,000 unless changed), and set under a page, a shorter answer was taken for the last one, so the rows after it
// were never read (check of 30 November). The list's order ends with the id (`oldestFirst`): Postgres gives rows of one
// same time in no set order, another one for another page, and a row was then read twice and another not at all (a run
// gives every Order it starts the same time).
const oldestFirst = (col) => `order=${col}.asc,id.asc`;
async function batchOf(table, query, editorOf, hold, aside, bannedLast = false) {
  const into = { ready: [], later: [] }, seen = new Set();
  for (let p = 0, from = 0; p < PAGES && into.ready.length < BATCH; p++) {
    const page = (await db.select(table, `${query}&limit=${PAGE}&offset=${from}`)) || [];
    if (!page.length) break;
    from += page.length;
    await sortOut(page.filter(r => !seen.has(r.id) && seen.add(r.id)), editorOf, hold, aside, into, bannedLast);
  }
  return batch(into);
}

// Netlify stops a scheduled function after 30 seconds. The run stops starting new work in time, so it never stops in the
// middle of a step, and each part of it gets its turn every hour: what is left waits for the next run (oldest first).
// (check of 26 November: 12 Orders due took about 35 seconds with ordinary answer times, and everything after the Orders
// then never ran). The notes on payouts that wait come last: they never take the payouts' time.
const LIMITS = { orders: 12e3, parts: 17e3, chargebacks: 20e3, decisions: 21e3, repairs: 25e3, notes: 26e3 };

export default async () => {
  const t0 = performance.now(), over = (part) => performance.now() - t0 > LIMITS[part];
  let waiting = 0;
  // jobs first: open posts past their date become "expired" (the owner can renew; the feed no longer shows them). Needs no Stripe.
  let expired = 0;
  try { expired = Number(await db.rpc("expire_jobs", {})) || 0; } catch (e) { console.error("expire_jobs failed", e.message); }
  if (!escrowEnabled()) return json(200, { skipped: "escrow not configured", expired });
  // "Stripe check failed" notes on unpaid Orders with no new failure for a day (each failure renews its note) or from
  // before notes had a time: nothing needs doing on those — no money was taken — so they leave the admin panel's "Needs
  // a hand" list. "Stripe account check" notes stay until the account is sorted out; other notes are never touched.
  const dayAgo = encodeURIComponent(ago(24 * 60));
  for (const when of [`lt.${dayAgo}`, "is.null"])
    await db.update("contracts", `status=eq.accepted&money_error=like.${encodeURIComponent("Stripe check failed:")}*&money_error_at=${when}`, { money_error: null }).catch(e => console.error("clearing old Stripe check notes failed", e.message));
  const now = new Date().toISOString();
  const done = [], failed = [], skipped = [];
  const aside = (r, why) => (why === "freelancer banned" ? failed : skipped).push({ id: r.id, why });
  // An automatic payout that can't go through says so on its Order, under "Needs a hand" (payoutWaits): the freelancer is
  // banned, or their Stripe setup isn't finished (check of 26 November: it was skipped every hour without a word, and the
  // Order kept promising the payout on a date gone by). One set aside while the lists are read (a banned freelancer's) is
  // noted at the end of the run, in the time left (check of 27 November: written while the lists were read, before the
  // run looked at the clock, the notes of 40 such Orders at slow answers left no time for any payout at all).
  const waits = async (c, what, why) => { await payoutWaits(c, what, why === "freelancer banned" ? "banned" : "not_ready").catch(e => console.error("payout note not saved", c && c.id, e && e.message)); };
  const notes = [], noteLater = (c, what, why) => notes.push({ c, what, why });
  // due: delivered, the review window over, no chargeback open
  const due = await batchOf("contracts", `status=eq.delivered&payment_mode=eq.escrow&auto_release_at=lte.${encodeURIComponent(now)}&select=*&${oldestFirst("auto_release_at")}`, c => c.editor,
    async c => (chargebackOpen(c) ? "chargeback open" : null), async (c, why) => { aside(c, why); if (why === "freelancer banned") noteLater(c, "automatic payout", why); });
  // stuck: a release or a decision whose money move failed earlier; not one that started a moment ago. Oldest first; one
  // that still has to pay a freelancer who can't be paid goes last (it may only need its transfer at Stripe counted).
  const stuck = await batchOf("contracts", `status=in.(releasing,resolving)&payment_mode=eq.escrow&resolved_at=lte.${encodeURIComponent(ago(10))}&select=*&${oldestFirst("resolved_at")}`,
    c => (Number.isInteger(c.split_editor_cents) && c.split_editor_cents > 0 && !c.stripe_transfer_id ? c.editor : null),
    async c => (chargebackOpen(c) ? "chargeback open" : null), aside, true);
  for (const c of [...due, ...stuck]) {
    if (over("orders")) { waiting++; continue; }
    try {
      if (chargebackOpen(c)) { skipped.push({ id: c.id, why: "chargeback open" }); continue; }
      const cents = heldCents(c);
      let row = c;
      if (c.status === "delivered") {
        if (!cents) throw new Error("amount missing");
        if (await isBanned(c.editor)) { await waits(c, "automatic payout", "freelancer banned"); failed.push({ id: c.id, why: "freelancer banned" }); continue; }
        const acct = await orderPayoutAccount(c);
        if (!accountReady(acct)) { await waits(c, "automatic payout", "freelancer account not ready"); failed.push({ id: c.id, why: "freelancer account not ready" }); continue; }
        // Nothing can be paid into the Order once it is closed: its Stripe payment page is closed first. What is held is
        // paid out even when an accepted price increase was never paid in, so a client who goes silent cannot hold back
        // the freelancer's money.
        if ((await closeCheckout(c)) === "paid") { skipped.push({ id: c.id, why: "a payment has just come in; released on the next run" }); continue; }
        // only while its review period is still over at this moment: the client may have sent it back and the freelancer
        // delivered again since this run read its list (a new period then runs; check of 26 November)
        const rows = await db.update("contracts", `id=eq.${c.id}&status=eq.delivered&auto_release_at=lte.${encodeURIComponent(now)}&${moneyUnchanged(c)}`, { status: "releasing", resolution: "release", split_editor_cents: cents, refund_cents: 0, resolved_at: now, auto_release_at: null });
        row = rows && rows[0] || null;
        if (!row) continue;                                               // disputed / sent back / delivered again / paid into meanwhile
        await settle(row, null, "auto_release");
      } else {
        const ev = c.status === "releasing" ? (c.resolved_by ? "approve" : "auto_release") : (c.resolution === "refund" && c.resolved_by === c.editor ? "cancel_refund" : `resolved_${c.resolution}`);
        await settle(row, null, ev);
      }
      done.push(c.id);
    } catch (e) { failed.push({ id: c.id, why: e.message }); console.error("auto-release failed for", c.id, e.message); }
  }
  // milestones: submitted with the review window over, or approved by the client but never paid out (provider trouble).
  // Only those of protected Orders that can still pay out: a milestone of an Order paid directly is approved and never
  // has a transfer, and those filled the list for good. Oldest first, set aside like the Orders above.
  // Every protected Order still open, page by page until none is left: one answer holds at most what Supabase's "Max rows"
  // allows (1,000 unless changed), so an answer shorter than asked for is not taken for the last one (check of 27 November:
  // 2,000 were read in one answer, and the parts of every Order after them were never paid)
  const open = [];
  for (let from = 0, p = 0; p < 50; p++) {
    const page = (await db.select("contracts", `payment_mode=eq.escrow&status=in.(funded,delivered)&select=id,editor,status,chargeback_status,money_error&order=id.asc&limit=1000&offset=${from}`)) || [];
    if (!page.length) break;
    open.push(...page); from += page.length;
  }
  const orderOf = new Map(open.map(c => [c.id, c]));
  const msDue = [], msOwed = [];
  for (let i = 0; i < open.length; i += 100) {
    const list = open.slice(i, i + 100).map(c => c.id).join(",");
    msDue.push(...((await db.select("order_milestones", `order_id=in.(${list})&status=eq.submitted&auto_release_at=lte.${encodeURIComponent(now)}&select=*&order=auto_release_at.asc&limit=${PAGE}`)) || []));
    msOwed.push(...((await db.select("order_milestones", `order_id=in.(${list})&status=eq.approved&transfer_ref=is.null&select=*&order=approved_at.asc&limit=${PAGE}`)) || []));
  }
  const when = (m) => String(m.auto_release_at || m.approved_at || "");
  const byTime = (a, b) => (when(a) < when(b) ? -1 : when(a) > when(b) ? 1 : 0);
  const msInto = { ready: [], later: [] };
  const msHold = async m => (chargebackOpen(orderOf.get(m.order_id)) ? "chargeback open" : null);
  const msEditor = m => (orderOf.get(m.order_id) || {}).editor;
  await sortOut(msDue.sort(byTime), msEditor, msHold, async (m, why) => { aside(m, why); if (why === "freelancer banned") noteLater(orderOf.get(m.order_id) || { id: m.order_id }, `milestone ${m.id}`, why); }, msInto);
  await sortOut(msOwed.sort(byTime), msEditor, msHold, aside, msInto, true);
  for (const m of batch(msInto)) {
    if (over("parts")) { waiting++; continue; }
    try {
      const c = await db.contract(m.order_id);
      if (!c || c.payment_mode !== "escrow" || !["funded", "delivered"].includes(c.status)) continue;
      if (chargebackOpen(c)) { skipped.push({ id: m.id, why: "chargeback open" }); continue; }
      if (await isBanned(c.editor)) { await waits(c, `milestone ${m.id}`, "freelancer banned"); failed.push({ id: m.id, why: "freelancer banned" }); continue; }
      const acct = await orderPayoutAccount(c);
      if (!accountReady(acct)) { await waits(c, `milestone ${m.id}`, "freelancer account not ready"); failed.push({ id: m.id, why: "freelancer account not ready" }); continue; }
      await releaseMilestone(c, m, null, m.status === "approved" ? "approve" : "auto_release");
      done.push(m.id);
    } catch (e) { failed.push({ id: m.id, why: e.message }); console.error("milestone auto-release failed for", m.id, e.message); }
  }
  // chargebacks whose pull-back from the freelancer did not go through at the time (provider said no, or did not answer)
  const owedBack = (await db.select("contracts", `chargeback_status=eq.open&payment_mode=eq.escrow&money_error=like.chargeback:*&select=id,chargeback_id,money_error&limit=20`).catch(() => [])) || [];
  for (const c of owedBack) {
    if (over("chargebacks")) { waiting++; continue; }
    if (!String(c.money_error || "").startsWith("chargeback:")) continue;
    try { await coverChargeback(c.id, c.chargeback_id); done.push(c.id); }
    catch (e) { failed.push({ id: c.id, why: e.message }); console.error("pull-back retry failed for", c.id, e.message); }
  }
  // freelancers still owed a re-payment after a won chargeback (the provider could not pay at the time)
  const owed = (await db.select("contracts", `chargeback_status=eq.won&payment_mode=eq.escrow&money_error=like.chargeback%20won*&select=*&limit=20`).catch(() => [])) || [];
  for (const c of owed) {
    if (over("chargebacks")) { waiting++; continue; }
    if (!String(c.money_error || "").startsWith("chargeback won")) continue;
    // (nothing paid back and no longer owed, the Order still holding the money: no failure. Check of 28 November)
    try {
      if (await repayWon(c)) done.push(c.id);
      else if (String(((await db.contract(c.id).catch(() => null)) || c).money_error || "").startsWith("chargeback won")) failed.push({ id: c.id, why: c.money_error });
    }
    catch (e) { failed.push({ id: c.id, why: e.message }); console.error("re-payment retry failed for", c.id, e.message); }
  }
  // Cuvori's decisions carried out but not told to both sides yet (their money step stopped and was finished above, or the
  // database did not answer the admin's request): told now, once (check of 26 November). One still waiting for its money
  // step is told once it is carried out, and one that can't be carried out never (check of 27 November)
  let decisionsTold = 0;
  if (!over("decisions")) { try { const t = await tellDecisions(() => over("decisions")); decisionsTold = t.told; waiting += t.left; } catch (e) { console.error("telling decisions failed", e && e.message); } }
  // (each of these repairs works through a short list; one that would start too late waits for the next run)
  const repair = async (why, fn) => { if (over("repairs")) { waiting++; return null; } try { const r = await fn(); failed.push(...r.failed); return r; } catch (e) { failed.push({ id: null, why: why + ": " + e.message }); console.error(why + " check failed", e.message); return null; } };
  // first payments counted on their Order whose ledger line could not be saved: added from Stripe's record, and their
  // card-fee surplus sent back (refunds, a chargeback and the surplus all go by that line)
  let linesAdded = 0;
  linesAdded += ((await repair("first payment lines", repairFirstLines)) || {}).added || 0;
  // payout lines (a milestone's payout, a re-payment after a won chargeback) that could not be saved: added the same way
  linesAdded += ((await repair("payout lines", repairPayoutLines)) || {}).added || 0;
  // payments whose processing-fee surplus has not gone back to the card yet (the provider's fee was not known at the
  // time, or the refund failed); older than a couple of minutes so it never races the payment being recorded
  let feesSettled = 0;
  const unsettled = (await db.select("order_payments", `kind=eq.fund&status=eq.succeeded&provider=eq.stripe&fee_refund_cents=is.null&created_at=lt.${encodeURIComponent(ago(2))}&select=*&order=created_at.asc&limit=50`).catch(() => [])) || [];
  for (const row of unsettled) {
    if (over("repairs")) { waiting++; continue; }
    try { const c = await db.contract(row.order_id); if (!c) continue; if ((await settleFee(c, row)) !== "pending") feesSettled++; }
    catch (e) { failed.push({ id: row.order_id, why: "fee: " + e.message }); console.error("fee settle retry failed for", row.order_id, e.message); }
  }
  // late payments charged but not back on the card yet (Stripe refused the refund, or did not answer): tried again until
  // the money is back; Stripe itself stops sending them again after about 3 days
  const lateRefunded = ((await repair("late payments", retryLateRefunds)) || {}).done || 0;
  // last, the notes on the payouts set aside above (oldest first): one already there costs nothing, and those left when
  // the time is up are written the next hour
  for (const n of notes) {
    if (over("notes")) { waiting++; continue; }
    await waits(n.c, n.what, n.why);
  }
  // One line in the log when something failed or was left for the next hour (its time was up): Netlify keeps nothing a
  // scheduled function sends back, so the answer below was read by nobody, and payouts put off hour after hour showed
  // nowhere (check of 28 November). A payout that waits for its freelancer (banned, Stripe setup not finished) is no
  // failure here: its Order says so, and the log names it each hour.
  const forFreelancer = (f) => f && (f.why === "freelancer banned" || f.why === "freelancer account not ready");
  const broke = failed.filter(f => !forFreelancer(f));
  if (broke.length || waiting)
    console.error(`hourly run summary: ${broke.length} failed, ${waiting} left for the next hour${waiting ? " (its time was up)" : ""}, ${done.length} done` +
      (broke.length ? `; failed: ${broke.slice(0, 5).map(f => `${f.id || "-"} (${String(f.why || "").slice(0, 120)})`).join(", ")}${broke.length > 5 ? ` and ${broke.length - 5} more` : ""}` : ""));
  return json(200, { released: done, failed: failed.length, failures: failed.slice(0, 20), skipped, expired, feesSettled, linesAdded, lateRefunded, decisionsTold, waiting });
};
