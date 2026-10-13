// A change by either person waits while a payment step is running on the Order (schema v34). The payment functions take
// a lock on an Order (a row 'lock:<order id>' in money_keys) while they move its money; a price change, a cancel or a
// dispute saved at that very moment used to slip through, and the card payment then no longer fitted the Order: it went
// back minus Stripe's fee. This loads the database files the test runner lists (tests/run-all.sh) into a local Postgres
// and plays both sides, a person acting through the database and a payment step holding the lock.
// L1–L4 a change refused while a payment step holds the lock, L5–L8 what is never held back, L9 both at the same moment,
// L10 the page's message.
// Run: node tests/attack-payment-lock.mjs   (needs the local Postgres of tests/db; it is started here)
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
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

const run = (sql) => { const r = spawnSync("psql", [...PSQL, "-c", sql], { encoding: "utf8" }); return { ok: r.status === 0, out: r.stdout.trim(), err: r.stderr.trim() }; };
const one = (sql) => run(sql).out.split("\n")[0];   // the first line: an insert ... returning also prints "INSERT 0 1" after it
const as = (user, sql) => run(`begin; set local role authenticated; select set_config('request.jwt.claim.sub', t.u('${user}')::text, true); ${sql}; commit;`);
const CLIENT = "101", EDITOR = "202", CONV = "10000000-0000-0000-0000-000000000003";
let n = 100;
const order = (status = "accepted", mode = "escrow", funded = 0) => {
  const id = `30000000-0000-0000-0000-${String(++n).padStart(12, "0")}`;
  run(`insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, fee_cents, funded_cents)
       values ('${id}', '${CONV}', t.u('${EDITOR}'), t.u('${CLIENT}'), t.u('${EDITOR}'), 'Lock test', 100, '${status}', '${mode}', 10000, 0, ${funded})`);
  return id;
};
const amendment = (id, delta, extra = "") => one(`insert into public.order_amendments (order_id, proposed_by, note, price_delta_cents${extra ? ", new_deadline" : ""}) values ('${id}', t.u('${EDITOR}'), 'change', ${delta}${extra ? `, '${extra}'` : ""}) returning id`);
const lock = (id, age = "0 seconds") => run(`insert into public.money_keys (scope, key, created_at) values ('lock:${id}', 'claim:test', now() - interval '${age}')`);
const row = (id) => one(`select status || ' ' || amount_cents from public.contracts where id = '${id}'`);
const refused = (r) => !r.ok && /payment_in_progress/.test(r.err);

{ // L1 the client accepts a price increase while the payment step holds the lock
  const id = order(); const a = amendment(id, 1000); lock(id);
  const r = as(CLIENT, `select public.order_amendment_decide('${a}', true)`);
  vuln(!refused(r) || row(id) !== "accepted 10000", `L1 a price increase accepted while a card is being charged -> ${r.ok ? "saved: " + r.out.split("\n").pop() : "refused: " + r.err.split("\n")[0]}; Order now ${row(id)} (must be refused with payment_in_progress, price unchanged)`);
}
{ // L2 a price decrease the same way
  const id = order(); const a = amendment(id, -1000); lock(id);
  const r = as(CLIENT, `select public.order_amendment_decide('${a}', true)`);
  vuln(!refused(r) || row(id) !== "accepted 10000", `L2 a price decrease accepted while a card is being charged -> ${r.ok ? "saved" : "refused"}; Order now ${row(id)} (must be refused, price unchanged)`);
}
{ // L3 the freelancer cancels an unpaid Order while the payment step holds the lock
  const id = order(); lock(id);
  const r = as(EDITOR, `select public.order_action('${id}', 'cancel')`);
  vuln(!refused(r) || row(id) !== "accepted 10000", `L3 the freelancer cancels while a card is being charged -> ${r.ok ? "saved: " + r.out.split("\n").pop() : "refused"}; Order now ${row(id)} (must be refused, still accepted)`);
}
{ // L4 the client opens a dispute on a paid Order while a top-up is being charged
  const id = order("funded", "escrow", 10000); lock(id);
  const r = as(CLIENT, `select public.order_action('${id}', 'dispute', 'not happy')`);
  vuln(!refused(r) || row(id) !== "funded 10000", `L4 a dispute opened while a top-up is being charged -> ${r.ok ? "saved: " + r.out.split("\n").pop() : "refused"}; Order now ${row(id)} (must be refused, still funded)`);
}
{ // L5 no payment step running: the change goes through as before
  const id = order(); const a = amendment(id, 1000);
  const r = as(CLIENT, `select public.order_amendment_decide('${a}', true)`);
  const left = one(`select count(*) from public.money_keys where scope = 'lock:${id}'`);
  vuln(!r.ok || !r.out.split("\n").includes("ok") || row(id) !== "accepted 11000" || left !== "0", `L5 a price increase accepted with no payment running -> ${r.ok ? (r.out.split("\n").includes("ok") ? "ok" : r.out) : r.err.split("\n")[0]}; Order now ${row(id)}; lock rows left behind ${left} (must be saved, nothing left behind)`);
}
{ // L6 a lock left by a step that died (older than 90 seconds) holds nothing back, and goes
  const id = order(); const a = amendment(id, 1000); lock(id, "2 minutes");
  const r = as(CLIENT, `select public.order_amendment_decide('${a}', true)`);
  const left = one(`select count(*) from public.money_keys where scope = 'lock:${id}'`);
  vuln(!r.ok || row(id) !== "accepted 11000" || left !== "0", `L6 a lock left by a step that died 2 minutes ago -> ${r.ok ? "saved" : "refused: " + r.err.split("\n")[0]}; Order now ${row(id)}; that lock removed: ${left === "0"}`);
}
{ // L7 the payment functions themselves (no signed-in person) record the payment while they hold the lock
  const id = order(); lock(id);
  const r = run(`update public.contracts set status = 'funded', funded_cents = 10000 where id = '${id}'`);
  vuln(!r.ok || row(id) !== "funded 10000", `L7 the payment step records the payment while it holds the lock -> ${r.ok ? "saved" : "refused: " + r.err.split("\n")[0]}; Order now ${row(id)} (must be saved)`);
}
{ // L8 what never touches a payment: a direct Order, and a change of the deadline only
  const d = order("accepted", "direct"); lock(d);
  const r1 = as(EDITOR, `select public.order_action('${d}', 'cancel')`);
  const e = order(); const a = amendment(e, 0, "2099-01-01"); lock(e);
  const r2 = as(CLIENT, `select public.order_amendment_decide('${a}', true)`);
  const dl = one(`select deadline from public.contracts where id = '${e}'`);
  vuln(!r1.ok || row(d) !== "cancelled 10000" || !r2.ok || dl !== "2099-01-01", `L8 an Order paid directly is cancelled, and a new deadline is accepted, both while a lock is held -> ${r1.ok ? "cancelled" : "refused"} (${row(d)}); deadline ${r2.ok ? dl : "refused"} (both must go through: no money moves through Cuvori there, and a deadline changes no amount)`);
}
{ // L9 both at the same moment: the change is being saved (its transaction still open) when the payment step takes the lock
  const id = order(); const a = amendment(id, 1000);
  const t0 = Date.now();
  const change = spawn("psql", [...PSQL, "-c", `begin; set local role authenticated; select set_config('request.jwt.claim.sub', t.u('${CLIENT}')::text, true); select public.order_amendment_decide('${a}', true); select pg_sleep(2); commit;`]);
  const changed = new Promise(r => change.on("exit", () => r(Date.now() - t0)));
  await new Promise(r => setTimeout(r, 500));
  const step = spawn("psql", [...PSQL, "-c", `insert into public.money_keys (scope, key) values ('lock:${id}', 'claim:step') returning 'lock taken'; select 'price seen ' || amount_cents from public.contracts where id = '${id}';`]);
  let stepOut = ""; step.stdout.on("data", d => stepOut += d);
  const stepped = await new Promise(r => step.on("exit", (code) => r({ code, at: Date.now() - t0 })));
  const changedAt = await changed;
  const seen = (stepOut.match(/price seen (\d+)/) || [])[1];
  vuln(stepped.code !== 0 || stepped.at < changedAt - 50 || seen !== "11000", `L9 the payment step takes the lock while a price increase is being saved -> it ${stepped.code === 0 ? "took the lock" : "failed"} after ${(stepped.at / 1000).toFixed(1)} s, the change was saved after ${(changedAt / 1000).toFixed(1)} s; price the payment step then sees: ${seen} (must wait for the change and see €110, so the card hold is released with nothing charged)`);
  run(`delete from public.money_keys where scope = 'lock:${id}'`);
}
{ // L10 the page says it in the client's language
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const mapped = /payment_in_progress:"err_paymentInProgress"/.test(html);
  const langs = (html.match(/err_paymentInProgress:"[^"]+"/g) || []).length;
  vuln(!mapped || langs < 7, `L10 the page's message for payment_in_progress -> mapped: ${mapped}; languages with a text: ${langs} (must be all 7)`);
}

console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
