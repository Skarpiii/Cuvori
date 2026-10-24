// The card-fee row can't be set below what cards really cost (schema v53).
// The client pays the card fee from the fee table; the checkout quotes with no country, so the ANY row is the ceiling every
// client pays up front, and what was collected above Stripe's real card cost goes back to the client afterwards (settleFee).
// An admin could set that row below Stripe's real rate (a typo, or Stripe raised its prices): the refund then had nothing
// to give back and Cuvori paid the difference on every payment, shown only afterwards on the admin page. Now saving such a
// row is refused when it would have collected less than Stripe really took on any payment settled in the last 12 months,
// with the payment named; no rate lives in code. Rows that don't decide the checkout price are saved as before.
// F1 lowering the ANY row below a real card cost, F2 raising it (normal), F3 a row that doesn't decide the checkout price
// (normal), F4 a new ANY row below the floor, F5 what doesn't count: old payments, unsettled payments, a row set to
// platform or switched off (normal), F6 a client trying (normal), F7 running v53, F8 a row that did not decide the price
// changed into one that does. Every check is rolled back.
// Run: node tests/attack-fee-floor.mjs   (needs the local Postgres of tests/db; it is started here)
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const PGDIR = process.env.PGDIR || "/tmp/cuvori-pgtest";
const PSQL = ["-h", PGDIR, "-p", "5499", "-U", "postgres", "-d", "cuvori", "-At", "-v", "ON_ERROR_STOP=1"];

// the database as the test runner builds it: the same files, in the same order
const runAll = fs.readFileSync(path.join(root, "tests/run-all.sh"), "utf8");
const EXTRA = (runAll.match(/EXTRA="([^"]+)"/) || [])[1] || "";
const MIGRATE = (runAll.match(/MIGRATE="([^"]+)"/) || [])[1] || "";
spawnSync("tar", ["--skip-old-files", "-xzf", "tests/test-kit.tar.gz"], { cwd: root });
execFileSync("bash", [path.join(root, "tests/db/start-pg.sh")], { stdio: "ignore" });
execFileSync("bash", [path.join(root, "tests/db/load.sh")], { env: { ...process.env, EXTRA, PGOPTIONS: "-c client_min_messages=warning" }, stdio: "ignore" });
for (const f of ["tests/db/10_harness.sql", "tests/db/20_seed.sql", ...MIGRATE.split(/\s+/).filter(Boolean).map(m => `supabase/${m}`)])
  execFileSync("psql", [...PSQL, "-q", "-f", path.join(root, f)], { env: { ...process.env, PGOPTIONS: "-c client_min_messages=warning" }, stdio: "ignore" });

const env = { ...process.env, PGOPTIONS: "-c client_min_messages=warning" };
const run = (sql) => { const r = spawnSync("psql", [...PSQL], { input: sql, encoding: "utf8", env }); return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() }; };
const U = (n) => `t.u('${n}')`;
const as = (who) => `set local role authenticated; select set_config('request.jwt.claim.sub', ${U(who)}::text, true);`;
const owner = "reset role; select set_config('request.jwt.claim.sub', '', true);";
// the test table: EEA 1.5% + 25c (id 1), INTL 3.25% + 25c (id 2), ANY 3.25% + 25c (id 3, the ceiling), connect 0.25% + 210c (id 4).
// One settled payment of EUR 100 (+ EUR 2.35 payout fee) on which Stripe took EUR 4.00 in card fees, paid in last month.
const O = "'30000000-0000-0000-0000-000000000003'";
const SETUP = `
  insert into public.order_payments (order_id, kind, amount_cents, fee_cents, connect_cents, provider, provider_ref, status, provider_fee_cents, fee_refund_cents, created_at)
    values (${O}, 'fund', 10000, 370, 235, 'stripe', 'pi_floor8d1', 'succeeded', 400, 0, now() - interval '30 days');
`;
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /^(psql:.*)?ERROR/.test(x)) || r.err.split("\n")[0] || "").replace(/^.*ERROR:\s*/, "")); };
const tx = (body) => run(`begin;\n${SETUP}\n${body}\nrollback;\n`);
{ const r = tx(`select 'setup: ok';`); if (pick(r, "setup") !== "ok") { console.log("the test's set-up failed: " + r.err); process.exit(1); } }
const SAVE = (label, who, json) => `${as(who)} select '${label}: ' || public.admin_set_fee_schedule('${json}'::jsonb); ${owner}`;
const ROW = (id, label) => `select '${label}: ' || percent || '% + ' || fixed_cents || 'c, ' || payer || case when active then '' else ', off' end from public.fee_schedules where id = ${id};`;
const refused = (s) => s.startsWith("not saved");
const short = (s) => s.slice(0, 150);

{ // F1 the admin lowers the ANY row below what that card really cost
  // at 1.5% + 25c on a EUR 102.35 base: ceil(10260 / 0.985) - 10235 = 182 cents, but Stripe took 400
  const r = tx(`${SAVE("low", "401", '{"id":3,"percent":1.5,"fixed_cents":25}')} ${ROW(3, "row")}
    ${SAVE("typo", "401", '{"id":3,"percent":0.325}')} ${ROW(3, "row2")}`);
  vuln(!refused(pick(r, "low")) || !/EUR 1\.82 .* EUR 102\.35 .* EUR 4\.00/.test(pick(r, "low")) || pick(r, "row") !== "3.2500% + 25c, client"
       || !refused(pick(r, "typo")) || pick(r, "row2") !== "3.2500% + 25c, client",
    `F1 the admin sets the ANY row to 1.5% + 25c, below the EUR 4.00 Stripe took on a EUR 102.35 payment last month -> ${short(pick(r, "low"))}; the row: ${pick(r, "row")}; a typo (0.325% instead of 3.25%) -> ${refused(pick(r, "typo")) ? "refused" : pick(r, "typo")} (must be refused with the payment named; the row unchanged)`);
}
{ // F2 raising it, or keeping it where it covers the cost, works
  // at 3.25% + 25c: ceil(10260 / 0.9675) - 10235 = 371 < 400: today's row is itself below that card's cost, so 3.25% is refused too;
  // 4% + 25c: ceil(10260 / 0.96) - 10235 = 453 >= 400
  const r = tx(`${SAVE("same", "401", '{"id":3,"percent":3.25,"fixed_cents":25}')} ${SAVE("up", "401", '{"id":3,"percent":4,"fixed_cents":25}')} ${ROW(3, "row")}
    ${SAVE("fixed", "401", '{"id":3,"percent":3.25,"fixed_cents":60}')} ${ROW(3, "row2")}`);
  vuln(!refused(pick(r, "same")) || pick(r, "up") !== "ok" || pick(r, "row") !== "4.0000% + 25c, client" || pick(r, "fixed") !== "ok" || pick(r, "row2") !== "3.2500% + 60c, client",
    `F2 saving 3.25% + 25c again (it was short by 29c on that payment) -> ${short(pick(r, "same"))}; 4% + 25c -> ${pick(r, "up")}, the row: ${pick(r, "row")}; 3.25% + 60c (covers it through the fixed part) -> ${pick(r, "fixed")} (normal: a row that covers the cost is saved)`);
}
{ // F3 rows that don't decide the checkout price are saved as before: the EEA row (shown as "what comes back"), a country row, a consumer row
  const r = tx(`${SAVE("eea", "401", '{"id":1,"percent":1.4,"fixed_cents":25}')} ${SAVE("country", "401", '{"region":"EEA","country":"DE","percent":1.2,"fixed_cents":25}')}
    ${SAVE("consumer", "401", '{"region":"ANY","customer_kind":"consumer","percent":1,"fixed_cents":0}')} ${SAVE("connect", "401", '{"id":4,"percent":0.2,"fixed_cents":200}')}`);
  vuln(pick(r, "eea") !== "ok" || pick(r, "country") !== "ok" || pick(r, "consumer") !== "ok" || pick(r, "connect") !== "ok",
    `F3 rows the checkout never quotes with: the EEA row at 1.4% -> ${pick(r, "eea")}; a new DE row at 1.2% -> ${pick(r, "country")}; a consumer row at 1% -> ${pick(r, "consumer")}; the payout-fee row lowered -> ${pick(r, "connect")} (normal: all saved)`);
}
{ // F4 a new ANY card row below the floor (a second ceiling row, method card) is refused too; one above it is saved
  const r = tx(`${SAVE("newlow", "401", '{"region":"ANY","method":"card","percent":2,"fixed_cents":25}')} ${SAVE("newok", "401", '{"region":"ANY","method":"card","percent":4,"fixed_cents":30}')}
    select 'rows: ' || count(*) from public.fee_schedules where region = 'ANY' and method = 'card';`);
  vuln(!refused(pick(r, "newlow")) || pick(r, "newok") !== "ok" || pick(r, "rows") !== "1",
    `F4 a new ANY card row at 2% + 25c -> ${short(pick(r, "newlow"))}; at 4% + 30c -> ${pick(r, "newok")}; ANY card rows now: ${pick(r, "rows")} (must be: refused, saved, 1)`);
}
{ // F5 what doesn't count: a payment older than 12 months, one whose card cost Stripe hasn't reported yet, a row set to platform or switched off
  const old = tx(`update public.order_payments set created_at = now() - interval '13 months' where provider_ref = 'pi_floor8d1'; ${SAVE("old", "401", '{"id":3,"percent":1.5,"fixed_cents":25}')}`);
  const unsettled = tx(`update public.order_payments set provider_fee_cents = null where provider_ref = 'pi_floor8d1'; ${SAVE("unsettled", "401", '{"id":3,"percent":1.5,"fixed_cents":25}')}`);
  const off = tx(`${SAVE("platform", "401", '{"id":3,"percent":1.5,"fixed_cents":25,"payer":"platform"}')} ${SAVE("inactive", "401", '{"id":3,"percent":1.5,"fixed_cents":25,"payer":"client","active":false}')}
    ${SAVE("backon", "401", '{"id":3,"active":true}')} ${ROW(3, "row")}`);
  vuln(pick(old, "old") !== "ok" || pick(unsettled, "unsettled") !== "ok" || pick(off, "platform") !== "ok" || pick(off, "inactive") !== "ok" || !refused(pick(off, "backon")) || pick(off, "row") !== "1.5000% + 25c, client, off",
    `F5 the same lowering when the payment is 13 months old -> ${pick(old, "old")}; when Stripe has not reported its cost yet -> ${pick(unsettled, "unsettled")}; set to payer = platform -> ${pick(off, "platform")}; switched off -> ${pick(off, "inactive")}; switching it back on at 1.5% -> ${refused(pick(off, "backon")) ? "refused" : pick(off, "backon")}, the row: ${pick(off, "row")} (normal: ok, ok, ok, ok, refused)`);
}
{ // F6 not an admin
  const r = tx(`${SAVE("client", "101", '{"id":3,"percent":4}')} ${ROW(3, "row")}`);
  vuln(pick(r, "client") !== "forbidden" || pick(r, "row") !== "3.2500% + 25c, client",
    `F6 a client tries to change the table -> ${pick(r, "client")}; the row: ${pick(r, "row")} (normal: forbidden)`);
}
{ // F7 running v53 (twice: the SQL editor may be run again)
  const f = path.join(root, "supabase/schema_v53.sql");
  if (!fs.existsSync(f)) vuln(true, "F7 supabase/schema_v53.sql is missing, so the live fee table can still be set below what cards cost");
  else {
    const r = tx(`\\i ${f}
\\i ${f}
      ${SAVE("low", "401", '{"id":3,"percent":1.5,"fixed_cents":25}')} ${SAVE("up", "401", '{"id":3,"percent":4,"fixed_cents":25}')}`);
    const rows = r.out.split("\n").filter(l => /^v53 /.test(l));
    vuln(!r.ok || rows.length !== 2 || !rows.every(l => /^v53 applied/.test(l)) || !refused(pick(r, "low")) || pick(r, "up") !== "ok",
      `F7 running v53 twice -> ${r.ok ? rows.map(l => `"${l.slice(0, 60)}"`).join(" then ") || "no result row" : "error: " + r.err.split("\n").find(x => /ERROR/.test(x))}; then 1.5% -> ${refused(pick(r, "low")) ? "refused" : pick(r, "low")}, 4% -> ${pick(r, "up")}`);
  }
}
{ // F8 a low row that does not decide the checkout price (a consumer row, method card) is saved, then changed into one that does
  const r = tx(`${SAVE("consumer", "401", '{"region":"ANY","customer_kind":"consumer","method":"card","percent":1,"fixed_cents":0}')}
    ${as("401")} select 'turned: ' || public.admin_set_fee_schedule(jsonb_build_object('id', (select id from public.fee_schedules where customer_kind = 'consumer' and method = 'card'), 'customer_kind', 'any')); ${owner}
    select 'row: ' || customer_kind || ' ' || percent from public.fee_schedules where method = 'card' and region = 'ANY' and country is null;`);
  vuln(pick(r, "consumer") !== "ok" || !refused(pick(r, "turned")) || pick(r, "row") !== "consumer 1.0000",
    `F8 a 1% consumer card row (does not decide the price) -> ${pick(r, "consumer")}; then changed to any customer, so it would decide it -> ${short(pick(r, "turned"))}; the row: ${pick(r, "row")} (must be: saved, refused, still consumer)`);
}
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
