// Three refusals the person reads in their own language. "The card payment is still settling", "the freelancer's Stripe
// account is not ready" and "a card chargeback is open" were sent to the page as an English sentence with no code, so the
// page showed that sentence as it was: a client using Cuvori in Lithuanian or German who pressed Release, a freelancer who
// pressed Cancel & refund, or the admin deciding a dispute read English. Now every copy of these three refusals carries a
// code the page translates ("settling", "freelancer_not_ready", "chargeback_open"); the English sentence stays for the
// Order's note and the admin. The page has the words in all 7 languages.
// E1 release while the money is still settling, E2 a refund while it is still settling, E3 the freelancer's account
// can't take the payout, E4 the account check before a release (whole Order and milestone), E5 a chargeback open (release,
// cancel, decision), E6 a refund Stripe refuses because the payment was charged back, E7 the page's words in 7 languages,
// E8 what stays as it was.
// Run: node tests/attack-error-codes.mjs
import fs from "node:fs";
import { DB, STRIPE, hooks, req, call, mk, reset, fns, fund, uuid } from "./fn-harness.mjs";
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const fx = await fns();
const said = (r) => `${r.status} ${JSON.stringify(r.json)}`;
const coded = (r, code) => r.status === 409 && r.json && r.json.code === code && typeof r.json.error === "string" && r.json.error.length > 0;
const stripeSays = (path, status, error) => { hooks.stripe = async (p, method) => (p === path && method === "POST") ? [status, { error }] : null; };
const funded = async (extra) => { const c = mk({ amount_cents: 10000, ...(extra || {}) }); await fund(fx, c); c.status = "delivered"; return c; };
const SETTLING = { type: "invalid_request_error", code: "balance_insufficient", message: "You have insufficient available funds in your Stripe account." };

{ // E1 the client presses Release while the card payment is still settling at Stripe
  const c = await funded(); stripeSays("/transfers", 400, SETTLING);
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  vuln(!coded(r, "settling") || c.status !== "releasing", `E1 Release while the money is still settling -> ${said(r)}; Order ${c.status} (must carry the code "settling"; the Order waits in "releasing" for the hourly run)`);
  reset();
}
{ // E2 the freelancer gives the money back while the payment is still settling
  const c = await funded(); stripeSays("/refunds", 400, SETTLING);
  const r = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
  vuln(!coded(r, "settling"), `E2 Cancel & refund while the money is still settling -> ${said(r)} (must carry the code "settling")`);
  reset();
}
{ // E3 Stripe refuses the payout: the freelancer's account can't take transfers
  const c = await funded(); stripeSays("/transfers", 400, { type: "invalid_request_error", code: "insufficient_capabilities_for_transfer", message: "Your destination account needs to have at least one of the following capabilities enabled: transfers" });
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  vuln(!coded(r, "freelancer_not_ready"), `E3 Release when Stripe says the freelancer's account can't take it -> ${said(r)} (must carry the code "freelancer_not_ready")`);
  reset();
}
{ // E4 the account check before a release: the freelancer's Stripe account can't receive payouts right now
  const acct = STRIPE.accounts.acct_1EditorAAAAAAAA, was = acct.payouts_enabled;
  const c = await funded(); acct.payouts_enabled = false;
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  acct.payouts_enabled = was; reset();
  const d = await funded({ has_milestones: true }); const m = { id: uuid(), order_id: d.id, title: "Part 1", amount_cents: 10000, status: "submitted", position: 1 }; DB.order_milestones.push(m);
  acct.payouts_enabled = false;
  const rm = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: d.id, milestone_id: m.id } }));
  acct.payouts_enabled = was;
  vuln(!coded(r, "freelancer_not_ready") || !coded(rm, "freelancer_not_ready"), `E4 Release when the freelancer's account isn't ready -> whole Order ${said(r)}; one milestone ${said(rm)} (both must carry the code "freelancer_not_ready")`);
  reset();
}
{ // E5 a card chargeback is open on the Order: Release, Cancel & refund and the admin's decision all wait for the bank
  const c = await funded(); Object.assign(c, { chargeback_status: "open", chargeback_id: "dp_E5" });
  const rel = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const can = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
  c.status = "disputed";
  const dec = await call(fx.resolve, req("POST", "x", { token: "tok_adm", body: { contract_id: c.id, decision: "refund" } }));
  vuln(!coded(rel, "chargeback_open") || !coded(can, "chargeback_open") || !coded(dec, "chargeback_open"),
    `E5 a chargeback is open -> Release ${said(rel)}; Cancel & refund ${said(can)}; the admin's decision ${said(dec)} (each must carry the code "chargeback_open")`);
  reset();
}
{ // E6 the refund is refused by Stripe because the payment was charged back meanwhile
  const c = await funded(); stripeSays("/refunds", 400, { type: "invalid_request_error", code: "charge_disputed", message: "Charge ch_x has been charged back; cannot issue a refund." });
  const r = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
  vuln(!coded(r, "chargeback_open"), `E6 Cancel & refund when Stripe says the payment was charged back -> ${said(r)} (must carry the code "chargeback_open")`);
  reset();
}
{ // E7 the page has the words for the three codes, in all 7 languages, and uses them on every button (not only Fund)
  const root = process.env.TARGET || new URL("..", import.meta.url).pathname.replace(/\/$/, "");
  const page = fs.readFileSync(root + "/index.html", "utf8");
  const count = (key) => (page.match(new RegExp(`\\b${key}:"[^"]+"`, "g")) || []).length;
  const plain = (page.match(/function fnPlain\(e,pay\)\{[\s\S]*?\n  \}/) || [""])[0];
  const maps = { settling: /e\.code==="settling"\)\s*return t\("es_settling"\)/.test(plain), chargeback: /e\.code==="chargeback_open"&&!pay\)\s*return t\("fn_chargebackOpen"\)/.test(plain), notReady: /e\.code==="freelancer_not_ready"\)\s*return t\(pay\?"o_flNotReady":"fn_flNotReady"\)/.test(plain) };
  vuln(count("es_settling") !== 7 || count("fn_chargebackOpen") !== 7 || count("fn_flNotReady") !== 7 || !maps.settling || !maps.chargeback || !maps.notReady,
    `E7 the page's words: es_settling ${count("es_settling")}, fn_chargebackOpen ${count("fn_chargebackOpen")}, fn_flNotReady ${count("fn_flNotReady")} languages (each must be 7); used for the codes: ${JSON.stringify(maps)}`);
}
{ // E8 what stays as it was: a normal release and a normal cancel; the Order's note keeps Cuvori's English sentence for the admin
  const c = await funded();
  const r = await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id } }));
  const d = await funded();
  const k = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: d.id } }));
  const e = await funded(); stripeSays("/transfers", 400, SETTLING);
  await call(fx.release, req("POST", "x", { token: "tok_cl", body: { contract_id: e.id } })); reset();
  vuln(r.status !== 200 || c.status !== "completed" || k.status !== 200 || d.status !== "refunded" || !/still settling/.test(String(e.money_error)),
    `E8 normal: Release -> ${r.status}, Order ${c.status}; Cancel & refund -> ${k.status}, Order ${d.status}; the settling Order's note: ${JSON.stringify(e.money_error)} (must be 200 completed, 200 refunded, and the note in Cuvori's words)`);
  reset();
}

console.log(out.join("\n"));
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(bad ? 1 : 0);
