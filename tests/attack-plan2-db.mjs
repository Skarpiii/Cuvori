// The payment code for the new prices, checked by the real database: every Order of tests/attack-plan2.mjs (its
// scenarios and the hundreds of runs with a failure at each write) is loaded into a local Postgres with schema v56, every
// ledger line going in through v56's own rules as the payment code's requests would (tests/ledger-db-check.mjs), and the
// database's ledger check, admin_pricing_check, is run over all of them.
//   D1 no ledger line written by the payment code is refused by the database (entry key, one Stripe object of its kind,
//      a payout's commission and amount sent, the notes of re-payments and pull-backs, each Stripe object once)
//   D2 for every Order, the database's ledger check lists exactly what the suite's own JavaScript copy of it expected
//      (so the cases the suite calls clean are clean in the real database too, and the ones it lists, it lists)
//   D3 the commission total the database adds up from the payout lines is the one the Order showed in the suite
// Run: node tests/attack-plan2-db.mjs   (needs the local Postgres of tests/db; runs tests/attack-plan2.mjs first)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkLedgerInDb } from "./ledger-db-check.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const snapFile = path.join(fs.mkdtempSync("/tmp/cuvori-plan2-db-"), "snapshot.json");
const run = spawnSync("node", [path.join(root, "tests/attack-plan2.mjs")], { env: { ...process.env, PLAN2_SNAPSHOT: snapFile }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const suiteLast = (run.stdout || "").trim().split("\n").pop();
if (!fs.existsSync(snapFile)) {
  console.log(`VULNERABLE the plan 2 suite left no snapshot (${suiteLast})\n\n1 vulnerable, 0 safe`);
  process.exit(1);
}
const snap = JSON.parse(fs.readFileSync(snapFile, "utf8"));
const expected = snap.expected; delete snap.expected;
const plan2 = snap.contracts.filter(c => Number(c.pricing_version) >= 2 && c.payment_mode === "escrow");
const r = await checkLedgerInDb(snap, { pricingVersion: null });                  // an Order that names no plan is from before v56
{ // D1
  const byWhy = {};
  for (const x of r.refused) byWhy[x.error || x.code] = (byWhy[x.error || x.code] || 0) + 1;
  vuln(r.refused.length > 0,
    `D1 ${snap.order_payments.length} ledger lines of ${snap.contracts.length} Orders (${plan2.length} at the new prices) put into the database through v56's rules -> ${r.refused.length ? "REFUSED " + r.refused.length + ": " + Object.entries(byWhy).map(([k, n]) => `${k} x${n}`).join("; ") + " — first: " + JSON.stringify(r.refused[0]).slice(0, 240) : "none refused"} (must be none refused)`);
}
{ // D2
  const got = {};
  for (const p of r.problems) (got[p.order] = got[p.order] || []).push(p.problem);
  for (const d of r.to_decide) (got[d.order] = got[d.order] || []).push("to_decide:" + d.item);
  const differ = [];
  for (const c of snap.contracts) {
    const g = [...new Set(got[c.id] || [])].sort().join(","), e = [...new Set(expected[c.id] || [])].sort().join(",");
    if (g !== e) differ.push(`${c.id.slice(0, 8)} (${c.status}${c.chargeback_status ? ", chargeback " + c.chargeback_status : ""}): database [${g}], suite [${e}]`);
  }
  const kinds = {};
  for (const c of snap.contracts) for (const k of new Set(got[c.id] || [])) kinds[k] = (kinds[k] || 0) + 1;
  vuln(differ.length > 0,
    `D2 the database's ledger check over every Order -> ${differ.length ? differ.length + " DIFFER: " + differ.slice(0, 4).join("; ") : "the same as the suite's for every Order"}; listed: ${Object.entries(kinds).map(([k, n]) => `${k} x${n}`).join(", ") || "nothing"} (must be the same for every Order)`);
}
{ // D3
  const differ = [];
  for (const c of plan2) {
    const db = (r.counters || {})[String(c.id).toLowerCase()];
    if (!db || Number(db.commission_cents || 0) !== Number(c.commission_cents || 0)) differ.push(`${c.id.slice(0, 8)}: suite ${c.commission_cents}, database ${db ? db.commission_cents : "missing"}`);
  }
  vuln(differ.length > 0, `D3 the commission total the database adds up from the payout lines, for ${plan2.length} Orders at the new prices -> ${differ.length ? differ.length + " DIFFER: " + differ.slice(0, 4).join("; ") : "the same as the suite's for every Order"} (must be the same)`);
}
console.log(`(the plan 2 suite itself: ${suiteLast})`);
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
