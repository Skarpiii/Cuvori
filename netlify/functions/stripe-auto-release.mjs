// Hourly. Hardened copy: compare-and-set claim, skips banned freelancers, resumes stuck releases.
// Releases whole Orders and single milestones whose review window has passed with no answer, finishes
// releases and decisions that failed at the provider earlier (money settling, account not ready), and
// expires stale job posts. Everything it does is idempotent; running it twice changes nothing.
import { escrowEnabled, sweepHeldApart, announceDecision, tellDecisions, markCountedParts, INQUIRY_HEAD, db, stripe, isSession, applyPaidSession, settle, releaseMilestone, json, heldCents, owedCents, MIN_TOPUP_CENTS, isBanned, orderPayoutAccount, accountReady, chargebackOpen, inquiryOpen, inquiryStillOpen, repayWon, coverChargeback, nextChargeback, OTHER_CB, hasNote, acctCols, settleFee, closeCheckout, moneyUnchanged, repairFirstLines, repairTopupLines, repairPayoutLines, retryLateRefunds, repairPlan2Lines, recordPlan2Fees, retryStates, retryDue, retryTries, retryLater, retryDone, FEE_WAIT_MS, noteFeeUnknown, retryOrder, RETRY_READ, decisionMissing, closeEmptyOrders, takeoverUnfinished, noteShortPart, outsideRefundsCounted } from "../lib/cuvori.mjs";

export const config = { schedule: "@hourly" };
const ago = (min) => new Date(Date.now() - min * 60e3).toISOString();
const BATCH = 50, PAGE = 200, PAGES = 5;
// The freelancers among `ids` who can't be paid right now, from the database alone (no Stripe call): banned, or their
// Stripe setup not finished by the "ready" mark that every account check and Stripe's account notice keep in line with
// Stripe. id -> why. The mark is only read when these keys' mode can be told (otherwise nobody is set aside for it).
async function unpayable(ids) {
  const out = new Map(), all = [...new Set(ids)];
  let col = null; try { col = acctCols(); } catch {}
  for (let i = 0; i < all.length; i += 100) {
    const part = all.slice(i, i + 100), list = part.join(",");
    const profiles = (await db.select("profiles", `id=in.(${list})&select=id,banned`)) || [];
    const ready = col ? ((await db.select("payout_details", `id=in.(${list})&select=id,${col.ready}`)) || []) : null;
    for (const id of part) {
      const p = profiles.find(x => x.id === id);
      if (!p || p.banned !== false) out.set(id, "freelancer banned");
      else if (ready && !(ready.find(x => x.id === id) || {})[col.ready]) out.set(id, "freelancer account not ready");
    }
  }
  return out;
}
// The hour's batch. What can't be paid out now is set aside before it takes a place: hold(row) says why (a chargeback or
// the bank's inquiry open, a price increase not paid in), and so does a banned freelancer (unless banned ones only go
// last: a step already started may have its transfer at Stripe and only needs to be counted). A freelancer whose ready
// mark says their Stripe setup isn't finished goes after everyone else: Stripe is asked about them only when there is
// room, so a mark that is behind still catches up. Orders that fail every hour can no longer hold back every other
// automatic release (audit of 31 October: the oldest 50 were tried, and only those).
async function sortOut(rows, editorOf, hold, aside, into, bannedLast = false) {
  const cannot = await unpayable(rows.map(editorOf).filter(Boolean));
  for (const r of rows) {
    const no = cannot.get(editorOf(r));
    const why = (await hold(r)) || (no === "freelancer banned" && !bannedLast ? no : null);
    if (why) { aside(r, why); continue; }
    (no ? into.later : into.ready).push(r);
  }
}
const batch = (into) => [...into.ready, ...into.later].slice(0, BATCH);
// a list read page by page, oldest first, until the hour's batch is full of rows that can be worked on
async function batchOf(table, query, editorOf, hold, aside, bannedLast = false) {
  const into = { ready: [], later: [] }, seen = new Set();
  for (let p = 0; p < PAGES && into.ready.length < BATCH; p++) {
    const rows = ((await db.select(table, `${query}&limit=${PAGE}&offset=${p * PAGE}`)) || []).filter(r => !seen.has(r.id) && seen.add(r.id));
    await sortOut(rows, editorOf, hold, aside, into, bannedLast);
    if (rows.length < PAGE) break;
  }
  return batch(into);
}
const ASKED = "the client's bank asked about the payment (an inquiry): no automatic release until it ends";
const UNRECORDED = "Cuvori's decision is not on record: it waits for the admin to decide again";
const SHORT = "not enough money is held for this part any more: it waits for Cuvori's decision";
// An Order not released because a price increase both sides accepted is not paid in: its payment page may have been paid a
// moment ago (Stripe's notice not in yet). That payment is added now, the same way the webhook does, so it is never lost
// and the Order is released in full on the next run. The page is left open otherwise: the client can still pay it.
async function owing(c) {
  if (isSession(c.stripe_checkout_id)) {
    try {
      const s = await stripe("GET", `/checkout/sessions/${c.stripe_checkout_id}`);
      if (s && s.status === "complete" && s.client_reference_id === c.id && s.payment_intent && s.payment_intent !== c.stripe_payment_intent) await applyPaidSession(s);
    } catch (e) { console.error("checking the price increase's payment page failed for", c.id, e && e.message); }
  }
  return "an accepted price increase is not paid in yet";
}

// Netlify stops a scheduled function after 30 seconds. The run stops starting new work in time, so it never stops in the
// middle of a step, and each part of it gets its turn every hour: what is left waits for the next run (oldest first).
const LIMITS = { orders: 12e3, parts: 17e3, chargebacks: 20e3, repairs: 25e3 };

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
  // due: delivered, the review window over. Not while a chargeback or the bank's inquiry is open on the Order's payment,
  // and not while a price increase both sides accepted is not paid in: closing the Order then would drop the increase
  // for good (the client pays it, or the admin decides). The client's own approval and the admin's decision still work.
  const due = await batchOf("contracts", `status=eq.delivered&payment_mode=eq.escrow&auto_release_at=lte.${encodeURIComponent(now)}&select=*&order=auto_release_at.asc`, c => c.editor,
    async c => chargebackOpen(c) ? "chargeback open" : inquiryOpen(c) && await inquiryStillOpen(c) ? ASKED : owedCents(c) >= MIN_TOPUP_CENTS ? owing(c) : null, aside);
  // stuck: a release or a decision whose money move failed earlier; not one that started a moment ago. Oldest first; one
  // that still has to pay a freelancer who can't be paid goes last (it may only need its transfer at Stripe counted).
  // Cuvori's decision is carried out only once it is on record (its history line): one whose record could not be saved
  // waits for the admin, and the Order's note says so (decisionMissing; check of 2 November: it was carried out anyway)
  const stuck = await batchOf("contracts", `status=in.(releasing,resolving)&payment_mode=eq.escrow&resolved_at=lte.${encodeURIComponent(ago(10))}&select=*&order=resolved_at.asc`,
    c => (Number.isInteger(c.split_editor_cents) && c.split_editor_cents > 0 && !c.stripe_transfer_id ? c.editor : null),
    async c => chargebackOpen(c) ? "chargeback open" : await decisionMissing(c) ? UNRECORDED : c.status === "releasing" && !c.resolved_by && inquiryOpen(c) && await inquiryStillOpen(c) ? ASKED : null, aside, true);
  for (const c of [...due, ...stuck]) {
    if (over("orders")) { waiting++; continue; }
    try {
      if (chargebackOpen(c)) { skipped.push({ id: c.id, why: "chargeback open" }); continue; }
      const cents = heldCents(c);
      let row = c;
      if (c.status === "delivered") {
        // a refund made in the Stripe dashboard that the Order does not count yet is counted first (its notice did not get
        // through): the Order goes into a dispute as when its notice comes, and is not paid out (check of 15 November)
        if ((await outsideRefundsCounted(c)).status !== "delivered") { skipped.push({ id: c.id, why: "a refund made in the Stripe dashboard was counted first; the Order is in a dispute" }); continue; }
        if (!cents) throw new Error("amount missing");
        if (await isBanned(c.editor)) { failed.push({ id: c.id, why: "freelancer banned" }); continue; }
        const acct = await orderPayoutAccount(c);
        if (!accountReady(acct)) { failed.push({ id: c.id, why: "freelancer account not ready" }); continue; }
        // Nothing can be paid into the Order once it is closed: its Stripe payment page is closed first. (An accepted price
        // increase not paid in yet keeps the Order out of the list above: closing it would drop the increase for good.)
        if ((await closeCheckout(c)) === "paid") { skipped.push({ id: c.id, why: "a payment has just come in; released on the next run" }); continue; }
        // only while its review period is still over at this moment: the client may have sent it back and the freelancer
        // delivered again since this run read its list (a new period then runs)
        const rows = await db.update("contracts", `id=eq.${c.id}&status=eq.delivered&auto_release_at=lte.${encodeURIComponent(now)}&${moneyUnchanged(c)}`, { status: "releasing", resolution: "release", split_editor_cents: cents, refund_cents: 0, resolved_at: now, auto_release_at: null });
        row = rows && rows[0] || null;
        if (!row) continue;                                               // disputed / sent back / delivered again / paid into meanwhile
        await settle(row, null, "auto_release");
      } else {
        const ev = c.status === "releasing" ? (c.resolved_by ? "approve" : "auto_release") : (c.resolution === "refund" && c.resolved_by === c.editor ? "cancel_refund" : `resolved_${c.resolution}`);
        // Cuvori's decision carried out here (its first try lost its answer): both sides are told it now, once
        if (ev.startsWith("resolved_")) await announceDecision(row).catch(e => console.error("decision not told", c.id, e && e.message));
        await settle(row, null, ev);
      }
      done.push(c.id);
    } catch (e) { failed.push({ id: c.id, why: e.message }); console.error("auto-release failed for", c.id, e.message); }
  }
  // milestones: submitted with the review window over, or approved by the client but never paid out (provider trouble).
  // Only those of protected Orders that can still pay out: a milestone of an Order paid directly is approved and never
  // has a transfer, and those filled the list for good (audit of 31 October). Oldest first, set aside like the Orders above.
  // (a part the Order no longer holds enough for, after a chargeback the bank decided for the client, is set aside: it can't
  // be paid now, and tried every hour it took a place from the others; check of 2 November)
  const open = (await db.select("contracts", `payment_mode=eq.escrow&status=in.(funded,delivered)&select=id,editor,status,chargeback_status,money_error,amount_cents,funded_cents,released_cents,refunded_cents&order=id.asc&limit=2000`)) || [];
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
  // (such a part is said on its Order once, so a person decides it: check of 6 November, it waited without a word)
  const msHold = async m => { const c = orderOf.get(m.order_id); return chargebackOpen(c) ? "chargeback open" : m.amount_cents > heldCents(c) ? (await noteShortPart(c, m).catch(() => {}), SHORT) : m.status === "submitted" && inquiryOpen(c) && await inquiryStillOpen(c) ? ASKED : null; };
  const msEditor = m => (orderOf.get(m.order_id) || {}).editor;
  await sortOut(msDue.sort(byTime), msEditor, msHold, aside, msInto);
  // (a part the client approved is tried after the others also when its freelancer is banned: its payout may be at Stripe
  // already, its answer lost, and is then counted; no new payout is made while the ban lasts. Check of 7 November)
  await sortOut(msOwed.sort(byTime), msEditor, msHold, aside, msInto, true);
  for (const m of batch(msInto)) {
    if (over("parts")) { waiting++; continue; }
    try {
      const c = await db.contract(m.order_id);
      if (!c || c.payment_mode !== "escrow" || !["funded", "delivered"].includes(c.status)) continue;
      if (chargebackOpen(c)) { skipped.push({ id: m.id, why: "chargeback open" }); continue; }
      // a part the client approved may have its payout at Stripe already (its answer was lost): it is counted whatever the
      // freelancer's ban or account (the payout step finds it before it checks them, and makes no new one while they stop
      // it). Checked first here, while banned, it stayed uncounted, and a decision then recorded amounts that never moved
      // (check of 7 November)
      if (m.status !== "approved") {
        if (await isBanned(c.editor)) { failed.push({ id: m.id, why: "freelancer banned" }); continue; }
        const acct = await orderPayoutAccount(c);
        if (!accountReady(acct)) { failed.push({ id: m.id, why: "freelancer account not ready" }); continue; }
      }
      await releaseMilestone(c, m, null, m.status === "approved" ? "approve" : "auto_release");
      done.push(m.id);
    } catch (e) { failed.push({ id: m.id, why: e.message }); console.error("milestone auto-release failed for", m.id, e.message); }
  }
  // The three chargeback lists below are each read in a fixed order, and worked the one that failed least first; one that has
  // failed for a day is tried after 1, 2, 4, 8 and 16 hours, then daily (retryOrder). Before, each took any 20 Orders, so 20
  // that failed for ever (re-payments to banned freelancers, say) hid every later one (check of 2 November).
  const list = async (kind, query, keep) => {
    const rows = await db.select("contracts", `${query}&order=id.asc&limit=${RETRY_READ}`).catch(() => null);
    return retryOrder(kind, (rows || []).filter(keep), { whole: !!rows && rows.length < RETRY_READ });
  };
  const still = async (id, which) => { const x = await db.contract(id).catch(() => null); return !!x && which(x); };
  // chargebacks whose pull-back from the freelancer did not go through at the time (provider said no, or did not answer)
  const pullBack = (x) => String(x.money_error || "").startsWith("chargeback:");
  const pullBacks = await list("pullback", "chargeback_status=eq.open&payment_mode=eq.escrow&money_error=like.chargeback:*&select=id,chargeback_id,money_error", pullBack);
  for (const c of pullBacks.list) {
    if (over("chargebacks")) { waiting++; continue; }
    try { const r = await coverChargeback(c.id, c.chargeback_id); done.push(c.id); await (r && pullBack(r) ? pullBacks.failed(c.id) : pullBacks.ok(c.id)); }
    catch (e) { failed.push({ id: c.id, why: e.message }); console.error("pull-back retry failed for", c.id, e.message); await pullBacks.failed(c.id); }
  }
  // freelancers still owed a re-payment after a won chargeback (the provider could not pay at the time), also while the
  // Order still holds money for its other parts (check of 2 November: waiting for the Order to close could freeze it)
  const repayOwed = (x) => String(x.money_error || "").startsWith("chargeback won");
  const owed = await list("repay", "chargeback_status=eq.won&payment_mode=eq.escrow&money_error=like.chargeback%20won*&select=*", repayOwed);
  for (const c of owed.list) {
    if (over("chargebacks")) { waiting++; continue; }
    try {
      if (await repayWon(c)) { done.push(c.id); await owed.ok(c.id); }
      else if (await still(c.id, repayOwed)) { failed.push({ id: c.id, why: c.money_error }); await owed.failed(c.id); }
      else await owed.ok(c.id);
    }
    catch (e) { failed.push({ id: c.id, why: e.message }); console.error("re-payment retry failed for", c.id, e.message); await owed.failed(c.id); }
  }
  // Cuvori's decisions not told to both sides yet (the database refused it at the time): told now, once
  if (!over("chargebacks")) { try { await tellDecisions(); } catch (e) { console.error("telling decisions failed", e && e.message); } }
  // parts whose payout is in the books but whose "paid out" mark could not be saved then: marked now (check of 8 November)
  if (!over("chargebacks")) { try { await markCountedParts(); } catch (e) { console.error("marking counted parts failed", e && e.message); } }
  // the bank's inquiries noted on any Order, also one closed or paid out already (the lists above only look at Orders still
  // waiting for their automatic release): Stripe is asked, and one that ended without a notice, or was noted after it had
  // ended (its notices came out of order), has its note removed (check of 7 November: such a note stayed for good)
  const asked = await list("inquiry", `payment_mode=eq.escrow&money_error=like.${encodeURIComponent("*" + INQUIRY_HEAD + "*")}&select=*`, inquiryOpen);
  for (const c of asked.list) {
    if (over("chargebacks")) { waiting++; continue; }
    try { await ((await inquiryStillOpen(c)) ? asked.failed(c.id) : asked.ok(c.id)); }
    catch (e) { failed.push({ id: c.id, why: "inquiry: " + e.message }); console.error("checking an inquiry failed for", c.id, e.message); await asked.failed(c.id); }
  }
  // a second chargeback noted on an Order whose recorded one is decided (Stripe could not be asked at the time, or the
  // re-payment above had to go first): taken over now, so it is handled and the Order's money moves again once it is. (One
  // still waiting for that re-payment has nothing to do this hour; one whose note is still there after its try counts as
  // failing.) And one taken over that could not be finished (recorded, then one database answer did not come): it is the
  // Order's open chargeback and its note still names it; finished now (check of 6 November: frozen for good).
  const otherCb = (x) => hasNote(x.money_error, n => OTHER_CB.test(n)) && (x.chargeback_status !== "open" || takeoverUnfinished(x));
  const noted = await list("nextcb", `chargeback_status=in.(won,lost,open)&payment_mode=eq.escrow&money_error=like.${encodeURIComponent("*chargeback *also*on payment *")}&select=id,money_error,chargeback_status,chargeback_id`, x => otherCb(x) && !repayOwed(x));
  for (const c of noted.list) {
    if (over("chargebacks")) { waiting++; continue; }
    try { await nextChargeback(c.id); done.push(c.id); await ((await still(c.id, otherCb)) ? noted.failed(c.id) : noted.ok(c.id)); }
    catch (e) { failed.push({ id: c.id, why: "next chargeback: " + e.message }); console.error("taking over the next chargeback failed for", c.id, e.message); await noted.failed(c.id); }
  }
  // first payments counted on their Order whose ledger line could not be saved: added from Stripe's record, and their
  // card-fee surplus sent back (refunds, a chargeback and the surplus all go by that line)
  let linesAdded = 0, feesSettled2 = 0;
  // (each of these repairs works through a short list; one that would start too late waits for the next run)
  const repair = async (why, fn) => { if (over("repairs")) { waiting++; return null; } try { const r = await fn(); failed.push(...r.failed); return r; } catch (e) { failed.push({ id: null, why: why + ": " + e.message }); console.error(why + " check failed", e.message); return null; } };
  linesAdded += ((await repair("first payment lines", repairFirstLines)) || {}).added || 0;
  // top-ups at today's prices counted on their Order whose ledger line could not be saved: the same, from Stripe's record
  linesAdded += ((await repair("top-up lines", repairTopupLines)) || {}).added || 0;
  // payout lines (a milestone's payout, a re-payment after a won chargeback) that could not be saved: added the same way
  linesAdded += ((await repair("payout lines", repairPayoutLines)) || {}).added || 0;
  // Orders at the new prices: any ledger line of any kind their totals count but their books don't show (a top-up, a payout,
  // a pull-back, a refund, a lost chargeback), added from Stripe's record, so the ledger check's line_missing clears by itself
  linesAdded += ((await repair("ledger lines (new prices)", repairPlan2Lines)) || {}).added || 0;
  // Orders in parts that hold nothing any more and are owed nothing, still open (their last payout's closing write was not
  // answered, or a chargeback took the money for the parts left): closed, both price plans (check of 2 November)
  await repair("Orders that hold nothing", closeEmptyOrders);
  // late payments charged but not back on the card yet (Stripe refused the refund, or did not answer): tried again until
  // the money is back; Stripe itself stops sending them again after about 3 days. Before the card fees below: a client's
  // whole payment goes back before anyone's card-fee surplus or Cuvori's own fee records (check of 2 November)
  const lateRefunded = ((await repair("late payments", retryLateRefunds)) || {}).done || 0;
  // and Stripe's real fee on their payments (Cuvori's cost: nothing goes back to the client for card costs), once it is known
  // (with its own time check inside: one payment at a time, what is left waits for the next run)
  // (what Stripe says about its Fees report is read once for the whole run, for both fee loops: feeOnce)
  const feeOnce = {};
  const fees2 = await repair("fees (new prices)", () => recordPlan2Fees(() => over("repairs"), feeOnce));
  feesSettled2 = (fees2 || {}).done || 0;
  if (fees2) waiting += fees2.waiting || 0;
  // payments whose processing-fee surplus has not gone back to the card yet (the provider's fee was not known at the
  // time, or the refund failed); older than a couple of minutes so it never races the payment being recorded
  // (the 200 oldest and the 50 newest: payments that can never settle, a charged-back one, never keep a newer one from being
  // looked at; what has failed least goes first, and one that has failed for a day waits longer each time)
  let feesSettled = 0;
  const feeRows = async (dir, n) => (await db.select("order_payments", `kind=eq.fund&status=eq.succeeded&provider=eq.stripe&fee_refund_cents=is.null&created_at=lt.${encodeURIComponent(ago(2))}&select=*&order=created_at.${dir}&limit=${n}`).catch(() => [])) || [];
  const feeTries = await retryStates("fee");
  const unsettled = [...new Map([...(await feeRows("asc", 200)), ...(await feeRows("desc", 50)).reverse()].map(r => [r.id, r])).values()]
    .filter(r => retryDue(feeTries.get(r.id))).sort((a, b) => retryTries(feeTries.get(a.id)) - retryTries(feeTries.get(b.id)));
  for (const row of unsettled) {
    if (over("repairs")) { waiting++; continue; }
    const st = feeTries.get(row.id);
    try {
      const c = await db.contract(row.order_id); if (!c) continue;
      if ((await settleFee(c, row, feeOnce)) !== "pending") { feesSettled++; await retryDone("fee", row.id, st); }
      else if (Date.now() - Date.parse(row.created_at) > FEE_WAIT_MS) {
        await retryLater("fee", row.id, st).catch(() => {});                            // 4 days and Stripe's fee still not known: counts as failing
        await noteFeeUnknown(c, row).catch(e => console.error("fee note", c.id, e && e.message));   // and the Order says so, once
      }
    }
    catch (e) { failed.push({ id: row.order_id, why: "fee: " + e.message }); console.error("fee settle retry failed for", row.order_id, e.message); await retryLater("fee", row.id, st).catch(() => {}); }
  }
  // money Stripe still holds apart for closed Orders (funds segregation; nothing to do for an Order never paid that way)
  const heldApart = await repair("money held apart", () => sweepHeldApart(() => over("repairs")));
  if (heldApart) waiting += heldApart.waiting || 0;
  return json(200, { released: done, failed: failed.length, failures: failed.slice(0, 20), skipped, expired, feesSettled: feesSettled + feesSettled2, linesAdded, lateRefunded, waiting,
    ...(heldApart && heldApart.done ? { heldApartReleased: heldApart.done } : {}) });
};
