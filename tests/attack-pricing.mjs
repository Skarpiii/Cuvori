// The new prices in the database (schema v56): a 5% commission on the freelancer's paid projects, no client fees, Cuvori
// pays the card costs, and 14 days to review a delivery; switched off until the owner turns them on.
// What must hold:
//   * Orders and ledger lines from before v56 stay exactly as they were, and new Orders keep today's prices (and the
//     7 days) while the switch is off. Orders agreed before the switch keep what they agreed.
//   * Every new Order records the prices in force when it was proposed (the "price plan"): the commission and the review
//     days. Those never change once both sides have accepted. If the switch moved in between, the Order must be read and
//     accepted again.
//   * Clients pay only the agreed price: there is no client fee anywhere, not on the first payment and not on a top-up.
//   * A paid project under the new prices costs at least €2; the €0.50 rule for top-ups stays as it is, on its own.
//   * Every payout records the commission kept, rounded half up to the cent on the running total; the Order's total is
//     kept by the database from the ledger, never by hand; a ledger line under the new prices cannot be changed afterwards.
//   * The 14 days start with a valid delivery (a link to the work); a dispute or an open chargeback stops a part of an
//     Order being paid out until Cuvori (or the bank) decides (a whole Order's payout during an open chargeback is stopped
//     by the payment code, not here); Cuvori's decision (release, refund or divide) still goes through, and 5% is kept
//     only on what the freelancer is paid.
//   * Payment code that does not know the new prices (the 13 October hourly job, or today's code) cannot move money on
//     an Order under the new prices; it keeps working on every other Order.
//   * People read the price breakdown and the money summary of their own Orders only; the reports are for the admin.
// P1 the migration itself, P2 the price plans and the switch, P3 stamping, P4 acceptance, P5 the €2 minimum, P6 the
// ledger, P7 the old payment code, P8 reading, P9 who may call what, P10 undo, P11 the 14 days and disputes.
// Every check after P1 is rolled back.
// Run: node tests/attack-pricing.mjs   (needs the local Postgres of tests/db; it is started here)
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const PGDIR = process.env.PGDIR || "/tmp/cuvori-pgtest";
const PSQL = ["-h", PGDIR, "-p", "5499", "-U", "postgres", "-d", "cuvori", "-At", "-v", "ON_ERROR_STOP=1"];
const env = { ...process.env, PGOPTIONS: "-c client_min_messages=warning" };
const V56 = path.join(root, "supabase/schema_v56.sql");

// The database as the test runner builds it, but first WITHOUT v56: Orders and ledger lines are made the old way,
// then v56 runs on top of them (P1), exactly as it will in Supabase.
const runAll = fs.readFileSync(path.join(root, "tests/run-all.sh"), "utf8");
const EXTRA = ((runAll.match(/EXTRA="([^"]+)"/) || [])[1] || "").split(/\s+/).filter(f => f && f !== "schema_v56.sql").join(" ");
const MIGRATE = (runAll.match(/MIGRATE="([^"]+)"/) || [])[1] || "";
spawnSync("tar", ["--skip-old-files", "-xzf", "tests/test-kit.tar.gz"], { cwd: root });
execFileSync("bash", [path.join(root, "tests/db/start-pg.sh")], { stdio: "ignore" });
execFileSync("bash", [path.join(root, "tests/db/load.sh")], { env: { ...env, EXTRA }, stdio: "ignore" });
for (const f of ["tests/db/10_harness.sql", "tests/db/20_seed.sql", ...MIGRATE.split(/\s+/).filter(Boolean).map(m => `supabase/${m}`)])
  execFileSync("psql", [...PSQL, "-q", "-f", path.join(root, f)], { env, stdio: "ignore" });

const run = (sql) => { const r = spawnSync("psql", [...PSQL], { input: sql, encoding: "utf8", env }); return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() }; };
const runFile = (file) => { const r = spawnSync("psql", [...PSQL, "-f", file], { encoding: "utf8", env }); return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() }; };
// a session that keeps a table busy (an open transaction that has read it), as a payment arriving at that moment would;
// the returned function ends it
const holdTable = (table, seconds = 10) => {
  const p = spawn("psql", [...PSQL], { env: { ...env, PGAPPNAME: "cuvori-hold" }, stdio: ["pipe", "ignore", "ignore"] });
  p.stdin.end(`begin; select count(*) from public.${table}; select pg_sleep(${seconds}); rollback;\n`);
  let seen = false;
  for (let i = 0; i < 60 && !seen; i++) {
    const n = run(`select 'n: ' || count(*) from pg_locks l join pg_class c on c.oid = l.relation join pg_stat_activity a on a.pid = l.pid where c.relname = '${table}' and a.application_name = 'cuvori-hold';`);
    seen = /^n: [1-9]/m.test(n.out);
    if (!seen) spawnSync("sleep", ["0.1"]);
  }
  const end = () => { run("select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'cuvori-hold';"); p.kill(); };
  end.ok = seen;   // the table really was busy (a check that says "it gave way" means nothing otherwise)
  return end;
};
const timed = (fn) => { const t0 = Date.now(); const r = fn(); return { ...r, ms: Date.now() - t0 }; };
// waiting until a session of its own (a click or a payment at that very moment) holds a lock
const holds = (rel, app, mode) => /^n: [1-9]/m.test(run(`select 'n: ' || count(*) from pg_locks l join pg_class c on c.oid = l.relation join pg_stat_activity a on a.pid = l.pid where c.relname = '${rel}' and a.application_name = '${app}' and l.granted and l.mode = '${mode}';`).out);
const waitUntil = (cond) => { for (let i = 0; i < 100; i++) { if (cond()) return true; spawnSync("sleep", ["0.05"]); } return false; };
const endSessions = (prefix) => run(`select pg_terminate_backend(pid) from pg_stat_activity where application_name like '${prefix}%';`);
// how long a file can keep Orders waiting at worst: Postgres waits up to lock_timeout for EACH table it locks
const toMs = (v) => { const m = String(v || "").match(/^(\d+)\s*(ms|s)?$/); return m ? Number(m[1]) * (m[2] === "s" ? 1000 : 1) : NaN; };
const lockWait = (src) => {
  const per = toMs((src.match(/set_config\('lock_timeout', '([^']+)'/) || [])[1]);
  const lock = (src.match(/lock table ([^;]+?) in access exclusive mode/) || [])[1] || "";
  const tables = (lock.match(/public\.[a-z_]+/g) || []).map(t => t.slice(7));
  return { per, tables, worst: per * tables.length };
};
// the payment code gives up on a database request after this long (and then reports the step as failed)
const FN_WAIT_MS = Number((fs.readFileSync(path.join(root, "netlify/lib/cuvori.mjs"), "utf8").match(/rest\/v1\$\{path\}[^\n]*?AbortSignal\.timeout\((\d+)\)/) || [])[1]);
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /^(psql:.*)?ERROR/.test(x)) || r.err.split("\n")[0] || "").replace(/^.*ERROR:\s*/, "")); };
const errOf = (r) => r.ok ? "(no error)" : (r.err.split("\n").find(x => /ERROR/.test(x)) || r.err.split("\n")[0] || "").replace(/^.*ERROR:\s*/, "");
const U = (n) => `t.u('${n}')`;
const as = (who) => who === "anon" ? "set local role anon; select set_config('request.jwt.claim.sub', '', true); select set_config('request.headers', '', true);"
  : `set local role authenticated; select set_config('request.jwt.claim.sub', ${U(who)}::text, true); select set_config('request.headers', '', true);`;
// the payment functions (Netlify, Supabase's service key): with the header the new code sends, or without it (older code)
const svc = (newCode = true) => `set local role service_role; select set_config('request.jwt.claim.sub', '', true); select set_config('request.headers', '${newCode ? '{"x-cuvori-pricing": "2"}' : '{"user-agent": "node"}'}', true);`;
const owner = "reset role; select set_config('request.jwt.claim.sub', '', true); select set_config('request.headers', '', true);";
const NEWCOLS = ["pricing_version", "commission_bps", "commission_cents"];
const NEWPAY = ["entry_key", "commission_cents", "payout_cents", "payout_purpose", "pricing_version"];
const snapContracts = (strip) => `select md5(string_agg((to_jsonb(c)${strip ? NEWCOLS.map(k => ` - '${k}'`).join("") : ""})::text, '|' order by c.id)) from public.contracts c`;
const snapPayments = (strip) => `select md5(string_agg((to_jsonb(p)${strip ? NEWPAY.map(k => ` - '${k}'`).join("") : ""})::text, '|' order by p.id)) from public.order_payments p`;

// ---------- P1 the migration on a database with Orders and money already in it ----------
const O3 = "'30000000-0000-0000-0000-000000000003'", O5 = "'30000000-0000-0000-0000-000000000005'", O6 = "'30000000-0000-0000-0000-000000000006'";
const startData = run(`insert into public.order_payments (order_id, kind, amount_cents, fee_cents, provider, provider_ref, status, note, provider_fee_cents, fee_refund_cents, connect_cents)
     values (${O3}, 'fund', 10000, 325, 'stripe', 'pi_test3', 'succeeded', 'old payment', 180, 145, 35), (${O5}, 'fund', 6000, 205, 'stripe', 'pi_test5', 'succeeded', 'old payment', null, null, null),
            (${O6}, 'fund', 10000, 325, 'stripe', 'pi_test6', 'succeeded', 'old payment', 181, 144, 0), (${O6}, 'release', 4000, 0, 'stripe', 'tr_old6', 'succeeded', 'approve', null, null, null);
     update public.contracts set funded_cents = 10000, released_cents = 4000, quote = '{"total_cents": 10325}' where id = ${O6};
     select 'start: ' || count(*) from public.order_payments where provider_ref in ('pi_test3', 'pi_test5', 'pi_test6', 'tr_old6');`);
// the old money P1 compares must really be there: a failed insert would leave nothing to compare
if (!startData.ok || pick(startData, "start") !== "4") { console.log("P1's starting data could not be written: " + (errOf(startData) || pick(startData, "start"))); process.exit(1); }
const before = { c: pick(run(`select 'c: ' || (${snapContracts(false)});`), "c"), p: pick(run(`select 'p: ' || (${snapPayments(false)});`), "p"),
  n: pick(run(`select 'n: ' || (select count(*) from public.contracts) || '/' || (select count(*) from public.order_payments);`), "n") };
{ // P1f while v56 waits for a busy table, every Order screen and payment step waits behind it: at worst that is never
  // longer than the payment code waits for the database (it would then report a step whose money already moved at Stripe
  // as failed). v56 gives up early instead, with nothing changed, and is simply run again.
  const src = fs.existsSync(V56) ? fs.readFileSync(V56, "utf8") : "";
  const w = lockWait(src);
  const held = holdTable("order_payments");
  // run as it is (no transaction of the test's own around it), so "nothing changed" is really checked
  const r = fs.existsSync(V56) ? timed(() => run(`\\i ${V56}`)) : { ok: true, ms: 0, out: "", err: "" };
  held();
  const nothing = pick(run("select 'gone: ' || (to_regclass('public.pricing_plans') is null);"), "gone");
  // ... and v56 gives up on a busy table before Postgres's deadlock timer runs: in a deadlock v56 is then the one that stops
  // (not a payment's database write after Stripe moved the money)
  const DEADLOCK_MS = toMs(pick(run("select 'd: ' || current_setting('deadlock_timeout');"), "d"));
  vuln(!held.ok || !(w.per < DEADLOCK_MS) || !(w.worst + 3000 <= FN_WAIT_MS) || r.ok || !/lock timeout/.test(errOf(r)) || r.ms > 2500 || nothing !== "true",
    `P1f ${held.ok ? "" : "(the ledger was never made busy: this check proved nothing) "}v56 waits ${w.per} ms for each of ${w.tables.length} tables (${w.worst} ms at worst; the payment code waits ${FN_WAIT_MS} ms, v56 needs time of its own too); with a payment busy on the ledger it -> ${r.ok ? "ran anyway" : errOf(r).slice(0, 60)} after ${r.ms} ms, nothing changed: ${nothing} ; Postgres's deadlock timer ${DEADLOCK_MS} ms (must wait less than it for each table, at most ${FN_WAIT_MS - 3000} ms at worst; stop within 2.5 s with a lock timeout and change nothing)`);
}
// the two functions undo puts back, as they are before v56 (undo must restore exactly these)
const FP = (fn) => `select '${fn}: ' || md5(replace(prosrc, chr(13), '')) from pg_proc where pronamespace = 'public'::regnamespace and proname = '${fn}';`;
const fpBefore = { accept: pick(run(FP("order_accept")), "order_accept"), terms: pick(run(FP("order_terms_snapshot")), "order_terms_snapshot") };
// every function of the database by name and arguments, before v56 (undo must leave exactly these)
const FNS = "select 'fns: ' || md5(string_agg(oid::regprocedure::text, ',' order by oid::regprocedure::text)) from pg_proc where pronamespace = 'public'::regnamespace;";
const fnsBefore = pick(run(FNS), "fns");
const there = fs.existsSync(V56);
// one transaction, as Supabase's SQL editor sends the file: all of it or nothing
const first = there ? run(`begin;\n\\i ${V56}\ncommit;`) : { ok: false, out: "", err: "ERROR: supabase/schema_v56.sql does not exist" };
const has56 = first.ok && /v56 applied/.test(first.out);
{ // P1a everything from before v56 is exactly as it was; the new columns are empty on it
  const after = { c: pick(run(`select 'c: ' || (${snapContracts(true)});`), "c"), p: pick(run(`select 'p: ' || (${snapPayments(true)});`), "p"),
    n: pick(run(`select 'n: ' || (select count(*) from public.contracts) || '/' || (select count(*) from public.order_payments);`), "n") };
  const empty = pick(run(`select 'e: ' || (select count(*) from public.contracts where ${NEWCOLS.map(k => `${k} is not null`).join(" or ")}) || '/' || (select count(*) from public.order_payments where ${NEWPAY.map(k => `${k} is not null`).join(" or ")});`), "e");
  vuln(!has56 || before.p === "(nothing)" || !/\/[1-9]/.test(before.n) || after.c !== before.c || after.p !== before.p || after.n !== before.n || empty !== "0/0",
    `P1a v56 on a database with Orders and payments -> ${has56 ? "applied" : "NOT applied: " + errOf(first)}; Orders the same: ${after.c === before.c}, ledger the same: ${after.p === before.p}, counts ${before.n} -> ${after.n}, old rows with a value in a new column: ${empty} (must be unchanged, 0/0)`);
}
{ // P1e v56 locks every existing table it changes at once, before its first change (no deadlock with a payment arriving)
  const src = fs.existsSync(V56) ? fs.readFileSync(V56, "utf8") : "";
  const own = new Set(["pricing_plans", "pricing_switch", "pricing_switch_log"]);
  const changed = [...new Set([...src.matchAll(/alter table public\.([a-z_]+)|on public\.([a-z_]+) for each row|create (?:unique )?index if not exists [a-z0-9_]+ on public\.([a-z_]+)/g)].map(m => m[1] || m[2] || m[3]).filter(t => !own.has(t)))];
  const lockAt = src.search(/lock table [^;]*public\.contracts[^;]*in access exclusive mode/), firstChange = src.indexOf("-- ---------- 1.");
  const lock = lockAt >= 0 ? src.slice(lockAt, src.indexOf(";", lockAt)) : "";
  const missing = changed.filter(t => !lock.includes("public." + t));
  vuln(changed.length < 5 || lockAt < 0 || lockAt > firstChange || missing.length || !/lock_timeout/.test(src.slice(0, firstChange)),
    `P1e v56 locks the tables it changes (${changed.join(", ")}) before its first change -> ${lockAt < 0 ? "no lock" : lockAt > firstChange ? "too late" : missing.length ? "missing " + missing.join(", ") : "yes"}${/lock_timeout/.test(src.slice(0, firstChange)) ? ", with a time limit" : ", no time limit"} (must lock them all first, with a time limit)`);
}
{ // P1b running it a second time changes nothing
  const plans = `select 'x: ' || md5(coalesce((select string_agg(to_jsonb(p)::text, '|' order by version) from public.pricing_plans p), '') || coalesce((select to_jsonb(s)::text from public.pricing_switch s), ''));`;
  const a = pick(run(plans), "x"), again = there ? runFile(V56) : { ok: false, out: "", err: "missing" }, b = pick(run(plans), "x");
  const same = pick(run(`select 'c: ' || (${snapContracts(true)});`), "c") === before.c;
  vuln(!has56 || !again.ok || !/v56 applied/.test(again.out) || a !== b || !same, `P1b running v56 again -> ${again.ok ? (again.out.split("\n").pop() || "").slice(0, 60) : errOf(again)}; plans and switch unchanged: ${a === b}; old Orders unchanged: ${same}`);
}
{ // P1c it refuses a database that is not at v55 yet (nothing is changed then)
  const r = run(`begin; alter function public.admin_clear_order_note(uuid, text) rename to admin_clear_order_note_x;\n\\i ${V56}\nrollback;`);
  vuln(r.ok || !/v55/.test(errOf(r)), `P1c v56 on a database without v55 -> ${errOf(r).slice(0, 110)} (must stop with a message naming v55)`);
}
{ // P1d the earlier draft of v56 (update 33, with a client fee) was never run here; if it had been, v56 stops and says so
  const r = run(`begin; alter table public.contracts add column if not exists client_fee_cents int;\n\\i ${V56}\nrollback;`);
  const cols = pick(run(`select 'n: ' || count(*) from information_schema.columns where table_schema = 'public' and column_name like 'client_fee%';`), "n");
  const kinds = pick(run(`select 'k: ' || pg_get_constraintdef(oid) from pg_constraint where conname = 'order_payments_kind_check';`), "k");
  vuln(r.ok || !/update 33/.test(errOf(r)) || cols !== "0" || /client_fee/.test(kinds),
    `P1d v56 on a database where the update 33 draft ran -> ${errOf(r).slice(0, 90)}; client fee columns anywhere: ${cols}; ledger kinds: ${kinds.slice(0, 90)} (must refuse; 0; no client fee kind)`);
}

// ---------- the people of the remaining checks (rolled back each time) ----------
// 861 the client, 862 the freelancer, 863 a stranger; 401 is the seed's admin
const CV = "'1d000000-0000-0000-0000-000000000001'", CV2 = "'1d000000-0000-0000-0000-000000000002'";
const O = `(select id from public.contracts where conversation_id = ${CV} order by created_at desc limit 1)`;
const ORDER = (cents, mode = "escrow", milestones = "[]") => `'{"title":"Product film","scope":"Edit a 60-second product film","deliverables":"MP4","price_cents":${cents},"revisions":1,"rights":"full","mode":"${mode}","language":"en","law":"DE","milestones":${milestones}}'`;
const SETUP = `
  insert into auth.users (id, email, raw_user_meta_data) values (${U("861")}, 'c861@t.com', '{"first_name":"Lina"}'), (${U("862")}, 'f862@t.com', '{"first_name":"Tom"}'), (${U("863")}, 'z863@t.com', '{"first_name":"Zed"}');
  update public.profiles set role = 'editor' where id = ${U("862")};
  insert into public.editor_profiles (id, display_name) values (${U("862")}, 'Tom Cuts') on conflict (id) do update set display_name = excluded.display_name;
  insert into public.conversations (id, user_a, user_b) values (${CV}, ${U("861")}, ${U("862")}), (${CV2}, ${U("861")}, ${U("863")});
`;
const RULES = `update public.profiles set rules_version = '2026-11', rules_accepted_at = now() where id in (${U("861")}, ${U("862")});`;
const V2ON = `${owner} update public.pricing_plans set rules_version = '2026-11' where version = 2; ${RULES} select 'switch: ' || public.pricing_switch_to(2, 'test');`;
const CREATE = (cents, mode, ms) => `${as("861")} select 'created: ' || (public.order_create(${CV}, ${ORDER(cents, mode, ms)}) is not null); ${owner}`;
const ACCEPT = (who = "862", label = "accepted") => `${as(who)} select '${label}: ' || public.order_accept(${O}, (select terms_version from public.contracts where id = ${O})); ${owner}`;
const STAMP = (label = "stamp") => `select '${label}: ' || concat_ws('/', pricing_version, commission_bps, auto_days, status) from public.contracts where id = ${O};`;
const FUND = (cents = 10000, key = "fund:pi_861") => `${svc()} update public.contracts set status = 'funded', funded_cents = ${cents}, funded_at = now(), stripe_payment_intent = 'pi_861' where id = ${O};
  insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'fund', ${cents}, 'stripe', 'pi_861', 'succeeded', '${key}'); ${owner}`;
// a plan 1 Order paid in by today's code (no header)
const FUND1 = `${svc(false)} update public.contracts set status = 'funded', funded_cents = 10000, funded_at = now(), stripe_payment_intent = 'pi_old' where id = ${O}; ${owner}`;
const LINK = "https://drive.google.com/file/d/861";
const MS1 = `(select id from public.order_milestones where order_id = ${O} and position = 1)`;
const ACT = (who, action, note = "x", link = null, label = action) => `${as(who)} select '${label}: ' || public.order_action(${O}, '${action}', '${note}', ${link ? `'${link}'` : "null"}, null); ${owner}`;
const MSACT = (who, action, link = null, label = action) => `${as(who)} select '${label}: ' || public.order_milestone_action(${MS1}, '${action}', 'part 1', ${link ? `'${link}'` : "null"}); ${owner}`;
const WINDOW = (label = "days", from = "contracts") => from === "contracts"
  ? `select '${label}: ' || coalesce((extract(epoch from auto_release_at - delivered_at) / 86400)::int::text, 'none') from public.contracts where id = ${O};`
  : `select '${label}: ' || coalesce((extract(epoch from auto_release_at - submitted_at) / 86400)::int::text, 'none') from public.order_milestones where id = ${MS1};`;
const V2ORDER = (cents = 10000, ms = "[]") => `${V2ON} ${CREATE(cents, "escrow", ms)} ${ACCEPT()}`;
const REL = (amount, commission, payout, key, purpose = "release", note = "") => `insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key, commission_cents, payout_cents, payout_purpose, note) values (${O}, 'release', ${amount}, 'stripe', '${key.replace(/^release:/, "")}', 'succeeded', '${key}', ${commission}, ${payout}, '${purpose}', '${note}');`;
const COUNTERS = (label = "counters") => `select '${label}: ' || commission_cents from public.contracts where id = ${O};`;
// what the admin's ledger check lists for the Orders (as you in the SQL editor)
const PROBLEMS = (label = "check") => `${owner} select '${label}: ' || (public.admin_pricing_check()->'problems')::text;`;
const kinds = (s) => [...String(s).matchAll(/"problem": "([a-z_]+)"/g)].map(m => m[1]).sort().join(",") || (/^\[\]$/.test(s) ? "none" : s);
const tx = (body) => run(`begin;\n${SETUP}\n${body}\nrollback;\n`);
{ const r = tx(`${CREATE(10000)} select 'setup: ok';`); if (pick(r, "created") !== "true" || pick(r, "setup") !== "ok") { console.log("the test's set-up failed: " + (r.err || r.out)); process.exit(1); } }

// ---------- P2 the price plans and the switch ----------
{ // P2a nobody but the owner in Supabase changes a plan or the switch: not a member, not a visitor, not the payment functions
  const tries = [["visitor", as("anon")], ["member", as("861")], ["admin", as("401")], ["payment functions", svc()]];
  const res = tries.map(([who, role]) => {
    const r = [
      tx(`${role} update public.pricing_plans set commission_bps = 0 where version = 2; ${owner} select 'v: ' || commission_bps from public.pricing_plans where version = 2;`),
      tx(`${role} insert into public.pricing_plans (version, name, commission_bps, min_project_cents, card_costs_paid_by, review_days) values (9, 'x', 0, 100, 'client', 7); ${owner} select 'v: ' || count(*) from public.pricing_plans where version = 9;`),
      tx(`${role} update public.pricing_switch set version = 2; ${owner} select 'v: ' || version from public.pricing_switch;`),
      tx(`${role} update public.pricing_plans set review_days = 3 where version = 2; ${owner} select 'v: ' || review_days from public.pricing_plans where version = 2;`),
      tx(`${role} delete from public.pricing_plans where version = 2; ${owner} select 'v: ' || count(*) from public.pricing_plans where version = 2;`),
    ].map(x => (x.ok ? pick(x, "v") : /permission denied|row-level security/.test(errOf(x)) ? "refused" : "error: " + errOf(x).slice(0, 60)));
    const held = ["500", "0", "1", "14", "1"].every((want, i) => r[i] === want || r[i] === "refused");
    return { held, text: `${who}: ${r.join(",")}` };
  });
  vuln(!res.every(x => x.held), `P2a changing a plan, adding one, flipping the switch, deleting a plan -> ${res.map(x => x.text).join("; ")} (each must be refused or leave 500,0,1,14,1)`);
}
{ // P2b visitors can read the prices in force (the page shows them before anyone signs in); there is no client fee in them
  const off = pick(tx(`${as("anon")} select 'now: ' || public.pricing_now()::text; ${owner}`), "now");
  const on = pick(tx(`${V2ON} ${as("anon")} select 'now: ' || public.pricing_now()::text; ${owner}`), "now");
  const plans = pick(run(`select 'p: ' || string_agg(concat_ws('/', version, commission_bps, card_costs_paid_by, min_project_cents, review_days), ' ' order by version) from public.pricing_plans;`), "p");
  vuln(!/"version": 1/.test(off) || !/"review_days": 7/.test(off) || !/"version": 2/.test(on) || !/"commission_bps": 500/.test(on) || !/"review_days": 14/.test(on)
       || !/"card_costs_paid_by": "platform"/.test(on) || /client_fee/.test(off + on) || plans !== "1/0/client/100/7 2/500/platform/200/14",
    `P2b a visitor reads the prices: switch off -> ${off.slice(0, 120)}; switch on -> ${on.slice(0, 160)}; the plans ${plans} (must be 1/0/client/100/7 2/500/platform/200/14, no client fee)`);
}
{ // P2c only the owner flips the switch; and never to new prices without the rules version they need
  const tries = [["visitor", as("anon")], ["member", as("861")], ["admin", as("401")], ["payment functions", svc()]].map(([who, role]) => `${who}: ${pick(tx(`${role} select 'r: ' || public.pricing_switch_to(2, 'x'); ${owner}`), "r").slice(0, 45)}`);
  const noRules = tx(`${owner} select 'r: ' || public.pricing_switch_to(2, 'x'); select 'v: ' || version from public.pricing_switch;`);
  const ok = tx(`${V2ON} select 'v: ' || version from public.pricing_switch; select 'log: ' || count(*) from public.pricing_switch_log where to_version = 2 and from_version = 1;`);
  vuln(tries.some(s => !/permission denied/.test(s)) || pick(noRules, "r") !== "rules_version_missing" || pick(noRules, "v") !== "1" || pick(ok, "switch") !== "ok" || pick(ok, "v") !== "2" || pick(ok, "log") !== "1",
    `P2c flipping the switch -> ${tries.join("; ")}; the owner, plan 2 without a rules version -> ${pick(noRules, "r")} (switch at ${pick(noRules, "v")}); with it -> ${pick(ok, "switch")}, switch at ${pick(ok, "v")}, logged ${pick(ok, "log")}`);
}
{ // P2e turning the switch to where it already is changes nothing and says so (the log gets no new line)
  const r = tx(`${owner} select 'off: ' || public.pricing_switch_to(1, 'again'); ${V2ON} select 'on: ' || public.pricing_switch_to(2, 'again');
                select 'log: ' || count(*) from public.pricing_switch_log where note = 'again';`);
  vuln(pick(r, "off") !== "already" || pick(r, "on") !== "already" || pick(r, "log") !== "0",
    `P2e the switch turned to where it is -> off: ${pick(r, "off")}, on: ${pick(r, "on")}, log lines: ${pick(r, "log")} (must be already, already, 0)`);
}
{ // P2f the owner cannot delete a plan that Orders use either; the switch history is for admins only
  const del = tx(`${V2ORDER()} ${owner} delete from public.pricing_plans where version = 2;`);
  const log = (who) => pick(tx(`${V2ON} ${as(who)} select 'n: ' || count(*) from public.pricing_switch_log; ${owner}`), "n");
  const member = log("862"), admin = log("401"), visitor = log("anon");
  vuln(!/pricing_plan_in_use/.test(errOf(del)) || !(member === "0" || /^error/.test(member)) || !(visitor === "0" || /^error/.test(visitor)) || !/^[1-9]/.test(admin),
    `P2f deleting plan 2 once an Order uses it -> ${errOf(del)}; the switch history read by a member -> ${member}, a visitor -> ${visitor}, an admin -> ${admin} (must be refused; nothing; nothing; the lines)`);
}
{ // P2g the switch to a plan that doesn't exist answers so and changes nothing
  const r = tx(`${owner} select 'r: ' || public.pricing_switch_to(7, 'x'); select 'v: ' || version from public.pricing_switch;`);
  vuln(pick(r, "r") !== "no_such_plan" || pick(r, "v") !== "1", `P2g switching to plan 7 -> ${pick(r, "r")}, switch at ${pick(r, "v")} (must be no_such_plan, 1)`);
}
{ // P2d a plan that an Order uses can no longer be changed, even by the owner
  const r = tx(`${V2ORDER()} update public.pricing_plans set commission_bps = 600 where version = 2;`);
  const unused = tx(`update public.pricing_plans set name = 'renamed' where version = 2; select 'v: ' || name from public.pricing_plans where version = 2;`);
  vuln(!/pricing_plan_in_use/.test(errOf(r)) || pick(unused, "v") !== "renamed", `P2d changing plan 2 once an Order uses it -> ${errOf(r)}; while no Order uses it -> ${pick(unused, "v")} (must be refused / allowed)`);
}

// ---------- P3 stamping ----------
{ // P3a the switch is off: a new Order keeps today's prices (plan 1, no commission, 7 days to review)
  const r = tx(`${CREATE(10000)} ${STAMP()} ${ACCEPT()} ${STAMP("after")}`);
  vuln(pick(r, "stamp") !== "1/0/7/proposed" || pick(r, "after") !== "1/0/7/accepted", `P3a switch off, a new €100 Order -> ${pick(r, "stamp")}, accepted -> ${pick(r, "after")} (must be plan 1, no commission, 7 days)`);
}
{ // P3b the switch on: a protected-payment Order gets the 5% and 14 days; an Order paid directly gets no commission
  // (both Orders are made in one transaction, with one time: the first is moved a minute back, so "the Order" afterwards is the second)
  const r = tx(`${V2ON} ${CREATE(10000)} ${STAMP()} update public.contracts set status = 'cancelled', created_at = created_at - interval '1 minute' where id = ${O}; ${CREATE(10000, "direct")} ${STAMP("direct")}`);
  vuln(pick(r, "stamp") !== "2/500/14/proposed" || pick(r, "direct") !== "2/0/14/proposed", `P3b switch on -> protected payment ${pick(r, "stamp")}, paid directly ${pick(r, "direct")} (must be 2/500/14 and 2/0/14)`);
}
{ // P3c once accepted, nobody changes an Order's commission or its review days: not the payment functions (new or old), not the owner
  const tries = [["payment functions", svc()], ["old payment code", svc(false)], ["owner", owner]].flatMap(([who, role]) => [["commission_bps = 0", "commission"], ["auto_days = 7", "days"]].map(([set, what]) => {
    const r = tx(`${V2ORDER()} ${role} update public.contracts set ${set} where id = ${O}; ${owner} ${STAMP()}`);
    return `${who} (${what}): ${r.ok ? pick(r, "stamp") : errOf(r)}`;
  }));
  const agreed = pick(tx(`${V2ORDER()} ${STAMP()}`), "stamp");
  vuln(agreed !== "2/500/14/accepted" || tries.some(s => !/pricing_frozen|pricing_engine_too_old/.test(s)), `P3c the Order -> ${agreed}; lowering its commission, shortening its 14 days -> ${tries.join("; ")} (must be 2/500/14/accepted; refused)`);
}
{ // P3d prices written in by hand when an Order is made are ignored: the plan decides
  const r = tx(`${V2ON} insert into public.contracts (conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, pricing_version, commission_bps, auto_days)
                 values (${CV2}, ${U("863")}, ${U("861")}, ${U("861")}, 'by hand', 100, 'proposed', 'escrow', 10000, 1, 0, 3);
                 select 'stamp: ' || concat_ws('/', pricing_version, commission_bps, auto_days) from public.contracts where conversation_id = ${CV2};`);
  vuln(pick(r, "stamp") !== "2/500/14", `P3d an Order inserted with plan 1, no commission and 3 days while plan 2 is on -> ${pick(r, "stamp")} (must be 2/500/14)`);
}

{ // P3e once agreed, an Order keeps its way of payment (otherwise its ledger would leave the plan 2 rules)
  const tries = [["old payment code", svc(false)], ["payment functions", svc()], ["owner", owner]].map(([who, role]) => `${who}: ${errOf(tx(`${V2ORDER()} ${role} update public.contracts set payment_mode = 'direct' where id = ${O};`))}`);
  const back = [["payment functions", svc()], ["owner", owner]].map(([who, role]) => `${who}: ${errOf(tx(`${V2ON} ${CREATE(10000, "direct")} ${ACCEPT()} ${role} update public.contracts set payment_mode = 'escrow' where id = ${O};`))}`);
  vuln(tries.some(s => !/pricing_frozen/.test(s)) || back.some(s => !/pricing_frozen/.test(s)), `P3e switching an agreed plan 2 Order to "paid directly" -> ${tries.join("; ")}; a directly paid one to "through Cuvori" -> ${back.join("; ")} (must be refused both ways)`);
}

{ // P3f an Order with a plan records all its numbers: none of them can be emptied, even with the stamp trigger off
  const r = tx(`${CREATE(10000)} alter table public.contracts disable trigger contracts_pricing; update public.contracts set commission_cents = null where id = ${O};`);
  vuln(!/contracts_pricing_ok/.test(errOf(r)), `P3f emptying an Order's commission total with the trigger off -> ${errOf(r)} (must break the contracts_pricing_ok rule)`);
}
{ // P3h an agreed Order never becomes a proposal again (its prices would be stamped anew): not by the owner, not by the
  // payment functions; so the three steps "back to proposed, switch back, accept again" cannot give it plan 1's prices
  const tries = [["owner", owner], ["payment functions", svc()]].map(([who, role]) => `${who}: ${errOf(tx(`${V2ORDER()} ${role} update public.contracts set status = 'proposed' where id = ${O};`))}`);
  // an Order agreed at today's prices too (right after v56 the switch is off, so these come first): none of the payment code either
  const tries1 = [["owner", owner], ["payment functions", svc()], ["old payment functions", svc(false)]].map(([who, role]) => `${who}: ${errOf(tx(`${CREATE(10000)} ${ACCEPT()} ${role} update public.contracts set status = 'proposed' where id = ${O};`))}`);
  const steps = tx(`${V2ORDER()} alter table public.contracts disable trigger contracts_pricing; update public.contracts set status = 'proposed' where id = ${O}; alter table public.contracts enable trigger contracts_pricing;
                    select 'back: ' || public.pricing_switch_to(1, 'back'); update public.contracts set terms_version = terms_version + 1 where id = ${O}; ${STAMP()}`);
  vuln(tries.some(x => !/pricing_frozen/.test(x)) || tries1.some(x => !/pricing_frozen/.test(x)) || pick(steps, "back") !== "ok" || pick(steps, "stamp") !== "2/500/14/proposed",
    `P3h an agreed plan 2 Order set back to "proposed" -> ${tries.join("; ")}; an agreed plan 1 Order -> ${tries1.join("; ")}; forced back with the trigger off, then the switch moved (${pick(steps, "back")}) and the version raised -> ${pick(steps, "stamp")} (must be refused every time; the switch ok; keep 2/500/14)`);
}
{ // P3i the way of payment of a plan 2 proposal decides its commission: changed to paid directly (in the table: people
  // can't change it, a new proposal is made instead) it gets none; changed back, it gets the 5% again
  const r = tx(`${V2ON} ${CREATE(10000)} ${STAMP("first")} ${owner} update public.contracts set payment_mode = 'direct' where id = ${O}; ${STAMP("direct")}
                update public.contracts set payment_mode = 'escrow' where id = ${O}; ${STAMP("back")}`);
  vuln(pick(r, "first") !== "2/500/14/proposed" || pick(r, "direct") !== "2/0/14/proposed" || pick(r, "back") !== "2/500/14/proposed",
    `P3i a plan 2 proposal -> ${pick(r, "first")}; made paid directly -> ${pick(r, "direct")}; made paid through Cuvori again -> ${pick(r, "back")} (must be 2/500/14, 2/0/14, 2/500/14)`);
}
{ // P3g an Order proposed before the switch and still a proposal: its review days follow the prices it is accepted under
  // (P4a); an Order of today's prices keeps the 7 days and may be changed by hand as before v56
  const r = tx(`${CREATE(10000)} ${ACCEPT()} update public.contracts set auto_days = 10 where id = ${O}; ${STAMP()}`);
  vuln(pick(r, "stamp") !== "1/0/10/accepted", `P3g the owner changing a plan 1 Order's days by hand -> ${r.ok ? pick(r, "stamp") : errOf(r)} (must work as before v56)`);
}

// ---------- P4 acceptance ----------
{ // P4a proposed under today's prices, the switch moves, then the freelancer accepts: the Order must be read again
  const r = tx(`${CREATE(10000)} ${V2ON} select 'v1: ' || terms_version from public.contracts where id = ${O}; ${ACCEPT("862", "first")} ${STAMP("now")}
                select 'v2: ' || terms_version || ' accepted ' || coalesce(client_accepted_version::text, '-') || '/' || coalesce(freelancer_accepted_version::text, '-') from public.contracts where id = ${O};
                ${ACCEPT("862", "freelancer")} ${ACCEPT("861", "client")} ${STAMP("end")}
                select 'doc: ' || concat_ws('/', coalesce(terms_doc->'prices'->>'commission_bps', 'none'), coalesce(terms_doc->'prices'->>'review_days', 'none'), terms_doc->>'auto_days', ((terms_doc->'prices') ? 'client_fee_cents')::text) from public.contracts where id = ${O};
                select 'log: ' || coalesce((select data::text from public.order_events where order_id = ${O} and event = 'prices_changed' limit 1), 'none');`);
  vuln(pick(r, "first") !== "order_changed" || pick(r, "now") !== "2/500/14/proposed" || !/^2 accepted /.test(pick(r, "v2"))
       || pick(r, "freelancer") !== "ok" || pick(r, "client") !== "ok" || pick(r, "end") !== "2/500/14/accepted" || pick(r, "doc") !== "500/14/14/false"
       || !/"commission_bps": 500/.test(pick(r, "log")) || !/"review_days": 14/.test(pick(r, "log")) || /client_fee/.test(pick(r, "log")),
    `P4a proposed at today's prices, the switch moves, the freelancer accepts -> ${pick(r, "first")}; the Order now ${pick(r, "now")}, version ${pick(r, "v2")}; both accept again -> ${pick(r, "freelancer")}/${pick(r, "client")}, ${pick(r, "end")}; agreed text carries commission/review days/days/a client fee ${pick(r, "doc")} (must be 500/14/14/false); the history says ${pick(r, "log").slice(0, 100)}`);
  const stillOpen = /accepted 2\//.test(pick(r, "v2")) || /\/2$/.test(pick(r, "v2"));
  vuln(stillOpen || !/^2 accepted /.test(pick(r, "v2")), `P4a' after the prices changed nobody counts as having accepted the new version -> ${pick(r, "v2")} (the client's and freelancer's accepted versions must both be below 2)`);
}
{ // P4e a very old proposal (made before v18: no acceptance recorded at all) when the prices change: the proposer is not
  // counted as having accepted the new prices unseen
  const r = tx(`${CREATE(10000)} update public.contracts set client_accepted_version = null, freelancer_accepted_version = null where id = ${O};
                ${V2ON} ${ACCEPT("862", "first")} select 'v: ' || terms_version || ' ' || coalesce(client_accepted_version::text, '-') || '/' || coalesce(freelancer_accepted_version::text, '-') from public.contracts where id = ${O};
                ${ACCEPT("862", "second")} ${STAMP()}`);
  vuln(pick(r, "first") !== "order_changed" || pick(r, "v") !== "2 1/-" || pick(r, "second") !== "ok" || pick(r, "stamp") !== "2/500/14/proposed",
    `P4e an old-style proposal, the prices change, the freelancer accepts -> ${pick(r, "first")}, version and acceptances ${pick(r, "v")}; the freelancer accepts again -> ${pick(r, "second")}, ${pick(r, "stamp")} (must stay a proposal until the client accepts too)`);
}
{ // P4b an Order proposed before v56 (no plan on it) is accepted while the switch is off: plan 1, as agreed
  const r = tx(`${CREATE(10000)} update public.contracts set pricing_version = null where id = ${O};`);
  const legacy = tx(`${CREATE(10000)} alter table public.contracts disable trigger contracts_pricing; update public.contracts set pricing_version = null, commission_bps = null, commission_cents = null where id = ${O}; alter table public.contracts enable trigger contracts_pricing;
                     ${ACCEPT()} ${STAMP()}`);
  vuln(!/pricing_frozen/.test(errOf(r)) || pick(legacy, "accepted") !== "ok" || pick(legacy, "stamp") !== "1/0/7/accepted",
    `P4b clearing a new Order's plan -> ${errOf(r)}; an Order from before v56 accepted with the switch off -> ${pick(legacy, "accepted")}, ${pick(legacy, "stamp")} (must be refused / ok at plan 1)`);
}
{ // P4g a proposal from before v56 (no plan on it), still open on the day the switch is turned on: Accept makes it a new
  // version at the new prices (5%, 14 days) that both sides read and accept again; then it is agreed under plan 2
  const legacy = `${CREATE(10000)} alter table public.contracts disable trigger contracts_pricing; update public.contracts set pricing_version = null, commission_bps = null, commission_cents = null where id = ${O}; alter table public.contracts enable trigger contracts_pricing;`;
  const r = tx(`${legacy} ${V2ON} ${ACCEPT("862", "first")} ${STAMP("then")} ${owner} select 'history: ' || count(*) from public.order_events where order_id = ${O} and event = 'prices_changed';
                ${ACCEPT("861", "client")} ${ACCEPT("862", "freelancer")} ${STAMP("now")}`);
  vuln(pick(r, "first") !== "order_changed" || pick(r, "then") !== "2/500/14/proposed" || pick(r, "history") !== "1" || pick(r, "freelancer") !== "ok" || pick(r, "now") !== "2/500/14/accepted",
    `P4g a proposal from before v56 accepted after the switch -> ${pick(r, "first")}, ${pick(r, "then")}, history lines ${pick(r, "history")}; both accept again -> ${pick(r, "client")}/${pick(r, "freelancer")}, ${pick(r, "now")} (must be order_changed, 2/500/14/proposed, 1; then ok and 2/500/14/accepted)`);
}
{ // P4c plan 2 needs the rules that go with it: a side who has not accepted them cannot make the Order an agreement
  const r = tx(`${V2ON} ${CREATE(10000)} update public.profiles set rules_version = '2026-09' where id = ${U("861")}; ${ACCEPT("862", "without")} ${STAMP("then")}
                ${RULES} ${ACCEPT("862", "with")} ${STAMP("now")}`);
  vuln(pick(r, "without") !== "rules_not_accepted" || pick(r, "then") !== "2/500/14/proposed" || pick(r, "with") !== "ok" || pick(r, "now") !== "2/500/14/accepted",
    `P4c the client still on the old rules, the freelancer accepts -> ${pick(r, "without")} (${pick(r, "then")}); once both have the new rules -> ${pick(r, "with")} (${pick(r, "now")})`);
}
{ // P4d an Order at today's prices keeps today's agreed text exactly (no prices in it, 7 days)
  const r = tx(`${CREATE(10000)} ${ACCEPT()} select 'doc: ' || (terms_doc ? 'prices') || '/' || (terms_doc->>'kind') || '/' || (terms_doc->>'auto_days') from public.contracts where id = ${O};`);
  vuln(pick(r, "doc") !== "false/facts/7", `P4d agreed text of a plan 1 Order -> has prices/kind/days: ${pick(r, "doc")} (must be false/facts/7)`);
}
{ // P4f the switch goes back to today's prices while a plan 2 proposal is open: it is read again at today's prices
  const r = tx(`${V2ON} ${CREATE(10000)} ${owner} select 'back: ' || public.pricing_switch_to(1, 'back'); ${ACCEPT("862", "first")} ${STAMP("now")} ${ACCEPT("862", "freelancer")} ${ACCEPT("861", "client")} ${STAMP("end")}`);
  vuln(pick(r, "back") !== "ok" || pick(r, "first") !== "order_changed" || pick(r, "now") !== "1/0/7/proposed" || pick(r, "end") !== "1/0/7/accepted",
    `P4f a plan 2 proposal, the switch back to plan 1 -> accepting: ${pick(r, "first")}, the Order ${pick(r, "now")}; both accept -> ${pick(r, "end")} (must be order_changed, then plan 1 with 7 days)`);
}
{ // P4h the plan's rules can't be passed with a rules version that does not exist yet: accept_rules takes any month, so
  // someone calling it directly with "9999-12" would count as having accepted every rules version ever to come. A version
  // counts up to the plan's own or this month (German time), whichever is later
  const month = (shift) => `to_char((now() at time zone 'Europe/Berlin') + interval '${shift} month', 'YYYY-MM')`;
  const future = tx(`${V2ON} ${CREATE(10000)} ${as("861")} select 'rules: ' || public.accept_rules('9999-12'); ${owner} ${ACCEPT("862", "accept")} ${STAMP()}`);
  const plan = (who) => `${owner} update public.pricing_plans set rules_version = '2026-01' where version = 2;
    update public.profiles set rules_version = ${month(0)} where id in (${U("861")}, ${U("862")}); ${who ? `update public.profiles set rules_version = ${month(1)} where id = ${U(who)};` : ""}
    select 'switch: ' || public.pricing_switch_to(2, 'test');`;
  const thisMonth = tx(`${plan()} ${CREATE(10000)} ${ACCEPT("862", "accept")} ${STAMP()}`);
  const nextMonth = tx(`${plan("861")} ${CREATE(10000)} ${ACCEPT("862", "accept")} ${STAMP()}`);
  // a later price plan's own rules, published ahead of their month (as plan 2's are), count: whoever accepted them is
  // not stopped from agreeing an Order under plan 2 meanwhile
  const plan3 = tx(`${owner} insert into public.pricing_plans (version, name, commission_bps, min_project_cents, card_costs_paid_by, review_days, rules_version) values (3, 'later', 500, 200, 'platform', 14, ${month(1)});
    ${plan("861")} ${CREATE(10000)} ${ACCEPT("862", "accept")} ${STAMP()}`);
  vuln(!plan3.ok || pick(plan3, "accept") !== "ok" || pick(plan3, "stamp") !== "2/500/14/accepted",
    `P4h' the client accepted the rules of a later plan, published ahead of their month -> the freelancer accepts a plan 2 Order: ${plan3.ok ? pick(plan3, "accept") + ", " + pick(plan3, "stamp") : errOf(plan3)} (must be ok, agreed)`);
  vuln(pick(future, "rules") !== "ok" || pick(future, "accept") !== "rules_not_accepted" || pick(future, "stamp") !== "2/500/14/proposed"
       || pick(thisMonth, "accept") !== "ok" || pick(thisMonth, "stamp") !== "2/500/14/accepted" || pick(nextMonth, "accept") !== "rules_not_accepted",
    `P4h the client "accepts" rules version 9999-12 directly (${pick(future, "rules")}), the freelancer accepts -> ${pick(future, "accept")}, ${pick(future, "stamp")}; the plan's rules 2026-01, both on this month's version -> ${pick(thisMonth, "accept")}, ${pick(thisMonth, "stamp")}; the client on next month's -> ${pick(nextMonth, "accept")} (must be rules_not_accepted and stay a proposal; ok and agreed; rules_not_accepted)`);
}
{ // P4j the rules check also holds when the client's click makes the Order an agreement (the freelancer proposed)
  const FL = (label = "created") => `${as("862")} select '${label}: ' || (public.order_create(${CV}, ${ORDER(10000)}) is not null); ${owner}`;
  const old = (who) => `update public.profiles set rules_version = '2026-09' where id = ${U(who)};`;
  const clientOld = tx(`${V2ON} ${FL()} ${old("861")} ${ACCEPT("861", "accept")} ${STAMP()}`);
  const flOld = tx(`${V2ON} ${FL()} ${old("862")} ${ACCEPT("861", "accept")} ${STAMP()}`);
  const both = tx(`${V2ON} ${FL()} ${ACCEPT("861", "accept")} ${STAMP()}`);
  vuln(pick(clientOld, "accept") !== "rules_not_accepted" || pick(flOld, "accept") !== "rules_not_accepted" || pick(clientOld, "stamp") !== "2/500/14/proposed"
       || pick(both, "accept") !== "ok" || pick(both, "stamp") !== "2/500/14/accepted",
    `P4j the freelancer proposes, the client accepts last: the client on the old rules -> ${pick(clientOld, "accept")} (${pick(clientOld, "stamp")}); the freelancer on the old rules -> ${pick(flOld, "accept")}; both on the new -> ${pick(both, "accept")}, ${pick(both, "stamp")} (must be rules_not_accepted twice, then ok and agreed)`);
}
{ // P4i Accept re-prices an Order because the switch moved: its chat card says the prices changed (not "terms_changed",
  // which the page shows as an update the person clicking made)
  const r = tx(`${CREATE(10000)} ${V2ON} ${ACCEPT("862", "first")}
    select 'cards: ' || count(*) filter (where payload->>'event' = 'prices_changed') || '/' || count(*) filter (where payload->>'event' = 'terms_changed')
      from public.messages where conversation_id = ${CV} and kind = 'contract';`);
  vuln(pick(r, "first") !== "order_changed" || pick(r, "cards") !== "1/0",
    `P4i proposed at today's prices, the switch moves, the freelancer accepts -> ${pick(r, "first")}; chat cards "prices changed"/"terms changed": ${pick(r, "cards")} (must be order_changed, 1/0)`);
}

// ---------- P5 the €2 minimum (and the separate €0.50 top-up rule) ----------
{ // P5a under plan 2 a protected-payment Order starts at €2
  const low = tx(`${V2ON} ${CREATE(199)}`), ok = tx(`${V2ON} ${CREATE(200)} ${STAMP()}`);
  vuln(!/bad_price/.test(errOf(low)) || pick(ok, "stamp") !== "2/500/14/proposed", `P5a plan 2: a €1.99 Order -> ${errOf(low)}; €2.00 -> ${pick(ok, "stamp")} (must be bad_price / accepted as a proposal)`);
}
{ // P5b nor can it be brought below €2 afterwards: by changing the proposal, or by an amendment before payment
  const upd = tx(`${V2ON} ${CREATE(500)} ${as("861")} select 'r: ' || public.order_update(${O}, ${ORDER(150)}); ${owner}`);
  const amend = tx(`${V2ORDER(500)} ${as("861")} select 'r: ' || (public.order_amend(${O}, '{"note":"less","price_delta_cents":-301}') is not null); ${owner}`);
  const amendOk = tx(`${V2ORDER(500)} ${as("861")} select 'r: ' || (public.order_amend(${O}, '{"note":"less","price_delta_cents":-300}') is not null); ${owner}`);
  vuln(!/bad_price/.test(pick(upd, "r")) || !/bad_price/.test(pick(amend, "r")) || pick(amendOk, "r") !== "true",
    `P5b plan 2: the proposal changed to €1.50 -> ${pick(upd, "r")}; an amendment to €1.99 -> ${pick(amend, "r")}; to €2.00 -> ${pick(amendOk, "r")} (must be bad_price, bad_price, true)`);
}
{ // P5c the top-up rule is its own: a €0.50 price increase on a paid plan 2 Order is fine, €0.49 is not (as before)
  const ok = tx(`${V2ORDER()} ${FUND()} ${as("862")} select 'r: ' || (public.order_amend(${O}, '{"note":"more","price_delta_cents":50}') is not null); ${owner}`);
  const low = tx(`${V2ORDER()} ${FUND()} ${as("862")} select 'r: ' || (public.order_amend(${O}, '{"note":"more","price_delta_cents":49}') is not null); ${owner}`);
  vuln(pick(ok, "r") !== "true" || !/bad_price/.test(pick(low, "r")), `P5c a paid plan 2 Order: +€0.50 -> ${pick(ok, "r")}, +€0.49 -> ${pick(low, "r")} (must be true / bad_price)`);
}
{ // P5e a €1.50 proposal made at today's prices cannot become a plan 2 agreement below €2
  const r = tx(`${CREATE(150)} ${V2ON} ${ACCEPT("862", "first")} ${STAMP("now")} ${ACCEPT("862", "freelancer")} ${ACCEPT("861", "client")} ${STAMP("end")}
                select 'acc: ' || coalesce(client_accepted_version::text, '-') || '/' || coalesce(freelancer_accepted_version::text, '-') || ' of ' || terms_version from public.contracts where id = ${O};`);
  vuln(pick(r, "first") !== "order_changed" || pick(r, "freelancer") !== "bad_price" || pick(r, "client") !== "bad_price" || pick(r, "end") !== "2/500/14/proposed" || pick(r, "acc") !== "1/- of 2",
    `P5e a €1.50 proposal, the prices change -> ${pick(r, "first")} (${pick(r, "now")}); the freelancer, then the client accept -> ${pick(r, "freelancer")} / ${pick(r, "client")}; the Order: ${pick(r, "end")}, accepted ${pick(r, "acc")} (must be bad_price twice, still a proposal, nothing recorded)`);
}
{ // P5d today's minimum is unchanged where the €2 does not apply: plan 1 Orders, and Orders paid directly
  const v1 = tx(`${CREATE(100)} ${STAMP()}`), direct = tx(`${V2ON} ${CREATE(100, "direct")} ${STAMP()}`), under = tx(`${CREATE(99)}`);
  vuln(pick(v1, "stamp") !== "1/0/7/proposed" || pick(direct, "stamp") !== "2/0/14/proposed" || !/bad_price/.test(errOf(under)),
    `P5d a €1 Order at plan 1 -> ${pick(v1, "stamp")}; a €1 direct Order at plan 2 -> ${pick(direct, "stamp")}; €0.99 -> ${errOf(under)} (must be allowed, allowed, bad_price)`);
}

// ---------- P6 the ledger under plan 2 (as the new payment code writes it) ----------
{ // P6a the first payment is the agreed price and nothing more: no client fee, no card costs on top, nothing to send back
  const r = tx(`${V2ORDER()} ${FUND()} ${COUNTERS()} select 'row: ' || concat_ws('/', pricing_version, amount_cents, fee_cents, connect_cents, fee_refund_cents) from public.order_payments where order_id = ${O};`);
  vuln(pick(r, "counters") !== "0" || pick(r, "row") !== "2/10000/0/0/0", `P6a first payment of a €100 Order -> commission so far ${pick(r, "counters")}; the line's plan/amount/card costs/payout cost/sent back ${pick(r, "row")} (must be 0 and 2/10000/0/0/0)`);
}
{ // P6b one line per money move: the same line twice, the same Stripe payment under another key
  const same = tx(`${V2ORDER()} ${FUND(5000)} ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'fund', 500, 'stripe', 'pi_863', 'succeeded', 'fund:pi_861');`);
  const pi = tx(`${V2ORDER()} ${FUND(5000)} ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'fund', 500, 'stripe', 'pi_861', 'succeeded', 'fund:pi_861b');`);
  vuln(!/duplicate key/.test(errOf(same)) || !/duplicate key/.test(errOf(pi)), `P6b the same entry key again -> ${errOf(same)}; the same Stripe payment under another key -> ${errOf(pi)} (both must be refused)`);
}
{ // P6c a payment line names its key (a badly written line is refused). Under the new prices Cuvori pays the card
  // costs: a payment that charged the client card costs anyway is money that already arrived, so it is recorded as it
  // happened (never hidden) and the ledger check lists the Order, to be refunded to the client
  const nokey = tx(`${V2ORDER()} ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status) values (${O}, 'fund', 10000, 'stripe', 'pi_861', 'succeeded');`);
  const oldfee = tx(`${V2ORDER()} ${svc()} insert into public.order_payments (order_id, kind, amount_cents, fee_cents, provider, provider_ref, status, entry_key) values (${O}, 'fund', 10000, 370, 'stripe', 'pi_861', 'succeeded', 'fund:pi_861');
                     ${owner} select 'fee: ' || fee_cents from public.order_payments where order_id = ${O}; ${PROBLEMS()}`);
  const connect = tx(`${V2ORDER()} ${svc()} insert into public.order_payments (order_id, kind, amount_cents, connect_cents, provider, provider_ref, status, entry_key) values (${O}, 'fund', 10000, 35, 'stripe', 'pi_861', 'succeeded', 'fund:pi_861'); ${PROBLEMS()}`);
  const clean = tx(`${V2ORDER()} ${FUND()} ${PROBLEMS()}`);
  vuln(!/entry_key_missing/.test(errOf(nokey)) || !oldfee.ok || pick(oldfee, "fee") !== "370" || kinds(pick(oldfee, "check")) !== "client_charged_card_fee"
       || !connect.ok || kinds(pick(connect, "check")) !== "client_charged_card_fee" || kinds(pick(clean, "check")) !== "none",
    `P6c no entry key -> ${errOf(nokey)}; the client charged €3.70 card costs on top -> ${oldfee.ok ? `recorded as ${pick(oldfee, "fee")}, check lists ${kinds(pick(oldfee, "check"))}` : "REFUSED " + errOf(oldfee)}; or the payout cost -> ${connect.ok ? "recorded, check lists " + kinds(pick(connect, "check")) : "REFUSED " + errOf(connect)}; a payment with no card costs -> check lists ${kinds(pick(clean, "check"))} (must be refused; recorded as 370 and listed; recorded and listed; none)`);
}
{ // P6d a top-up is recorded like the first payment: the agreed increase, no fee, nothing kept until it is paid out
  const r = tx(`${V2ORDER()} ${FUND()} update public.contracts set amount_cents = 10500 where id = ${O}; -- a price increase of €5, accepted
                ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'fund', 500, 'stripe', 'pi_top', 'succeeded', 'fund:pi_top'); ${owner} ${COUNTERS()}
                ${svc()} ${REL(10500, 525, 9975, "release:tr_1")} ${owner} ${COUNTERS("after")}`);
  vuln(pick(r, "counters") !== "0" || pick(r, "after") !== "525", `P6d a €5 top-up -> ${r.ok ? "recorded, commission so far " + pick(r, "counters") : errOf(r)}; €105 paid out -> commission ${pick(r, "after")} (must be 0, then 5% of €105 = 525)`);
}
{ // P6p a payment above the agreed price (card costs folded in, or a top-up nobody agreed) is money that already
  // arrived: it is recorded, never lost, and the ledger check lists the Order for the admin
  const CHECK = `${owner} select 'check: ' || (public.admin_pricing_check()->'problems')::text;`;
  const more = tx(`${V2ORDER()} ${FUND(10325)} ${CHECK}`);
  const extra = tx(`${V2ORDER()} ${FUND()} ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'fund', 500, 'stripe', 'pi_top', 'succeeded', 'fund:pi_top'); ${CHECK}`);
  const back = tx(`${V2ORDER()} ${FUND()} ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'refund', 2000, 'stripe', 're_1', 'succeeded', 'refund:re_1');
                   insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'fund', 2000, 'stripe', 'pi_again', 'succeeded', 'fund:pi_again'); ${CHECK}`);
  const cbAgain = tx(`${V2ORDER()} ${FUND()} ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key, note) values (${O}, 'chargeback', 3000, 'stripe', 'dp_3', 'succeeded', 'chargeback:dp_3', 'chargeback_lost');
                   insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'fund', 3000, 'stripe', 'pi_again', 'succeeded', 'fund:pi_again'); ${CHECK}`);
  vuln(!more.ok || !/paid_more_than_agreed/.test(pick(more, "check")) || !extra.ok || !/paid_more_than_agreed/.test(pick(extra, "check")) || !back.ok || pick(back, "check") !== "[]" || pick(cbAgain, "check") !== "[]",
    `P6p a €103.25 payment on a €100 Order -> ${more.ok ? "recorded, check " + pick(more, "check").slice(0, 70) : "REFUSED " + errOf(more)}; €5 more with no price increase -> ${extra.ok ? "recorded, check " + pick(extra, "check").slice(0, 50) : "REFUSED " + errOf(extra)}; €20 refunded and paid in again -> ${back.ok ? "check " + pick(back, "check") : errOf(back)}; €30 taken by a bank, then paid in again -> check ${pick(cbAgain, "check")} (must be recorded and listed, recorded and listed, nothing listed, nothing listed)`);
}
{ // P6q refunds, pull-backs and chargebacks name their Stripe object and a refund is written once. A refund or a
  // chargeback that really happened is always recorded, also when more went out than came in (a refund made in the
  // Stripe dashboard after the payout, as the webhook books it): the ledger check lists the Order instead
  const line = (kind, cents, ref, key, note = "") => `insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key, note) values (${O}, '${kind}', ${cents}, 'stripe', ${ref ? `'${ref}'` : "null"}, 'succeeded', '${key}', '${note}');`;
  const CHECK = `${owner} select 'check: ' || (public.admin_pricing_check()->'problems')::text;`;
  const noRef = tx(`${V2ORDER()} ${FUND()} ${svc()} ${line("refund", 1000, null, "refund:a")}`);
  const twice = tx(`${V2ORDER()} ${FUND()} ${svc()} ${line("refund", 1000, "re_1", "refund:re_1")} ${line("refund", 1000, "re_1", "refund:re_1b")}`);
  const afterAll = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, 500, 9500, "release:tr_1")} ${line("refund", 10000, "re_9", "refund:re_9", "dashboard_refund")} ${CHECK}`);
  const split = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(4000, 200, 3800, "release:tr_1")} ${line("refund", 6000, "re_6", "refund:re_6")} ${CHECK}`);
  const revNoRef = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, 500, 9500, "release:tr_1")} ${line("reversal", 9500, null, "reversal:x", "chargeback dp_1")}`);
  const cbMore = tx(`${V2ORDER()} ${FUND()} ${svc()} ${line("refund", 4000, "re_4", "refund:re_4")} ${line("chargeback", 10000, "dp_7", "chargeback:dp_7", "chargeback_lost")} ${CHECK}`);
  vuln(!/provider_ref_missing/.test(errOf(noRef)) || !/duplicate key/.test(errOf(twice)) || !afterAll.ok || !/more_out_than_in/.test(pick(afterAll, "check")) || pick(split, "check") !== "[]"
       || !/provider_ref_missing/.test(errOf(revNoRef)) || !cbMore.ok || !/more_out_than_in/.test(pick(cbMore, "check")),
    `P6q a refund with no Stripe id -> ${errOf(noRef)}; the same refund under another key -> ${errOf(twice)}; a €100 dashboard refund after €100 was paid out -> ${afterAll.ok ? "recorded, check " + pick(afterAll, "check").slice(0, 60) : "REFUSED " + errOf(afterAll)}; a split €40/€60 -> check ${pick(split, "check")}; a pull-back with no Stripe id -> ${errOf(revNoRef)}; a €100 chargeback after €40 was refunded -> ${cbMore.ok ? "recorded, check " + pick(cbMore, "check").slice(0, 60) : "REFUSED " + errOf(cbMore)}`);
}
{ // P6e a payout records the 5% kept. A line that does not say what was kept, or whose numbers don't add up within
  // the line, is badly written and refused. A payout that kept the wrong commission has happened at Stripe: it is
  // recorded as it happened and the ledger check lists the Order
  const ok = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, 500, 9500, "release:tr_1")} ${owner} ${COUNTERS()} ${PROBLEMS()}`);
  const more = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, 600, 9400, "release:tr_1")} ${PROBLEMS()}`);
  const less = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, 0, 10000, "release:tr_1")} ${PROBLEMS()}`);
  const sum = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, 500, 9600, "release:tr_1")}`);
  const nocom = tx(`${V2ORDER()} ${FUND()} ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'release', 10000, 'stripe', 'tr_1', 'succeeded', 'release:tr_1');`);
  vuln(pick(ok, "counters") !== "500" || kinds(pick(ok, "check")) !== "none" || !more.ok || kinds(pick(more, "check")) !== "commission_off" || !less.ok || kinds(pick(less, "check")) !== "commission_off"
       || !/order_payments_pricing_ok/.test(errOf(sum)) || !/commission_missing/.test(errOf(nocom)),
    `P6e €100 paid out, €5.00 kept -> totals ${pick(ok, "counters")}, check lists ${kinds(pick(ok, "check"))}; €6.00 kept -> ${more.ok ? "recorded, check lists " + kinds(pick(more, "check")) : "REFUSED " + errOf(more)}; nothing kept -> ${less.ok ? "recorded, check lists " + kinds(pick(less, "check")) : "REFUSED " + errOf(less)}; €96.00 sent with €5.00 kept -> ${errOf(sum)}; no commission stated -> ${errOf(nocom)}`);
}
{ // P6f rounding: half a cent and up rounds up, and over several payouts the total is exactly 5% of the whole
  const math = pick(run(`select 'm: ' || concat_ws('/', public.pricing_commission(10, 500), public.pricing_commission(9, 500), public.pricing_commission(30, 500), public.pricing_commission(3333, 500), public.pricing_commission(10000, 500), public.pricing_commission(0, 500));`), "m");
  const ms = `[{"title":"Part 1","amount_cents":3333},{"title":"Part 2","amount_cents":3333},{"title":"Part 3","amount_cents":3334}]`;
  const steps = tx(`${V2ORDER(10000, ms)} ${FUND()} ${svc()}
    select 'c1: ' || public.pricing_next_commission(${O}, 3333); ${REL(3333, 167, 3166, "release:tr_a")}
    select 'c2: ' || public.pricing_next_commission(${O}, 3333); ${REL(3333, 166, 3167, "release:tr_b")}
    select 'c3: ' || public.pricing_next_commission(${O}, 3334); ${REL(3334, 167, 3167, "release:tr_c")} ${owner} ${COUNTERS()}`);
  const halfCent = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10, 1, 9, "release:tr_h")} ${owner} ${COUNTERS()}`);
  // a payout that kept the wrong amount has happened: recorded, and the check lists the Order
  const threeCents = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(30, 3, 27, "release:tr_3")} ${PROBLEMS()}`);
  // rounding up every time is not the policy: the second €33.33 keeps 166 cents (running total), not 167
  const upAgain = tx(`${V2ORDER(10000, ms)} ${FUND()} ${svc()} ${REL(3333, 167, 3166, "release:tr_a")} ${REL(3333, 167, 3166, "release:tr_b")} ${PROBLEMS()}`);
  const late = tx(`${V2ORDER(10000, ms)} ${FUND()} ${svc()} ${REL(3333, 167, 3166, "release:tr_a")} ${REL(3333, 167, 3166, "release:tr_b", "release_late")} ${owner} ${COUNTERS()}`);
  // four payouts written afterwards from Stripe's record, each 2 cents kept on 30 (8 cents where 5% of €1.20 is 6): the
  // money has moved, so every line is recorded and the check lists the Order
  const drift = tx(`${V2ORDER()} ${FUND()} ${svc()} ${[1, 2, 3, 4].map(i => REL(30, 2, 28, "release:tr_d" + i, "release_late")).join(" ")} ${owner} select 'lines: ' || count(*) from public.order_payments where order_id = ${O} and kind = 'release'; ${PROBLEMS()}`);
  vuln(math !== "1/0/2/167/500/0" || `${pick(steps, "c1")}/${pick(steps, "c2")}/${pick(steps, "c3")}` !== "167/166/167" || pick(steps, "counters") !== "500"
       || pick(halfCent, "counters") !== "1" || !threeCents.ok || kinds(pick(threeCents, "check")) !== "commission_off" || !upAgain.ok || kinds(pick(upAgain, "check")) !== "commission_off" || pick(late, "counters") !== "334"
       || !drift.ok || pick(drift, "lines") !== "4" || kinds(pick(drift, "check")) !== "commission_off",
    `P6f 5% of 10/9/30/3333/10000/0 cents -> ${math} (must be 1/0/2/167/500/0); three parts of €33.33/€33.33/€33.34 -> ${pick(steps, "c1")}/${pick(steps, "c2")}/${pick(steps, "c3")}, in all ${pick(steps, "counters")} (must be 167/166/167, exactly €5.00); 10 cents keeping 1 -> ${pick(halfCent, "counters")}; 30 cents keeping 3 -> ${threeCents.ok ? "recorded, listed " + kinds(pick(threeCents, "check")) : "REFUSED " + errOf(threeCents)}; the second €33.33 rounded up again -> ${upAgain.ok ? "recorded, listed " + kinds(pick(upAgain, "check")) : "REFUSED " + errOf(upAgain)}; the same line written late from Stripe's record -> ${pick(late, "counters")} (334); four late 30-cent lines keeping 2 cents each -> ${drift.ok ? `${pick(drift, "lines")} lines recorded, listed ${kinds(pick(drift, "check"))}` : "REFUSED " + errOf(drift)}`);
}
{ // P6g paying the freelancer again after a won chargeback keeps nothing a second time; only after a won chargeback,
  // and never more than was pulled back. The re-payment line names the chargeback (a line that doesn't is badly written
  // and refused); a re-payment that broke one of the other rules has happened at Stripe: recorded, and listed
  const pulled = `${svc()} ${REL(10000, 500, 9500, "release:tr_1")} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key, note) values (${O}, 'reversal', 9500, 'stripe', 'trr_dp_1', 'succeeded', 'reversal:trr_dp_1', 'chargeback dp_1'); ${owner}`;
  const won = `update public.contracts set chargeback_id = 'dp_1', chargeback_status = 'won' where id = ${O};`;
  const W = "chargeback_won dp_1";
  const ok = tx(`${V2ORDER()} ${FUND()} ${pulled} ${won} ${svc()} ${REL(9500, 0, 9500, "release:tr_r", "repay", W)} ${owner} ${COUNTERS()} ${PROBLEMS()}`);
  const twice = tx(`${V2ORDER()} ${FUND()} ${pulled} ${won} ${svc()} ${REL(9500, 475, 9025, "release:tr_r", "repay", W)} ${PROBLEMS()}`);
  const noWin = tx(`${V2ORDER()} ${FUND()} ${pulled} ${svc()} ${REL(9500, 0, 9500, "release:tr_r", "repay", W)} ${PROBLEMS()}`);
  const noName = tx(`${V2ORDER()} ${FUND()} ${pulled} ${won} ${svc()} ${REL(9500, 0, 9500, "release:tr_r", "repay", "chargeback_won")}`);
  const tooMuch = tx(`${V2ORDER()} ${FUND()} ${pulled} ${won} ${svc()} ${REL(9500, 0, 9500, "release:tr_r", "repay", W)} ${REL(100, 0, 100, "release:tr_r2", "repay", W)} ${PROBLEMS()}`);
  // a pull-back by another chargeback (dp_0, lost) does not count towards re-paying this one
  const other = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, 500, 9500, "release:tr_1")} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key, note) values (${O}, 'reversal', 9500, 'stripe', 'trr_dp_0', 'succeeded', 'reversal:trr_dp_0', 'chargeback dp_0'); ${owner} ${won} ${svc()} ${REL(9500, 0, 9500, "release:tr_r", "repay", W)} ${PROBLEMS()}`);
  const listed = (r) => r.ok ? "recorded, listed " + kinds(pick(r, "check")) : "REFUSED " + errOf(r);
  vuln(pick(ok, "counters") !== "500" || kinds(pick(ok, "check")) !== "none" || !twice.ok || !/commission_off/.test(kinds(pick(twice, "check"))) || !noWin.ok || !/repay_off/.test(kinds(pick(noWin, "check")))
       || !/repay_line_names_chargeback/.test(errOf(noName)) || !tooMuch.ok || !/repay_off/.test(kinds(pick(tooMuch, "check"))) || !other.ok || !/repay_off/.test(kinds(pick(other, "check"))),
    `P6g a re-payment with nothing kept -> ${pick(ok, "counters")}, listed ${kinds(pick(ok, "check"))}; one keeping 5% again -> ${listed(twice)}; one with no won chargeback -> ${listed(noWin)}; one not naming the chargeback -> ${errOf(noName)}; more than was pulled back -> ${listed(tooMuch)}; using another chargeback's pull-back -> ${listed(other)}`);
}
{ // P6m never more of the client's money released (commission included) than was paid in, minus refunds and what a lost
  // chargeback took; never more sent to the freelancer, net of pull-backs
  const reversal = (cents, dp) => `insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key, note) values (${O}, 'reversal', ${cents}, 'stripe', 'trr_${dp}', 'succeeded', 'reversal:trr_${dp}', 'chargeback ${dp}');`;
  const won = `update public.contracts set chargeback_id = 'dp_1', chargeback_status = 'won' where id = ${O};`;
  // €40 paid out, €38 of it pulled back by a chargeback that was then won: the other €60 is paid out and the €38 re-paid
  // (the freelancer ends with €95.00, as agreed); paying the pulled-back €40 out again instead is refused
  const fine = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(4000, 200, 3800, "release:tr_1")} ${reversal(3800, "dp_1")} ${owner} ${won} ${svc()} ${REL(6000, 300, 5700, "release:tr_2")} ${REL(3800, 0, 3800, "release:tr_r", "repay", "chargeback_won dp_1")} ${owner} ${COUNTERS()} ${PROBLEMS()}`);
  // the money of these payouts has moved at Stripe by the time their line is written: they are recorded, and the check
  // lists the Order (normal payouts above what was paid in, so 5% kept twice; commission booked on money Cuvori no
  // longer has; or more sent out than came in)
  const again = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(4000, 200, 3800, "release:tr_1")} ${reversal(3800, "dp_1")} ${REL(6000, 300, 5700, "release:tr_2")} ${REL(4000, 200, 3800, "release:tr_3")} ${PROBLEMS()}`);
  // everything paid out, then 5.26 more
  const more = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, 500, 9500, "release:tr_1")} ${REL(526, 26, 500, "release:tr_2")} ${PROBLEMS()}`);
  // a split: €60 back to the client, €40 to the freelancer; then €10 more
  const refund = `insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'refund', 6000, 'stripe', 're_7', 'succeeded', 'refund:re_7');`;
  const split = tx(`${V2ORDER()} ${FUND()} ${svc()} ${refund} ${REL(4000, 200, 3800, "release:tr_5")} ${owner} ${COUNTERS()} ${PROBLEMS()}`);
  const over = tx(`${V2ORDER()} ${FUND()} ${svc()} ${refund} ${REL(4000, 200, 3800, "release:tr_5")} ${REL(1000, 50, 950, "release:tr_6")} ${PROBLEMS()}`);
  // the bank took the money (a lost chargeback while it was held), and then a payout
  const lost = tx(`${V2ORDER()} ${FUND()} ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key, note) values (${O}, 'chargeback', 10000, 'stripe', 'dp_5', 'succeeded', 'chargeback:dp_5', 'chargeback_lost'); ${REL(10000, 500, 9500, "release:tr_1")} ${PROBLEMS()}`);
  const listed = (r) => r.ok ? "recorded, listed " + kinds(pick(r, "check")) : "REFUSED " + errOf(r);
  vuln(pick(fine, "counters") !== "500" || kinds(pick(fine, "check")) !== "none" || !again.ok || kinds(pick(again, "check")) !== "commission_twice,commission_without_money" || !more.ok || kinds(pick(more, "check")) !== "commission_twice,commission_without_money"
       || pick(split, "counters") !== "200" || kinds(pick(split, "check")) !== "none" || !over.ok || kinds(pick(over, "check")) !== "more_out_than_in" || !lost.ok || kinds(pick(lost, "check")) !== "more_out_than_in",
    `P6m pulled back, the rest paid out and the pull-back re-paid -> ${pick(fine, "counters")}, listed ${kinds(pick(fine, "check"))}; the pulled-back money paid out again -> ${listed(again)}; €5.26 beyond everything -> ${listed(more)}; a split €60/€40 -> ${pick(split, "counters")}, listed ${kinds(pick(split, "check"))}; €10 more -> ${listed(over)}; a payout after a lost chargeback -> ${listed(lost)}`);
}
{ // P6r a payout made at Stripe whose line was lost (the Order counts it), then a full refund in the Stripe dashboard,
  // then the hourly repair writes the line from Stripe's record: the check sees the missing line, the repair line is
  // recorded (never refused, the money has moved), and the check then lists the money that went out twice
  const r = tx(`${V2ORDER()} ${FUND()} ${svc()} update public.contracts set released_cents = 4000 where id = ${O}; ${PROBLEMS("before")}
    ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key, note) values (${O}, 'refund', 10000, 'stripe', 're_d', 'succeeded', 'refund:re_d', 'dashboard_refund');
    ${REL(4000, 200, 3800, "release:tr_late", "release_late")} ${PROBLEMS("after")}`);
  vuln(!r.ok || kinds(pick(r, "before")) !== "line_missing" || kinds(pick(r, "after")) !== "more_out_than_in",
    `P6r a payout counted on the Order without its line -> check lists ${kinds(pick(r, "before"))}; after a €100 dashboard refund, the repair line for the €40 payout -> ${r.ok ? "recorded, check lists " + kinds(pick(r, "after")) : "REFUSED " + errOf(r)} (must be line_missing, then recorded and more_out_than_in)`);
}
{ // P6s every line under the new prices names exactly one Stripe object: a list of ids would let the same refund be
  // recorded twice ("re_A", then "re_A,re_B"), so a line with several ids is badly written and refused
  const line = (kind, ref, key, note = "") => `insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key, note) values (${O}, '${kind}', 1000, 'stripe', '${ref}', 'succeeded', '${key}', '${note}');`;
  const list = tx(`${V2ORDER()} ${FUND()} ${svc()} ${line("refund", "re_A", "refund:re_A")} ${line("refund", "re_A,re_B", "refund:re_AB")}`);
  const rev = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, 500, 9500, "release:tr_1")} ${line("reversal", "trr_1,trr_2", "reversal:trr_12", "chargeback dp_1")}`);
  const space = tx(`${V2ORDER()} ${FUND()} ${svc()} ${line("refund", "re_A re_B", "refund:re_sp")}`);
  const one = tx(`${V2ORDER()} ${FUND()} ${svc()} ${line("refund", "re_A", "refund:re_A")} ${line("refund", "re_B", "refund:re_B")} ${owner} select 'n: ' || count(*) from public.order_payments where order_id = ${O} and kind = 'refund';`);
  vuln(!/provider_ref_one_id/.test(errOf(list)) || !/provider_ref_one_id/.test(errOf(rev)) || !/provider_ref_one_id/.test(errOf(space)) || pick(one, "n") !== "2",
    `P6s a refund "re_A" and then "re_A,re_B" -> ${list.ok ? "BOTH RECORDED" : errOf(list)}; a pull-back naming two transfers -> ${rev.ok ? "RECORDED" : errOf(rev)}; ids with a space -> ${space.ok ? "RECORDED" : errOf(space)}; two refunds, one line each -> ${pick(one, "n")} lines (must be refused, refused, refused, 2)`);
}
{ // P6h there is no client fee to take or give back: no such kind of ledger line, under any plan
  const v2 = tx(`${V2ORDER()} ${FUND()} ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'client_fee_refund', 200, 'stripe', 're_1', 'succeeded', 'client_fee_refund:re_1');`);
  const legacy = tx(`${svc(false)} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status) values (${O3}, 'client_fee_refund', 200, 'stripe', 're_l', 'succeeded');`);
  vuln(!/order_payments_kind_check/.test(errOf(v2)) || !/order_payments_kind_check/.test(errOf(legacy)),
    `P6h a "client fee refunded" line on a plan 2 Order -> ${errOf(v2)}; on an Order from before v56 -> ${errOf(legacy)} (must be refused by the kinds the ledger has had since v21)`);
}
{ // P6i the totals come only from the ledger: nobody writes them by hand
  const tries = [["payment functions", svc()], ["owner", owner]].map(([who, role]) => `${who}: ${errOf(tx(`${V2ORDER()} ${FUND()} ${role} update public.contracts set commission_cents = 500 where id = ${O};`))}`);
  vuln(tries.some(s => !/pricing_counters_from_ledger_only/.test(s)), `P6i setting the totals by hand -> ${tries.join("; ")} (must be refused)`);
}
{ // P6j a plan 2 ledger line cannot be changed afterwards, except Stripe's real fee written in once
  const amt = tx(`${V2ORDER()} ${FUND()} update public.order_payments set amount_cents = 1 where order_id = ${O};`);
  const fee = tx(`${V2ORDER()} ${FUND()} ${svc()} update public.order_payments set provider_fee_cents = 181 where order_id = ${O}; ${owner} select 'pf: ' || provider_fee_cents from public.order_payments where order_id = ${O};`);
  const again = tx(`${V2ORDER()} ${FUND()} ${svc()} update public.order_payments set provider_fee_cents = 181 where order_id = ${O}; update public.order_payments set provider_fee_cents = 0 where order_id = ${O};`);
  const del = tx(`${V2ORDER()} ${FUND()} delete from public.order_payments where order_id = ${O};`);
  vuln(!/ledger_line_frozen/.test(errOf(amt)) || pick(fee, "pf") !== "181" || !/ledger_line_frozen/.test(errOf(again)) || !/append-only/.test(errOf(del)), `P6j changing a plan 2 line's amount -> ${errOf(amt)}; recording Stripe's fee -> ${pick(fee, "pf")}; changing it again -> ${errOf(again)}; deleting the line -> ${errOf(del)}`);
}
{ // P6l lines of today's prices (from before v56 too) can't be moved to a plan 2 Order or given plan 2 fields; Stripe's fee
  // and the card-fee refund are still added to them as today
  const L = `(select id from public.order_payments where order_id = ${O3} and kind = 'fund')`;
  const move = tx(`${V2ORDER()} ${svc(false)} update public.order_payments set order_id = ${O} where id = ${L};`);
  const fields = tx(`${svc()} update public.order_payments set commission_cents = 0, pricing_version = 2 where id = ${L};`);
  const amount = tx(`update public.order_payments set amount_cents = 1 where id = ${L};`);
  const cardFee = tx(`${svc(false)} update public.order_payments set fee_cents = 900 where id = ${L};`);
  const fee = tx(`${svc(false)} update public.order_payments set fee_refund_cents = 150, fee_refund_ref = 're_x' where id = ${L}; ${owner} select 'f: ' || fee_refund_cents from public.order_payments where id = ${L};`);
  vuln([move, fields, amount, cardFee].some(x => !/ledger_line_frozen/.test(errOf(x))) || pick(fee, "f") !== "150",
    `P6l an old line moved to a plan 2 Order -> ${errOf(move)}; given plan 2 fields -> ${errOf(fields)}; its amount changed -> ${errOf(amount)}; its card fee raised -> ${errOf(cardFee)}; its card-fee refund written as today -> ${pick(fee, "f")}`);
}
{ // P6x the freeze that starts the moment v56 runs, on lines of today's prices (from before v56 too): their kind, status, provider,
  // Stripe reference, payout fee and entry key can't be changed either, by the payment code or by you in the SQL editor
  const L = `(select id from public.order_payments where order_id = ${O3} and kind = 'fund')`;
  const tries = [["kind = 'refund'", "kind"], ["status = 'failed'", "status"], ["provider = 'paypal'", "provider"], ["provider_ref = 'pi_other'", "Stripe reference"], ["connect_cents = 1", "payout fee"], ["entry_key = 'fund:pi_x'", "entry key"]]
    .flatMap(([set, what]) => [["payment code", svc(false)], ["you", owner]].map(([who, role]) => [`${what} by ${who}`, tx(`${role} update public.order_payments set ${set} where id = ${L};`)]));
  const wrong = tries.filter(([, r]) => !/ledger_line_frozen/.test(errOf(r))).map(([what, r]) => `${what}: ${r.ok ? "CHANGED" : errOf(r)}`);
  vuln(wrong.length, `P6x a line of today's prices: its ${tries.length / 2} fixed fields changed by the payment code and by you -> ${wrong.length ? "not refused: " + wrong.join("; ") : "refused every time"}`);
}
{ // P6n the new fields belong to plan 2 lines: a plan 1 line (or one from before v56) cannot carry a commission or a payout purpose
  const legacy = tx(`${svc(false)} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, commission_cents, payout_cents, payout_purpose) values (${O3}, 'release', 1000, 'stripe', 'tr_l', 'succeeded', 50, 950, 'release');`);
  const plan1 = tx(`${CREATE(10000)} ${ACCEPT()} ${FUND1} ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key, commission_cents, payout_cents, payout_purpose) values (${O}, 'release', 1000, 'stripe', 'tr_1', 'succeeded', 'release:tr_1', 50, 950, 'release');`);
  vuln(!/pricing_fields_need_new_prices/.test(errOf(legacy)) || !/pricing_fields_need_new_prices/.test(errOf(plan1)),
    `P6n a commission on a line of an Order from before v56 -> ${errOf(legacy)}; on a plan 1 Order -> ${errOf(plan1)} (must be refused)`);
}
{ // P6t each line names its own kind of Stripe object: a payment pi_, a payout tr_, a refund re_ (or pyr_), a pull-back trr_,
  // a chargeback dp_ (or du_). A line naming the wrong one (a payout naming the payment, a pull-back naming the transfer)
  // would pass the first time and be refused the second time the same object came up (a second payout from one payment,
  // a second pull-back from one transfer), after Stripe has moved the money; so it is refused every time, and testing finds it
  const line = (kind, ref) => `insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key, note) values (${O}, '${kind}', 1000, 'stripe', '${ref}', 'succeeded', '${kind}:${ref}', '${kind === "reversal" ? "chargeback dp_1" : ""}');`;
  const base = `${V2ORDER()} ${FUND()} ${svc()}`;
  const wrong = [
    ["a payment naming a charge", tx(`${V2ORDER()} ${svc()} ${line("fund", "ch_1")}`)],
    ["a payout naming the payment", tx(`${base} ${REL(4000, 200, 3800, "release:pi_861")}`)],
    ["a refund naming the payment", tx(`${base} ${line("refund", "pi_861")}`)],
    ["a pull-back naming the transfer", tx(`${base} ${REL(10000, 500, 9500, "release:tr_1")} ${line("reversal", "tr_1")}`)],
    ["a chargeback naming the payment", tx(`${base} ${line("chargeback", "pi_861")}`)],
  ].filter(([, r]) => !/provider_ref_wrong_kind/.test(errOf(r))).map(([what, r]) => `${what}: ${r.ok ? "RECORDED" : errOf(r)}`);
  const right = [
    ["a refund pyr_", tx(`${base} ${line("refund", "pyr_1")}`)], ["a chargeback du_", tx(`${base} ${line("chargeback", "du_1")}`)],
    ["a pull-back trr_", tx(`${base} ${REL(10000, 500, 9500, "release:tr_1")} ${line("reversal", "trr_1")}`)],
  ].filter(([, r]) => !r.ok).map(([what, r]) => `${what}: ${errOf(r)}`);
  vuln(wrong.length || right.length, `P6t lines naming the wrong kind of Stripe object -> ${wrong.length ? "not refused: " + wrong.join("; ") : "all refused"}; the other Stripe forms -> ${right.length ? "refused: " + right.join("; ") : "recorded"} (must be refused; recorded)`);
}
{ // P6u a pull-back names its chargeback ("chargeback <dispute id>", as today's code writes it): the ledger check finds each
  // dispute's pull-backs by that note, so one with another note would raise false alarms or hide money
  const pull = (note) => tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, 500, 9500, "release:tr_1")} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'reversal', 9500, 'stripe', 'trr_1', 'succeeded', '${note}', 'reversal:trr_1'); ${owner} select 'n: ' || count(*) from public.order_payments where order_id = ${O} and kind = 'reversal';`);
  const other = pull("pull-back"), none = pull(""), right = pull("chargeback dp_1");
  vuln(!/reversal_line_names_chargeback/.test(errOf(other)) || !/reversal_line_names_chargeback/.test(errOf(none)) || pick(right, "n") !== "1",
    `P6u a pull-back noted "pull-back" -> ${other.ok ? "RECORDED" : errOf(other)}; with an empty note -> ${none.ok ? "RECORDED" : errOf(none)}; noted "chargeback dp_1" -> ${pick(right, "n")} line (must be refused, refused, 1)`);
}
{ // P6v a payout keeps between nothing and all of it: less than 0 or more than its amount is a badly written line
  const below = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, -1, 10001, "release:tr_1")}`), above = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, 10001, -1, "release:tr_1")}`);
  vuln(!/order_payments_pricing_ok/.test(errOf(below)) || !/order_payments_pricing_ok/.test(errOf(above)),
    `P6v a payout keeping -€0.01 -> ${below.ok ? "RECORDED" : errOf(below)}; keeping €100.01 of €100 -> ${above.ok ? "RECORDED" : errOf(above)} (must be refused)`);
}
{ // P6w a plan 2 line is never changed: not its note, not its charge id once written, not the part it belongs to (only a
  // deleted part may clear it)
  const ms = `[{"title":"Part 1","amount_cents":4000},{"title":"Part 2","amount_cents":6000}]`;
  const MS2 = `(select id from public.order_milestones where order_id = ${O} and position = 2)`;
  const base = `${V2ORDER(10000, ms)} ${FUND()} ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key, commission_cents, payout_cents, payout_purpose, milestone_id) values (${O}, 'release', 4000, 'stripe', 'tr_m', 'succeeded', 'release:tr_m', 200, 3800, 'release', ${MS1});`;
  const L = `(select id from public.order_payments where order_id = ${O} and kind = 'release')`;
  const note = tx(`${base} update public.order_payments set note = 'changed' where id = ${L};`);
  const charge = tx(`${base} update public.order_payments set charge_ref = 'ch_1' where id = ${L}; update public.order_payments set charge_ref = 'ch_2' where id = ${L};`);
  const chargeOnce = tx(`${base} update public.order_payments set charge_ref = 'ch_1' where id = ${L}; select 'c: ' || charge_ref from public.order_payments where id = ${L};`);
  const moved = tx(`${base} update public.order_payments set milestone_id = ${MS2} where id = ${L};`);
  const cleared = tx(`${base} update public.order_payments set milestone_id = null where id = ${L}; select 'm: ' || coalesce(milestone_id::text, 'none') from public.order_payments where id = ${L};`);
  vuln(!/ledger_line_frozen/.test(errOf(note)) || !/ledger_line_frozen/.test(errOf(charge)) || pick(chargeOnce, "c") !== "ch_1" || !/ledger_line_frozen/.test(errOf(moved)) || pick(cleared, "m") !== "none",
    `P6w a plan 2 payout line: its note changed -> ${note.ok ? "CHANGED" : errOf(note)}; its charge id written, then changed -> ${charge.ok ? "CHANGED" : errOf(charge)} (written once: ${pick(chargeOnce, "c")}); moved to another part -> ${moved.ok ? "MOVED" : errOf(moved)}; its part cleared (a deleted part) -> ${pick(cleared, "m")} (must be refused, refused (ch_1 once), refused, none)`);
}
{ // P6y a line's entry key has the form "kind:id" and a payout's purpose is one of release, release_late, repay
  const badKey = tx(`${V2ORDER()} ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'fund', 10000, 'stripe', 'pi_861', 'succeeded', 'no colon here');`);
  const badPurpose = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(4000, 200, 3800, "release:tr_1", "bonus")}`);
  vuln(!/order_payments_pricing_ok/.test(errOf(badKey)) || !/order_payments_pricing_ok/.test(errOf(badPurpose)),
    `P6y an entry key without its kind -> ${badKey.ok ? "RECORDED" : errOf(badKey)}; a payout with purpose "bonus" -> ${badPurpose.ok ? "RECORDED" : errOf(badPurpose)} (must be refused)`);
}
{ // P6o a plan 2 payment, payout or chargeback line names its Stripe object, so it can be written only once
  const noRef = tx(`${V2ORDER()} ${FUND()} ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, status, entry_key, commission_cents, payout_cents, payout_purpose) values (${O}, 'release', 10000, 'stripe', 'succeeded', 'release:a', 500, 9500, 'release');`);
  const twice = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(4000, 200, 3800, "release:tr_1")} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key, commission_cents, payout_cents, payout_purpose) values (${O}, 'release', 4000, 'stripe', 'tr_1', 'succeeded', 'release:tr_1b', 200, 3800, 'release');`);
  vuln(!/provider_ref_missing/.test(errOf(noRef)) || !/duplicate key/.test(errOf(twice)),
    `P6o a payout line without its Stripe transfer -> ${errOf(noRef)}; the same transfer under another key -> ${errOf(twice)} (must be refused)`);
}
{ // P6k only lines of money that really moved
  const r = tx(`${V2ORDER()} ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'fund', 10000, 'stripe', 'pi_861', 'pending', 'fund:pi_861');`);
  vuln(!/ledger_line_must_be_succeeded/.test(errOf(r)), `P6k a plan 2 line marked pending -> ${errOf(r)} (must be refused)`);
}

// ---------- P7 the old payment code ----------
{ // P7a without the new prices' header the payment functions cannot move a plan 2 Order's money or write its ledger
  const status = tx(`${V2ORDER()} ${FUND()} update public.contracts set status = 'delivered', delivery_url = '${LINK}' where id = ${O}; ${svc(false)} update public.contracts set status = 'releasing', split_editor_cents = 10000, resolution = 'release' where id = ${O};`);
  const funded = tx(`${V2ORDER()} ${svc(false)} update public.contracts set status = 'funded', funded_cents = 10000 where id = ${O};`);
  const line = tx(`${V2ORDER()} ${FUND()} ${svc(false)} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note) values (${O}, 'release', 10000, 'stripe', 'tr_old', 'succeeded', 'auto_release');`);
  const ms = `[{"title":"Part 1","amount_cents":4000},{"title":"Part 2","amount_cents":6000}]`;
  const mile = tx(`${V2ORDER(10000, ms)} ${FUND()} ${svc(false)} update public.order_milestones set status = 'approved', approved_at = now() where order_id = ${O} and position = 1;`);
  const mileNew = tx(`${V2ORDER(10000, ms)} ${FUND()} ${svc()} update public.order_milestones set status = 'approved', approved_at = now() where order_id = ${O} and position = 1; ${owner} select 'm: ' || status from public.order_milestones where order_id = ${O} and position = 1;`);
  vuln([status, funded, line, mile].some(x => x.ok || !/pricing_engine_too_old/.test(errOf(x))) || pick(mileNew, "m") !== "approved",
    `P7a old payment code on a plan 2 Order: release -> ${errOf(status)}; record a payment -> ${errOf(funded)}; write a payout line -> ${errOf(line)}; approve a milestone -> ${errOf(mile)}; the new code approving it -> ${pick(mileNew, "m")}`);
}
{ // P7d the old code takes a money key before it calls Stripe (the Order lock, a transfer or refund key): refused for a
  // plan 2 Order, so it never gets as far as Stripe; the new code and plan 1 Orders take theirs as today
  const keyOf = (prefix) => tx(`${V2ORDER()} ${FUND()} ${svc(false)} insert into public.money_keys (scope, key) select '${prefix}:' || id || ':x', '${prefix}:x' from public.contracts where conversation_id = ${CV}; ${owner} select 'k: ok';`);
  const transfer = keyOf("transfer"), others = ["refund", "reversal", "checkout"].map(p => `${p}: ${errOf(keyOf(p)).slice(0, 25)}`);
  const fresh = tx(`${V2ORDER()} ${FUND()} ${svc()} insert into public.money_keys (scope, key) select 'lock:' || id, 'claim:x' from public.contracts where conversation_id = ${CV}; ${owner} select 'k: ok';`);
  const v1 = tx(`${CREATE(10000)} ${ACCEPT()} ${svc(false)} insert into public.money_keys (scope, key) select 'lock:' || id, 'claim:x' from public.contracts where conversation_id = ${CV}; ${owner} select 'k: ok';`);
  const lockOld = tx(`${V2ORDER()} ${FUND()} ${svc(false)} insert into public.money_keys (scope, key) select 'lock:' || id, 'claim:x' from public.contracts where conversation_id = ${CV}; ${owner} select 'k: ok';`);
  vuln(!/pricing_engine_too_old/.test(errOf(lockOld)) || !/pricing_engine_too_old/.test(errOf(transfer)) || others.some(x => !/pricing_engine_too_old/.test(x)) || pick(fresh, "k") !== "ok" || pick(v1, "k") !== "ok",
    `P7d old code taking a plan 2 Order's lock -> ${errOf(lockOld)}; its transfer key -> ${errOf(transfer)}; ${others.join("; ")}; the new code taking the lock -> ${pick(fresh, "k")}; old code on a plan 1 Order -> ${pick(v1, "k")}`);
}
{ // P7e a header that is not exactly a plan number reads as code that knows no new prices (it can't open plan 2 by accident)
  const hdr = (h) => `set local role service_role; select set_config('request.jwt.claim.sub', '', true); select set_config('request.headers', '${h}', true);`;
  const fund = (h) => tx(`${V2ORDER()} ${hdr(h)} update public.contracts set status = 'funded', funded_cents = 10000, funded_at = now(), stripe_payment_intent = 'pi_861' where id = ${O};`);
  const cases = [['{"x-cuvori-pricing": "2x"}', "2x"], ['{"x-cuvori-pricing": " 2"}', "a space before 2"], ['{"x-cuvori-pricing": "2.0"}', "2.0"], ['not json', "not JSON at all"], ['{"x-cuvori-pricing": ""}', "empty"], ['{"x-cuvori-pricing": "1"}', "plan 1 only"]];
  const wrong = cases.map(([h, what]) => [what, fund(h)]).filter(([, r]) => !/pricing_engine_too_old/.test(errOf(r))).map(([what, r]) => `${what}: ${r.ok ? "ACCEPTED" : errOf(r)}`);
  vuln(wrong.length, `P7e a plan 2 payment with a badly formed header -> ${wrong.length ? "not refused as old code: " + wrong.join("; ") : "refused as old code every time"}`);
  // ... and the same on the ledger: a payout line from code that names only plan 1
  const ledger = tx(`${V2ORDER()} ${FUND()} ${hdr('{"x-cuvori-pricing": "1"}')} ${REL(10000, 500, 9500, "release:tr_h1")}`);
  vuln(ledger.ok || !/pricing_engine_too_old/.test(errOf(ledger)), `P7e' a plan 2 payout line from code that names only plan 1 -> ${ledger.ok ? "RECORDED" : errOf(ledger)} (must be pricing_engine_too_old)`);
}
{ // P7f every money field of a plan 2 Order is closed to the old payment code, each on its own (not only the status and
  // what was paid in): what was paid out or refunded, the dispute decision, every Stripe reference, the card costs, the
  // chargeback
  const fields = [["status", "'releasing'"], ["funded_cents", "9000"], ["released_cents", "1000"], ["refunded_cents", "1000"], ["split_editor_cents", "100"], ["refund_cents", "100"],
    ["resolution", "'release'"], ["stripe_checkout_id", "'cs_x'"], ["stripe_payment_intent", "'pi_x2'"], ["stripe_charge_id", "'ch_x'"], ["stripe_transfer_id", "'tr_x'"], ["stripe_refund_id", "'re_x'"],
    ["stripe_reversal_id", "'trr_x'"], ["quote", "'{\"total_cents\": 1}'"], ["fee_cents", "1"], ["connect_cents", "1"], ["paid_mode", "public.stripe_mode()"], ["funded_at", "now() - interval '1 day'"],
    ["chargeback_id", "'dp_x'"], ["chargeback_status", "'open'"], ["chargeback_cents", "100"]];
  const open = fields.map(([f, v]) => [f, tx(`${V2ORDER()} ${FUND()} ${svc(false)} update public.contracts set ${f} = ${v} where id = ${O};`)])
    .filter(([, r]) => !/pricing_engine_too_old/.test(errOf(r))).map(([f, r]) => `${f}: ${r.ok ? "CHANGED" : errOf(r).slice(0, 50)}`);
  vuln(open.length, `P7f the old payment code changing each of ${fields.length} money fields of a paid plan 2 Order -> ${open.length ? "not refused: " + open.join("; ") : "each refused"} (each must be pricing_engine_too_old)`);
}
{ // P7b ... and keeps working on every Order at today's prices
  const r = tx(`${CREATE(10000)} ${ACCEPT()} ${svc(false)} update public.contracts set status = 'funded', funded_cents = 10000, stripe_payment_intent = 'pi_old' where id = ${O};
                insert into public.order_payments (order_id, kind, amount_cents, fee_cents, provider, provider_ref, status, note) values (${O}, 'fund', 10000, 370, 'stripe', 'pi_old', 'succeeded', 'checkout');
                update public.contracts set status = 'releasing', split_editor_cents = 10000 where id = ${O};
                insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note) values (${O}, 'release', 10000, 'stripe', 'tr_old', 'succeeded', 'approve');
                update public.contracts set status = 'completed', released_cents = 10000 where id = ${O}; ${owner}
                select 'end: ' || status || '/' || released_cents || '/' || (select count(*) from public.order_payments where order_id = ${O}) from public.contracts where id = ${O};`);
  vuln(pick(r, "end") !== "completed/10000/2", `P7b old payment code on a plan 1 Order: pay, release, complete -> ${pick(r, "end")} (must work as today)`);
}
{ // P7c people's own steps on a plan 2 Order need no header: the freelancer delivers, the client opens a dispute
  const r = tx(`${V2ORDER()} ${FUND()} ${as("862")} select 'deliver: ' || public.order_action(${O}, 'deliver', 'done', '${LINK}', null); ${owner}
                ${as("861")} select 'dispute: ' || public.order_action(${O}, 'dispute', 'not as agreed', null, null); ${owner} ${STAMP()}`);
  vuln(pick(r, "deliver") !== "ok" || pick(r, "dispute") !== "ok" || pick(r, "stamp") !== "2/500/14/disputed", `P7c on a plan 2 Order the freelancer delivers -> ${pick(r, "deliver")}, the client disputes -> ${pick(r, "dispute")} (${pick(r, "stamp")})`);
}

// ---------- P8 reading ----------
{ // P8a the price breakdown and the money summary: both sides and the admin, nobody else
  const setup8 = `${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, 500, 9500, "release:tr_1")} update public.order_payments set provider_fee_cents = 178 where order_id = ${O} and kind = 'fund'; ${owner}`;
  const read = (who) => ({ b: pick(tx(`${setup8} ${as(who)} select 'b: ' || coalesce(public.order_price_breakdown(${O})::text, 'null'); ${owner}`), "b"),
                           s: pick(tx(`${setup8} ${as(who)} select 's: ' || coalesce(public.order_money_summary(${O})::text, 'null'); ${owner}`), "s") });
  const client = read("861"), free = read("862"), admin = read("401"), stranger = read("863"), anon = read("anon");
  const refused = (x) => x === "null" || /^error|permission denied/.test(x);
  const sum = (() => { try { return JSON.parse(client.s); } catch { return {}; } })();
  const brk = (() => { try { return JSON.parse(client.b); } catch { return {}; } })();
  const want = { funded_cents: 10000, released_cents: 10000, commission_cents: 500, payouts_cents: 9500, freelancer_earnings_cents: 9500 };
  const wrong = Object.entries(want).filter(([k, v]) => sum[k] !== v).map(([k, v]) => `${k} ${sum[k]} (want ${v})`);
  const adminSum = (() => { try { return JSON.parse(admin.s); } catch { return {}; } })();
  if (adminSum.processing_costs_cents !== 178) wrong.push(`the admin's card costs ${adminSum.processing_costs_cents} (want 178)`);
  if ("processing_costs_cents" in sum) wrong.push("the client sees Cuvori's card costs");
  if (/client_fee/.test(client.s + client.b)) wrong.push("a client fee appears");
  vuln(wrong.length || brk.commission_bps !== 500 || brk.freelancer_receives_cents !== 9500 || brk.client_pays_cents !== 10000 || brk.card_costs_paid_by !== "platform" || brk.review_days !== 14
       || free.s === "null" || admin.s === "null" || /^error|null/.test(free.b) || !refused(stranger.s) || !refused(anon.s) || !refused(stranger.b) || !refused(anon.b),
    `P8a after €100 paid and paid out: the client's summary ${wrong.length ? "WRONG: " + wrong.join(", ") : "right"}; breakdown client pays ${brk.client_pays_cents} (must be 10000), freelancer receives ${brk.freelancer_receives_cents}, card costs paid by ${brk.card_costs_paid_by}, days ${brk.review_days}; the freelancer reads it: ${free.s !== "null"}, the admin: ${admin.s !== "null"}; a stranger -> ${stranger.s.slice(0, 40)}, a visitor -> ${anon.s.slice(0, 40)}`);
}
{ // P8b the reports are the admin's
  const q = (who) => { const r = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, 500, 9500, "release:tr_1")} ${owner} ${as(who)} select 'r: ' || coalesce(public.admin_pricing_report(current_date - 1, current_date + 1)::text, 'null'); select 'k: ' || coalesce(public.admin_pricing_check()::text, 'null'); ${owner}`); return { r: pick(r, "r"), k: pick(r, "k") }; };
  const admin = q("401"), member = q("862"), anon = q("anon");
  const editor = (() => { const r = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, 500, 9500, "release:tr_1")} ${owner} select 'r: ' || public.admin_pricing_report(current_date - 1, current_date + 1)::text; select 's: ' || coalesce(public.order_money_summary(${O})::text, 'null');`); return { r: pick(r, "r"), s: pick(r, "s") }; })();
  vuln(!/"commission_cents": 500/.test(admin.r) || !/"orders_checked"/.test(admin.k) || !/"commission_cents": 500/.test(editor.r) || !/"processing_costs_cents"/.test(editor.s) || !(/"error": "forbidden"|^error|permission denied/.test(member.r) || member.r === "null") || !(/"error": "forbidden"|^error|permission denied/.test(member.k) || member.k === "null") || !(/"error": "forbidden"|^error|permission denied/.test(anon.r) || anon.r === "null") || !(/"error": "forbidden"|^error|permission denied/.test(anon.k) || anon.k === "null"),
    `P8b the commission report and the ledger check -> admin: ${admin.r.slice(0, 90)} / ${admin.k.slice(0, 60)}; you in the SQL editor: ${editor.r.slice(0, 60)} / summary ${editor.s.slice(0, 40)}; a freelancer: ${member.r.slice(0, 40)}; a visitor: ${anon.r.slice(0, 40)}`);
}
{ // P8h the commission report per freelancer: what each one was paid out, the 5% kept, what was sent and pulled back
  const r = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(4000, 200, 3800, "release:tr_1")} ${REL(6000, 300, 5700, "release:tr_2")}
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'reversal', 3800, 'stripe', 'trr_1', 'succeeded', 'chargeback dp_1', 'reversal:trr_1'); ${owner}
    select 'f: ' || (public.admin_pricing_report(current_date - 1, current_date + 1)->'by_freelancer')::text;`);
  const f = (() => { try { return JSON.parse(pick(r, "f")); } catch { return []; } })();
  const tom = f[0] || {};
  vuln(f.length !== 1 || tom.released_cents !== 10000 || tom.commission_cents !== 500 || tom.payouts_cents !== 9500 || tom.pulled_back_cents !== 3800 || tom.payouts !== 2,
    `P8h the report per freelancer after €40 and €60 paid out and €38 pulled back -> ${pick(r, "f").slice(0, 220)} (must be one freelancer: 10000 paid out, 500 kept, 9500 sent, 3800 pulled back, 2 payouts)`);
}
{ // P8i the money summary says what is still held (refunds taken off), what was pulled back and what was paid again
  const r = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(4000, 200, 3800, "release:tr_1")} update public.contracts set released_cents = 4000 where id = ${O};
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'reversal', 3800, 'stripe', 'trr_1', 'succeeded', 'chargeback dp_1', 'reversal:trr_1');
    update public.contracts set released_cents = 200, chargeback_id = 'dp_1', chargeback_status = 'won' where id = ${O};
    ${REL(3800, 0, 3800, "release:tr_2", "repay", "chargeback_won dp_1")} update public.contracts set released_cents = 4000 where id = ${O};
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'refund', 1000, 'stripe', 're_1', 'succeeded', 'refund:re_1');
    update public.contracts set refunded_cents = 1000 where id = ${O}; ${owner}
    select 's: ' || public.order_money_summary(${O})::text;`);
  const sm = (() => { try { return JSON.parse(pick(r, "s")); } catch { return {}; } })();
  vuln(sm.held_cents !== 5000 || sm.reversed_cents !== 3800 || sm.repaid_cents !== 3800,
    `P8i €100 paid in, €40 paid out, €38 pulled back and paid again, €10 refunded -> held ${sm.held_cents}, pulled back ${sm.reversed_cents}, paid again ${sm.repaid_cents} (must be 5000, 3800, 3800)`);
}
{ // P8j the commission report refuses dates the wrong way round; an Order at today's prices has a breakdown without a commission
  const dates = tx(`${owner} select 'r: ' || (public.admin_pricing_report(current_date + 1, current_date - 1))::text;`);
  const one = tx(`${CREATE(10000)} ${ACCEPT()} ${as("861")} select 'b: ' || coalesce(public.order_price_breakdown(${O})::text, 'null'); ${owner}`);
  const b = (() => { try { return JSON.parse(pick(one, "b")); } catch { return {}; } })();
  vuln(!/bad_dates/.test(pick(dates, "r")) || b.pricing_version !== 1 || b.commission_bps !== 0 || b.freelancer_receives_cents !== 10000,
    `P8j the report from tomorrow to yesterday -> ${pick(dates, "r").slice(0, 60)}; a plan 1 Order's breakdown -> plan ${b.pricing_version}, ${b.commission_bps} bps, freelancer receives ${b.freelancer_receives_cents} (must be bad_dates; 1, 0, 10000)`);
}
{ // P8c the ledger check finds an Order whose payouts do not add up to 5% of the whole
  const r = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(30, 2, 28, "release:tr_x", "release_late")} ${REL(30, 2, 28, "release:tr_y", "release_late")} ${owner} ${as("401")} select 'k: ' || public.admin_pricing_check()::text; ${owner}`);
  vuln(!/"commission_off"/.test(pick(r, "k")), `P8c two payouts of 30 cents keeping 2 cents each (4 cents; 5% of 60 cents is 3) -> the admin's check: ${pick(r, "k").slice(0, 160)} (must name the Order)`);
}

{ // P8d an Order paid directly under plan 2 (no fee, no commission) is not in the commission report
  const act = (who, action) => `${as(who)} select '${action}: ' || public.order_action(${O}, '${action}', null, null, null); ${owner}`;
  const r = tx(`${V2ON} ${CREATE(10000, "direct")} ${ACCEPT()} ${act("861", "mark_paid")} ${act("862", "confirm_paid")} ${act("861", "complete")}
                select 'lines: ' || count(*) || '/' || min(pricing_version) from public.order_payments where order_id = ${O};
                ${as("401")} select 'r: ' || public.admin_pricing_report(current_date - 1, current_date + 1)::text; ${owner}`);
  vuln(pick(r, "complete") !== "ok" || pick(r, "lines") !== "2/2" || !/"by_freelancer": \[\]/.test(pick(r, "r")) || !/"payouts_cents": 0/.test(pick(r, "r")),
    `P8d a direct plan 2 Order paid and completed -> ${pick(r, "complete")}, its lines ${pick(r, "lines")}; the report: ${pick(r, "r").slice(0, 160)} (must show no payouts)`);
}

{ // P8e the report's dates are German dates: a payout at 00:30 on 1 November in Germany (23:30 on 31 October in UTC)
  // belongs to November
  const late = `insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key, commission_cents, payout_cents, payout_purpose, created_at)
                values (${O}, 'release', 10000, 'stripe', 'tr_n', 'succeeded', 'release:tr_n', 500, 9500, 'release', '2026-10-31 23:30:00+00');`;
  const r = tx(`${V2ORDER()} ${FUND()} ${svc()} ${late} ${owner} select 'oct: ' || (public.admin_pricing_report('2026-10-01', '2026-10-31')->'totals'->>'commission_cents');
                select 'nov: ' || (public.admin_pricing_report('2026-11-01', '2026-11-30')->'totals'->>'commission_cents');`);
  vuln(pick(r, "oct") !== "0" || pick(r, "nov") !== "500", `P8e a payout at 00:30 on 1 November, German time -> October report ${pick(r, "oct")}, November report ${pick(r, "nov")} (must be 0 and 500)`);
}
{ // P8f a chargeback lost after the payout: the freelancer's €95 is pulled back, the bank kept the €100. The report shows
  // the pull-back, and the ledger check asks the admin to decide about the €5 commission still booked (owner's decision)
  const r = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, 500, 9500, "release:tr_1")}
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'reversal', 9500, 'stripe', 'trr_1', 'succeeded', 'chargeback dp_1', 'reversal:trr_1');
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'chargeback', 10000, 'stripe', 'dp_1', 'succeeded', 'chargeback_lost', 'chargeback:dp_1');
    update public.contracts set chargeback_id = 'dp_1', chargeback_status = 'lost' where id = ${O}; ${owner}
    select 'report: ' || (public.admin_pricing_report(current_date - 1, current_date + 1)->'totals')::text;
    select 'decide: ' || coalesce((public.admin_pricing_check()->'to_decide')::text, 'none'); select 'problems: ' || (public.admin_pricing_check()->'problems')::text;`);
  vuln(!/"pulled_back_cents": 9500/.test(pick(r, "report")) || !/"charged_back_cents": 10000/.test(pick(r, "report")) || !/commission_on_lost_chargeback/.test(pick(r, "decide")) || pick(r, "problems") !== "[]",
    `P8f a chargeback lost after the payout -> report ${pick(r, "report").slice(0, 160)}; to decide: ${pick(r, "decide").slice(0, 120)}; problems: ${pick(r, "problems")} (the report must show the €95 pulled back and the €100 the bank took, the check must list the €5 commission to decide and no problem)`);
}
{ // P8g an Order paid directly (outside Cuvori) under the new prices: Cuvori pays no card costs on it, and its summaries
  // don't say it does; an Order paid through Cuvori says Cuvori pays them
  const read = (mode) => { const r = tx(`${V2ON} ${CREATE(10000, mode)} ${ACCEPT()} ${as("861")} select 'bv: ' || coalesce(public.order_price_breakdown(${O})->>'card_costs_paid_by', 'none'); ${owner} select 's: ' || coalesce(public.order_money_summary(${O})->>'card_costs_paid_by', 'none');
      select 'doc: ' || coalesce(terms_doc->'prices'->>'card_costs_paid_by', 'none') from public.contracts where id = ${O};`);
    return { b: pick(r, "bv"), s: pick(r, "s"), doc: pick(r, "doc") }; };
  const direct = read("direct"), escrow = read("escrow");
  vuln(direct.b !== "none" || direct.s !== "none" || direct.doc !== "none" || escrow.b !== "platform" || escrow.s !== "platform" || escrow.doc !== "platform",
    `P8g card costs paid by, on a direct plan 2 Order -> breakdown ${direct.b}, summary ${direct.s}, agreed text ${direct.doc} (must be none, none, none); on a plan 2 Order paid through Cuvori -> ${escrow.b}, ${escrow.s}, ${escrow.doc} (must be platform)`);
}

// ---------- P9 who may call what ----------
{
  const fns = ["pricing_switch_to(integer, text)", "pricing_next_commission(uuid, integer)", "contracts_pricing()", "order_payments_pricing()", "order_payments_pricing_totals()", "order_payments_pricing_frozen()", "order_milestones_pricing()", "pricing_plans_guard()", "pricing_switch_logged()",
    "money_keys_pricing()", "order_amendments_pricing()", "pricing_engine()", "pricing_staff()"];
  const r = run(`select 'x: ' || coalesce(string_agg(f || ' by ' || r, ', '), 'none') from unnest(array[${fns.map(f => `'public.${f}'`).join(",")}]) f cross join (values ('anon'), ('authenticated')) x(r)
                 where to_regprocedure(f) is null or has_function_privilege(r, to_regprocedure(f), 'execute');`);
  const svcOnly = run(`select 'y: ' || (to_regprocedure('public.pricing_switch_to(integer, text)') is not null and not has_function_privilege('service_role', 'public.pricing_switch_to(integer, text)', 'execute'));`);
  const rls = run(`select 'z: ' || coalesce(string_agg(relname || '=' || relrowsecurity, ','), 'none') from pg_class where relnamespace = 'public'::regnamespace and relname in ('pricing_plans', 'pricing_switch', 'pricing_switch_log');`);
  vuln(pick(r, "x") !== "none" || pick(svcOnly, "y") !== "true" || pick(rls, "z").split(",").length !== 3 || /false/.test(pick(rls, "z")),
    `P9 internal functions callable by visitors or members (or missing) -> ${pick(r, "x").slice(0, 200)}; the switch closed to the payment functions: ${pick(svcOnly, "y")}; row security on the new tables: ${pick(rls, "z")}`);
}
{ // P9c the reports are "you in the SQL editor" only when the request does not come through the website: Supabase's
  // API signs in to the database as "authenticator", and a request there with no person signed in (a visitor, or the
  // payment functions) must not count as you. (The test database has no such role of its own: it is made here.)
  const VIA_API = (role) => `do $x$ begin if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator noinherit; end if; end $x$;
    grant anon, authenticated, service_role to authenticator; set session authorization authenticator; set role ${role};
    select set_config('request.jwt.claim.sub', '', true); select set_config('request.headers', '', true);`;
  const ask = (role) => `${VIA_API(role)} select 'k: ' || coalesce(public.admin_pricing_check()->>'error', 'answered'); select 'r: ' || coalesce(public.admin_pricing_report(current_date - 1, current_date + 1)->>'error', 'answered');
    select 's: ' || coalesce(public.order_money_summary(${O})::text, 'nothing'); reset role; reset session authorization;`;
  const member = tx(`${V2ORDER()} ${FUND()} ${ask("authenticated")}`);
  const fns = tx(`${V2ORDER()} ${FUND()} grant execute on function public.admin_pricing_check(), public.admin_pricing_report(date, date), public.order_money_summary(uuid) to service_role; ${ask("service_role")}`);
  const editor = tx(`${V2ORDER()} ${FUND()} ${owner} select 'k: ' || coalesce(public.admin_pricing_check()->>'error', 'answered'); select 's: ' || (public.order_money_summary(${O}) is not null);`);
  const seen = (r) => `check ${pick(r, "k")}, report ${pick(r, "r")}, summary ${pick(r, "s").slice(0, 30)}`;
  vuln(pick(member, "k") !== "forbidden" || pick(member, "r") !== "forbidden" || pick(member, "s") !== "nothing"
       || pick(fns, "k") !== "forbidden" || pick(fns, "r") !== "forbidden" || pick(fns, "s") !== "nothing" || pick(editor, "k") !== "answered" || pick(editor, "s") !== "true",
    `P9c through the website with nobody signed in, as a member -> ${seen(member)}; as the payment functions (even if they could call them) -> ${seen(fns)}; you in the SQL editor -> check ${pick(editor, "k")}, summary ${pick(editor, "s")} (must be forbidden/forbidden/nothing twice, then answered)`);
}

// ---------- P10 undoing v56 (supabase/undo_v56.sql), each time rolled back ----------
{
  const UNDO = path.join(root, "supabase/undo_v56.sql");
  const acceptFp = "select 'fp: ' || md5(replace(prosrc, chr(13), '')) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'order_accept';";
  const switchedOn = fs.existsSync(UNDO) ? run(`begin;\n${SETUP}\n${V2ON}\n\\i ${UNDO}\nrollback;`) : { ok: true, out: "", err: "" };
  const inUse = fs.existsSync(UNDO) ? run(`begin;\n${SETUP}\n${V2ORDER()}\n${owner} select public.pricing_switch_to(1, 'back');\n\\i ${UNDO}\nrollback;`) : { ok: true, out: "", err: "" };
  const shape = "select 'shape: ' || (select pg_get_constraintdef(oid) from pg_constraint where conname = 'order_payments_kind_check') || ' / ' || (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'contracts' and column_name = 'auto_days');";
  const undo = fs.existsSync(UNDO) ? run(`begin;\n\\i ${UNDO}\n${snapContracts(false).replace("select md5", "select 'c: ' || md5")};\n${snapPayments(false).replace("select md5", "select 'p: ' || md5")};\n${acceptFp}\n${FP("order_terms_snapshot")}\n${shape}\n${FNS}\n\\i ${V56}\nrollback;`) : { ok: false, out: "", err: "ERROR: supabase/undo_v56.sql does not exist" };
  const undone = /v56 undone/.test(undo.out), again = (undo.out.match(/v56 applied/g) || []).length === 1;
  vuln(switchedOn.ok || !/switch is on/.test(errOf(switchedOn)) || inUse.ok || !/Orders use the new prices/.test(errOf(inUse)) || !undone || pick(undo, "c") !== before.c || pick(undo, "p") !== before.p || pick(undo, "fp") !== "c046736ac80ee3ce57c9daa7828020f3" || pick(undo, "fp") !== fpBefore.accept || pick(undo, "order_terms_snapshot") !== fpBefore.terms || !/^[0-9a-f]{32}$/.test(fpBefore.terms) || !again
       || pick(undo, "shape") !== "CHECK ((kind = ANY (ARRAY['fund'::text, 'release'::text, 'refund'::text, 'reversal'::text, 'chargeback'::text]))) / 7"
       || !/^[0-9a-f]{32}$/.test(fnsBefore) || pick(undo, "fns") !== fnsBefore,
    `P10 every function after undo exactly as before v56 (none left behind, none missing): ${pick(undo, "fns") === fnsBefore}; undo with the switch on -> ${errOf(switchedOn).slice(0, 40)}; switched back but with a plan 2 Order -> ${errOf(inUse).slice(0, 50)}; with none -> ${undone ? "undone" : errOf(undo)}; Orders/ledger as before v56: ${pick(undo, "c") === before.c}/${pick(undo, "p") === before.p}; Accept exactly v38's (live fingerprint): ${pick(undo, "fp") === "c046736ac80ee3ce57c9daa7828020f3"}, Accept and the agreed text exactly as before v56: ${pick(undo, "fp") === fpBefore.accept}/${pick(undo, "order_terms_snapshot") === fpBefore.terms}; v56 again afterwards: ${again}; ledger kinds and the days' default after undo: ${pick(undo, "shape").slice(0, 160)}`);
}

{ // P10b undo refuses once the payment code for the new prices has written a ledger line (it writes an entry key on every
  // line, also at today's prices; today's code never does): undo would take away what that code writes, and every money
  // step would then fail after Stripe has moved the money. And undo, like v56, waits only briefly for a busy table.
  const UNDO = path.join(root, "supabase/undo_v56.sql");
  const usrc = fs.existsSync(UNDO) ? fs.readFileSync(UNDO, "utf8") : "";
  const newCode = fs.existsSync(UNDO) ? run(`begin;\n${SETUP}\n${CREATE(10000)} ${ACCEPT()} ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'fund', 10000, 'stripe', 'pi_new', 'succeeded', 'fund:pi_new'); ${owner}\n\\i ${UNDO}\nrollback;`) : { ok: true, out: "", err: "" };
  const w = lockWait(usrc), w56 = lockWait(fs.existsSync(V56) ? fs.readFileSync(V56, "utf8") : "");
  const held = holdTable("money_keys");
  const busy = fs.existsSync(UNDO) ? timed(() => run(`\\i ${UNDO}`)) : { ok: true, ms: 0, out: "", err: "" };
  held();
  const still = pick(run("select 'there: ' || (to_regclass('public.pricing_plans') is not null);"), "there");
  // every table undo changes or drops, locked before its first change: v56's five and v56's own three
  const touched = [...new Set([...usrc.matchAll(/alter table public\.([a-z_]+)|on public\.([a-z_]+);|drop table if exists public\.([a-z_]+)/g)].map(m => m[1] || m[2] || m[3]))];
  const sameTables = w56.tables.length > 0 && w56.tables.every(t => w.tables.includes(t)) && touched.every(t => w.tables.includes(t));
  vuln(!held.ok || newCode.ok || !/payment code for the new prices/.test(errOf(newCode)) || !sameTables || !(w.worst + 3000 <= FN_WAIT_MS) || busy.ok || !/lock timeout/.test(errOf(busy)) || busy.ms > 2500 || still !== "true",
    `P10b ${held.ok ? "" : "(money_keys was never made busy: this check proved nothing) "}undo after the new payment code wrote a line at today's prices -> ${newCode.ok ? (/v56 undone/.test(newCode.out) ? "UNDONE" : "ran") : errOf(newCode).slice(0, 80)}; it locks ${w.tables.join(", ") || "nothing"} first (${sameTables ? "every table it changes" : "not every table it changes: " + touched.filter(t => !w.tables.includes(t)).join(", ")}), ${w.per} ms each; with a payment busy -> ${busy.ok ? "ran anyway" : errOf(busy).slice(0, 50)} after ${busy.ms} ms; v56 still there: ${still} (must refuse naming the payment code; lock every table it changes, at most ${FN_WAIT_MS - 3000} ms at worst; stop within 2.5 s)`);
}

// ---------- P11 the 14 days, valid delivery and disputes ----------
{ // P11a plan 2: the 14 days start with a valid delivery, a link to the work; plan 1 Orders deliver as today (7 days, link optional)
  const nolink = tx(`${V2ORDER()} ${FUND()} ${ACT("862", "deliver")}`);
  const badlink = tx(`${V2ORDER()} ${FUND()} ${ACT("862", "deliver", "x", "http://example.com/x")}`);
  const ok = tx(`${V2ORDER()} ${FUND()} ${ACT("862", "deliver", "x", LINK)} ${WINDOW()} ${STAMP()}`);
  const v1 = tx(`${CREATE(10000)} ${ACCEPT()} ${FUND1} ${ACT("862", "deliver")} ${WINDOW()} ${STAMP()}`);
  vuln(!/link_required/.test(errOf(nolink)) || pick(badlink, "deliver") !== "bad_link" || pick(ok, "deliver") !== "ok" || pick(ok, "days") !== "14" || pick(ok, "stamp") !== "2/500/14/delivered"
       || pick(v1, "deliver") !== "ok" || pick(v1, "days") !== "7",
    `P11a plan 2 delivery with no link -> ${errOf(nolink)}; with an http:// link -> ${pick(badlink, "deliver")}; with a link -> ${pick(ok, "deliver")}, released automatically after ${pick(ok, "days")} days (${pick(ok, "stamp")}); a plan 1 Order with no link -> ${pick(v1, "deliver")}, ${pick(v1, "days")} days (must be link_required, bad_link, 14, and as today 7)`);
}
{ // P11b plan 2 milestones: a part is handed in with a link to it, and has 14 days
  const ms = `[{"title":"Part 1","amount_cents":4000},{"title":"Part 2","amount_cents":6000}]`;
  const nolink = tx(`${V2ORDER(10000, ms)} ${FUND()} ${MSACT("862", "submit")}`);
  const ok = tx(`${V2ORDER(10000, ms)} ${FUND()} ${MSACT("862", "submit", LINK)} ${WINDOW("days", "milestones")}`);
  const v1 = tx(`${CREATE(10000, "escrow", ms)} ${ACCEPT()} ${FUND1} ${MSACT("862", "submit")} ${WINDOW("days", "milestones")}`);
  vuln(!/link_required/.test(errOf(nolink)) || pick(ok, "submit") !== "ok" || pick(ok, "days") !== "14" || pick(v1, "submit") !== "ok" || pick(v1, "days") !== "7",
    `P11b plan 2 part handed in with no link -> ${errOf(nolink)}; with a link -> ${pick(ok, "submit")}, ${pick(ok, "days")} days; plan 1 with no link -> ${pick(v1, "submit")}, ${pick(v1, "days")} days (must be link_required, 14, and as today 7)`);
}
{ // P11c an Order agreed before the switch keeps its 7 days after the switch (an existing agreement is never changed)
  const r = tx(`${CREATE(10000)} ${ACCEPT()} ${V2ON} ${FUND1} ${ACT("862", "deliver")} ${WINDOW()} ${STAMP()}`);
  vuln(pick(r, "deliver") !== "ok" || pick(r, "days") !== "7" || pick(r, "stamp") !== "1/0/7/delivered",
    `P11c agreed at today's prices, the switch moves, then delivered -> ${pick(r, "deliver")}, ${pick(r, "days")} days, ${pick(r, "stamp")} (must be 7 days, plan 1)`);
}
{ // P11d changes asked for within the paid rounds stop the clock; the next delivery gets a full 14 days again
  const r = tx(`${V2ORDER()} ${FUND()} ${ACT("862", "deliver", "x", LINK, "first")} ${ACT("861", "request_changes", "please fix the music")}
                select 'stopped: ' || coalesce(auto_release_at::text, 'none') || '/' || status from public.contracts where id = ${O};
                update public.contracts set delivered_at = delivered_at - interval '9 days' where id = ${O};
                ${ACT("862", "deliver", "x", LINK, "again")} ${WINDOW()}
                select 'fresh: ' || (auto_release_at > now() + interval '13 days 23 hours') from public.contracts where id = ${O};`);
  vuln(pick(r, "request_changes") !== "ok" || pick(r, "stopped") !== "none/funded" || pick(r, "again") !== "ok" || pick(r, "days") !== "14" || pick(r, "fresh") !== "true",
    `P11d changes requested -> ${pick(r, "request_changes")}, clock ${pick(r, "stopped")}; delivered again -> ${pick(r, "again")}, ${pick(r, "days")} days from now: ${pick(r, "fresh")} (must stop, then a full 14 days)`);
}
{ // P11e a dispute stops the clock, and nothing is paid out of the held payment while it is open: not a part handed in, not
  // by the new code, not by the old; the same while the bank has a chargeback open. A payout already made is still recorded.
  const ms = `[{"title":"Part 1","amount_cents":4000},{"title":"Part 2","amount_cents":6000}]`;
  const claim = (code) => `${svc(code)} update public.order_milestones set status = 'approved', approved_at = now(), auto_release_at = null where id = ${MS1}; ${owner} select 'm: ' || status from public.order_milestones where id = ${MS1};`;
  const disputed = tx(`${V2ORDER(10000, ms)} ${FUND()} ${MSACT("862", "submit", LINK)} ${ACT("861", "dispute", "not as agreed")}
                       select 'paused: ' || coalesce((select auto_release_at::text from public.order_milestones where id = ${MS1}), 'none') || '/' || coalesce((select auto_release_at::text from public.contracts where id = ${O}), 'none');
                       ${claim(true)}`);
  const chargeback = tx(`${V2ORDER(10000, ms)} ${FUND()} ${MSACT("862", "submit", LINK)} update public.contracts set chargeback_id = 'dp_1', chargeback_status = 'open' where id = ${O}; ${claim(true)}`);
  const plan1 = tx(`${CREATE(10000, "escrow", ms)} ${ACCEPT()} ${FUND1} ${MSACT("862", "submit")} ${ACT("861", "dispute", "not as agreed")} ${claim(false)}`);
  const open = tx(`${V2ORDER(10000, ms)} ${FUND()} ${MSACT("862", "submit", LINK)} ${claim(true)}`);
  const made = tx(`${V2ORDER(10000, ms)} ${FUND()} ${MSACT("862", "submit", LINK)} ${claim(true)} ${ACT("861", "dispute", "not as agreed")}
                   ${svc()} update public.order_milestones set status = 'released', released_at = now(), transfer_ref = 'tr_m1' where id = ${MS1}; ${owner} select 'rec: ' || status from public.order_milestones where id = ${MS1};`);
  vuln(pick(disputed, "dispute") !== "ok" || pick(disputed, "paused") !== "none/none" || !/release_paused/.test(errOf(disputed)) || !/release_paused/.test(errOf(chargeback)) || !/release_paused/.test(errOf(plan1))
       || pick(open, "m") !== "approved" || pick(made, "dispute") !== "ok" || pick(made, "rec") !== "released",
    `P11e a part handed in, then a dispute -> ${pick(disputed, "dispute")}, clocks ${pick(disputed, "paused")}; paying the part out now -> ${errOf(disputed)}; with a chargeback open -> ${errOf(chargeback)}; a plan 1 Order in dispute -> ${errOf(plan1)}; no dispute -> ${pick(open, "m")}; a payout begun before the dispute is recorded -> ${pick(made, "rec")}`);
}
{ // P11f Cuvori's decision on a dispute still goes through: release, refund or divide; 5% is kept only on what the freelancer gets
  const decide = `${svc()} update public.contracts set status = 'resolving', resolution = 'split', split_editor_cents = 4000, refund_cents = 6000, resolved_at = now() where id = ${O};
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'refund', 6000, 'stripe', 're_s', 'succeeded', 'refund:re_s');
    ${REL(4000, 200, 3800, "release:tr_s")} update public.contracts set status = 'completed', released_cents = 4000, refunded_cents = 6000 where id = ${O}; ${owner}`;
  const r = tx(`${V2ORDER()} ${FUND()} ${ACT("862", "deliver", "x", LINK)} ${ACT("861", "dispute", "not as agreed")} ${decide} ${STAMP()} ${COUNTERS()} ${PROBLEMS()}`);
  // the same decision done wrongly: the 5% taken from the client's refund (€57 back instead of €60)
  const wrongSplit = tx(`${V2ORDER()} ${FUND()} ${ACT("862", "deliver", "x", LINK)} ${ACT("861", "dispute", "not as agreed")} ${decide.replace("'refund', 6000", "'refund', 5700").replace("refunded_cents = 6000", "refunded_cents = 5700")} ${PROBLEMS()}`);
  const refundAll = tx(`${V2ORDER()} ${FUND()} ${ACT("861", "dispute", "never delivered")} ${svc()} update public.contracts set status = 'resolving', resolution = 'refund', split_editor_cents = 0, refund_cents = 10000, resolved_at = now() where id = ${O};
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'refund', 10000, 'stripe', 're_a', 'succeeded', 'refund:re_a'); ${owner} ${COUNTERS()}`);
  const cb = (status) => tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, 500, 9500, "release:tr_c")} update public.contracts set status = 'completed', released_cents = 10000 where id = ${O};
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key, note) values (${O}, 'reversal', 9500, 'stripe', 'trr_dp_c', 'succeeded', 'reversal:trr_dp_c', 'chargeback dp_c');
    update public.contracts set chargeback_id = 'dp_c', chargeback_status = '${status}', released_cents = 500${status === "won" ? ", money_error = 'chargeback won, re-payment failed: Stripe did not answer'" : ""} where id = ${O}; ${PROBLEMS()}`);
  const cbOpen = cb("open"), cbWon = cb("won");
  vuln(pick(r, "stamp") !== "2/500/14/completed" || pick(r, "counters") !== "200" || kinds(pick(r, "check")) !== "none" || kinds(pick(wrongSplit, "check")) !== "money_left_at_cuvori"
       || !cbOpen.ok || !cbWon.ok || kinds(pick(cbOpen, "check")) !== "none" || kinds(pick(cbWon, "check")) !== "none" || !refundAll.ok || pick(refundAll, "counters") !== "0",
    `P11f decided €40 to the freelancer and €60 back -> ${r.ok ? pick(r, "stamp") + ", commission " + pick(r, "counters") : errOf(r)}; refunded in full -> ${refundAll.ok ? "commission " + pick(refundAll, "counters") : errOf(refundAll)} ; the check -> ${kinds(pick(r, "check"))}; €57 back instead of €60 -> ${kinds(pick(wrongSplit, "check"))}; a chargeback open -> ${cbOpen.ok ? kinds(pick(cbOpen, "check")) : errOf(cbOpen)}, won and not yet paid again -> ${cbWon.ok ? kinds(pick(cbWon, "check")) : errOf(cbWon)} (must be completed with 200 and nothing listed, money_left_at_cuvori, nothing listed while a chargeback is open or not yet repaid, and 0)`);
}

{ // P11g two chargebacks on one Order: the first payment's was lost after its payout (pulled back), then the top-up's was
  // won (nothing of it had been paid out, so nothing to pay again). The Order is finished with the top-up's €50 still at
  // Cuvori: the ledger check lists that money, and still asks about the 5% of the lost chargeback. One lost and one won
  // chargeback must not hide each other.
  const lostAndWon = tx(`${V2ORDER()} ${FUND()} update public.contracts set amount_cents = 15000, funded_cents = 15000 where id = ${O};
    ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'fund', 5000, 'stripe', 'pi_top', 'succeeded', 'fund:pi_top');
    ${REL(10000, 500, 9500, "release:tr_1")} update public.contracts set status = 'completed', released_cents = 10000 where id = ${O};
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'reversal', 9500, 'stripe', 'trr_1', 'succeeded', 'chargeback dp_1', 'reversal:trr_1');
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'chargeback', 10000, 'stripe', 'dp_1', 'succeeded', 'chargeback_lost', 'chargeback:dp_1');
    update public.contracts set chargeback_id = 'dp_1', chargeback_status = 'lost', released_cents = 500 where id = ${O};
    update public.contracts set chargeback_id = 'dp_2', chargeback_status = 'won' where id = ${O}; ${owner}
    select 'problems: ' || (public.admin_pricing_check()->'problems')::text; select 'decide: ' || (public.admin_pricing_check()->'to_decide')::text;`);
  vuln(!lostAndWon.ok || kinds(pick(lostAndWon, "problems")) !== "money_left_at_cuvori" || !/commission_on_lost_chargeback/.test(pick(lostAndWon, "decide")),
    `P11g a lost chargeback, then a won one with nothing to pay again, on a finished Order with €50 left -> problems ${lostAndWon.ok ? kinds(pick(lostAndWon, "problems")) : errOf(lostAndWon)}, to decide ${pick(lostAndWon, "decide").slice(0, 90)} (must list money_left_at_cuvori, and commission_on_lost_chargeback to decide)`);
}

{ // P11h one chargeback won and paid again, then a later one (on a top-up still held) lost: no payout was pulled back for
  // the lost one, so no 5% was lost and there is nothing to decide; a check of the whole Order would wrongly ask
  const r = tx(`${V2ORDER()} ${FUND()} update public.contracts set amount_cents = 15000, funded_cents = 15000 where id = ${O};
    ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'fund', 5000, 'stripe', 'pi_top', 'succeeded', 'fund:pi_top');
    ${REL(10000, 500, 9500, "release:tr_1")} update public.contracts set status = 'completed', released_cents = 10000 where id = ${O};
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'reversal', 9500, 'stripe', 'trr_a', 'succeeded', 'chargeback dp_a', 'reversal:trr_a');
    ${REL(9500, 0, 9500, "release:tr_2", "repay", "chargeback_won dp_a")}
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'chargeback', 5000, 'stripe', 'dp_b', 'succeeded', 'chargeback_lost', 'chargeback:dp_b');
    update public.contracts set chargeback_id = 'dp_b', chargeback_status = 'lost', released_cents = 10000 where id = ${O}; ${owner}
    insert into public.order_events (order_id, event, data) values (${O}, 'chargeback_won', '{"chargeback":"dp_a"}');
    select 'problems: ' || (public.admin_pricing_check()->'problems')::text; select 'decide: ' || (public.admin_pricing_check()->'to_decide')::text;`);
  vuln(!r.ok || kinds(pick(r, "problems")) !== "none" || pick(r, "decide") !== "[]",
    `P11h a chargeback won and paid again, then one lost on money still held -> problems ${r.ok ? kinds(pick(r, "problems")) : errOf(r)}, to decide ${pick(r, "decide").slice(0, 100)} (must be none and [])`);
}
{ // P11i nothing is paid out for a part while Cuvori is deciding the dispute, or once the Order is cancelled
  const ms = `[{"title":"Part 1","amount_cents":4000},{"title":"Part 2","amount_cents":6000}]`;
  const claim = `${svc()} update public.order_milestones set status = 'approved', approved_at = now(), auto_release_at = null where id = ${MS1};`;
  const at = (status) => tx(`${V2ORDER(10000, ms)} ${FUND()} ${MSACT("862", "submit", LINK)} ${owner} update public.contracts set status = '${status}' where id = ${O}; ${claim}`);
  const resolving = at("resolving"), cancelled = at("cancelled"), plan1 = tx(`${CREATE(10000, "escrow", ms)} ${ACCEPT()} ${FUND1} ${MSACT("862", "submit")} ${owner} update public.contracts set status = 'resolving' where id = ${O}; ${svc(false)} update public.order_milestones set status = 'approved', approved_at = now() where id = ${MS1};`);
  vuln(!/release_paused/.test(errOf(resolving)) || !/release_paused/.test(errOf(cancelled)) || !/release_paused/.test(errOf(plan1)),
    `P11i a part approved while the dispute is being decided -> ${resolving.ok ? "APPROVED" : errOf(resolving)}; once the Order is cancelled -> ${cancelled.ok ? "APPROVED" : errOf(cancelled)}; a plan 1 Order being decided -> ${plan1.ok ? "APPROVED" : errOf(plan1)} (must be release_paused each time)`);
}

{ // P11j a safety net: a finished Order whose won chargeback's pull-back was never paid again, with nothing noting it as
  // owed (no code path is known to leave this; if one ever does, nobody would pay it): the ledger check lists the money
  // left at Cuvori. While the Order notes the re-payment as owed (the hourly run pays it), it is not a problem yet
  const won = (note) => tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(5000, 250, 4750, "release:tr_1")}
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'reversal', 4750, 'stripe', 'trr_w', 'succeeded', 'chargeback dp_w', 'reversal:trr_w');
    update public.contracts set chargeback_id = 'dp_w', chargeback_status = 'won', released_cents = 250 where id = ${O};
    ${REL(5000, 250, 4750, "release:tr_2")} update public.contracts set status = 'completed', released_cents = 5250${note ? `, money_error = '${note}'` : ""} where id = ${O}; ${owner}
    select 'check: ' || (public.admin_pricing_check()->'problems')::text;`);
  const forgotten = won(null), owed = won("chargeback won, re-payment failed: Stripe did not answer");
  vuln(!forgotten.ok || kinds(pick(forgotten, "check")) !== "money_left_at_cuvori" || !owed.ok || kinds(pick(owed, "check")) !== "none",
    `P11j a won chargeback's €47.50 never paid again on a finished Order -> ${forgotten.ok ? kinds(pick(forgotten, "check")) : errOf(forgotten)}; the same while the Order notes it as owed -> ${owed.ok ? kinds(pick(owed, "check")) : errOf(owed)} (must be money_left_at_cuvori; none)`);
}
{ // P11k a valid delivery: an Order paid directly needs no link (Cuvori pays nothing out); a report's uploaded video (its
  // public link in Supabase storage) is a link to the work
  const direct = tx(`${V2ON} ${CREATE(10000, "direct")} ${ACCEPT()} ${owner} update public.contracts set status = 'paid' where id = ${O}; ${ACT("862", "deliver", "done")}`);
  const video = tx(`${V2ORDER()} ${FUND()} ${ACT("862", "deliver", "done", "https://abcdefghijklmnop.supabase.co/storage/v1/object/public/reports/861/cut.mp4")}`);
  vuln(pick(direct, "deliver") !== "ok" || pick(video, "deliver") !== "ok",
    `P11k a plan 2 Order paid directly delivered without a link -> ${pick(direct, "deliver")}; a plan 2 Order paid through Cuvori delivered with the report's video link -> ${pick(video, "deliver")} (must be ok, ok)`);
}

{ // P11l a chargeback lost after the payout whose pull-back failed: the bank took €100 but Cuvori held nothing, so today's
  // way of writing it leaves no chargeback line (it writes only what Cuvori still held). The ledger check lists it, with
  // what the bank took and what the lines show; a lost chargeback written in full is not listed for this
  const lost = (line) => tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, 500, 9500, "release:tr_1")} update public.contracts set status = 'completed', released_cents = 10000 where id = ${O};
    ${line ? `insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'chargeback', ${line}, 'stripe', 'dp_x', 'succeeded', 'chargeback_lost', 'chargeback:dp_x');` : ""}
    update public.contracts set chargeback_id = 'dp_x', chargeback_status = 'lost', chargeback_cents = 10000 where id = ${O}; ${owner}
    select 'check: ' || (public.admin_pricing_check()->'problems')::text;`);
  const none = lost(0), part = lost(2000), full = lost(10000);
  vuln(!none.ok || !part.ok || !full.ok || !/chargeback_not_recorded/.test(kinds(pick(none, "check"))) || !/chargeback_not_recorded/.test(kinds(pick(part, "check"))) || /chargeback_not_recorded/.test(kinds(pick(full, "check"))),
    `P11l a lost €100 chargeback whose pull-back failed -> no line: ${kinds(pick(none, "check"))}; a €20 line: ${kinds(pick(part, "check"))}; written in full: ${kinds(pick(full, "check"))} (must list chargeback_not_recorded, list it, not list it)`);
}

{ // P11m a won chargeback on an Order that still holds money (part 1 paid out, €38 pulled back): what was pulled back must
  // go out again as a re-payment (no second 5%). Paid out again as a normal payout, the 5% is kept twice: the check lists
  // it. Refunded to the client instead, the 5% kept on that payout stays booked though the freelancer kept nothing of it:
  // the check asks you to decide (like a lost chargeback)
  const base = `${V2ORDER()} ${FUND()} ${svc()} ${REL(4000, 200, 3800, "release:tr_1")}
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'reversal', 3800, 'stripe', 'trr_1', 'succeeded', 'chargeback dp_1', 'reversal:trr_1');
    update public.contracts set released_cents = 200, chargeback_id = 'dp_1', chargeback_status = 'won' where id = ${O};`;
  const CHK = `${owner} select 'check: ' || (public.admin_pricing_check()->'problems')::text; select 'decide: ' || (public.admin_pricing_check()->'to_decide')::text;`;
  const twice = tx(`${base} ${REL(9800, 490, 9310, "release:tr_2")} update public.contracts set status = 'completed', released_cents = 10000 where id = ${O}; ${CHK}`);
  const right = tx(`${base} ${REL(3800, 0, 3800, "release:tr_2", "repay", "chargeback_won dp_1")} ${REL(6000, 300, 5700, "release:tr_3")} update public.contracts set status = 'completed', released_cents = 10000 where id = ${O}; ${CHK}`);
  const refunded = tx(`${base} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'refund', 9800, 'stripe', 're_r', 'succeeded', 'refund:re_r');
    update public.contracts set status = 'refunded', refunded_cents = 9800 where id = ${O}; ${CHK}`);
  // the Order also had €60 refunded: €40 paid out, €60 refunded, €38 pulled back and then paid out again as a normal payout
  const withRefund = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(4000, 200, 3800, "release:tr_1")}
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'refund', 6000, 'stripe', 're_6', 'succeeded', 'refund:re_6');
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'reversal', 3800, 'stripe', 'trr_1', 'succeeded', 'chargeback dp_1', 'reversal:trr_1');
    update public.contracts set chargeback_id = 'dp_1', chargeback_status = 'won', refunded_cents = 6000 where id = ${O};
    ${REL(3800, 190, 3610, "release:tr_2")} update public.contracts set status = 'completed', released_cents = 4000 where id = ${O}; ${CHK}`);
  vuln(!/commission_twice/.test(kinds(pick(twice, "check"))) || !/commission_on_pulled_back_payout/.test(pick(twice, "decide")) || kinds(pick(right, "check")) !== "none" || pick(right, "decide") !== "[]"
       || !/commission_on_pulled_back_payout/.test(pick(refunded, "decide")) || !/commission_on_pulled_back_payout/.test(pick(withRefund, "decide")),
    `P11m the €38 pulled back paid out again as a normal payout -> ${kinds(pick(twice, "check"))}, to decide ${pick(twice, "decide").slice(0, 60)}; paid again as a re-payment -> ${kinds(pick(right, "check"))}, to decide ${pick(right, "decide")}; refunded to the client -> to decide ${pick(refunded, "decide").slice(0, 60)}; on an Order with a €60 refund, paid out again -> to decide ${pick(withRefund, "decide").slice(0, 60)} (must list commission_twice and the item; nothing; the item; the item)`);
}

{ // P11o a chargeback lost on money Cuvori still held (nothing was paid out of it) takes none of the 5%: it never hides
  // a shortfall. €150 paid in (€100 and a €50 top-up), €100 paid out (€5 kept), the bank takes the held €50, then €3 is
  // refunded in the Stripe dashboard: Cuvori holds €2 of its €5, and the check says so
  const held = tx(`${V2ORDER()} ${FUND()} update public.contracts set amount_cents = 15000, funded_cents = 15000 where id = ${O};
    ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'fund', 5000, 'stripe', 'pi_top', 'succeeded', 'fund:pi_top');
    ${REL(10000, 500, 9500, "release:tr_1")}
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'chargeback', 5000, 'stripe', 'dp_h', 'succeeded', 'chargeback_lost', 'chargeback:dp_h');
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key, note) values (${O}, 'refund', 300, 'stripe', 're_d', 'succeeded', 'refund:re_d', 'dashboard_refund');
    -- the €3 can't go on the Order's own totals (nothing was left to give back); its line is written, as every line is
    update public.contracts set status = 'completed', released_cents = 10000, refunded_cents = 5000, chargeback_id = 'dp_h', chargeback_status = 'lost', chargeback_cents = 5000 where id = ${O}; ${owner}
    select 'check: ' || (public.admin_pricing_check()->'problems')::text;`);
  // ... and two top-ups: one lost after its payout (€47.50 pulled back), one lost while held: only the first one's 5% is
  // to decide (€2.50), not €7.50
  const two = tx(`${V2ORDER()} ${FUND()} update public.contracts set amount_cents = 20000, funded_cents = 20000 where id = ${O};
    ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'fund', 5000, 'stripe', 'pi_t1', 'succeeded', 'fund:pi_t1'), (${O}, 'fund', 5000, 'stripe', 'pi_t2', 'succeeded', 'fund:pi_t2');
    ${REL(15000, 750, 14250, "release:tr_1")}
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'reversal', 4750, 'stripe', 'trr_1', 'succeeded', 'chargeback dp_1', 'reversal:trr_1');
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'chargeback', 5000, 'stripe', 'dp_1', 'succeeded', 'chargeback_lost', 'chargeback:dp_1'), (${O}, 'chargeback', 5000, 'stripe', 'dp_2', 'succeeded', 'chargeback_lost', 'chargeback:dp_2');
    update public.contracts set status = 'completed', released_cents = 10250, refunded_cents = 9750, chargeback_id = 'dp_2', chargeback_status = 'lost', chargeback_cents = 5000 where id = ${O}; ${owner}
    select 'check: ' || (public.admin_pricing_check()->'problems')::text; select 'decide: ' || (public.admin_pricing_check()->'to_decide')::text;`);
  const all = (() => { try { return JSON.parse(pick(two, "decide")); } catch { return []; } })(), d = all[0] || {};
  vuln(!held.ok || kinds(pick(held, "check")) !== "commission_without_money" || !two.ok || kinds(pick(two, "check")) !== "none"
       || all.length !== 1 || d.item !== "commission_on_lost_chargeback" || d.lost_part_commission_cents !== 250,
    `P11o a chargeback lost on held money, then a €3 dashboard refund -> ${held.ok ? kinds(pick(held, "check")) : errOf(held)} (must be commission_without_money); two top-ups lost, one after its payout and one while held -> problems ${two.ok ? kinds(pick(two, "check")) : errOf(two)}, to decide ${d.item} with ${d.lost_part_commission_cents} (must be none; commission_on_lost_chargeback with 250)`);
}
{ // P11q the 5% a lost chargeback took is the 5% that was kept, to the cent: €99.90 paid out keeps €5.00 (rounded half up)
  // and sends €94.90; the bank takes it all and €94.90 is pulled back. Nothing is wrong, and the lost part's 5% is €5.00
  const r = tx(`${V2ORDER(9990)} ${FUND(9990)} ${svc()} select 'next: ' || public.pricing_next_commission(${O}, 9990); ${REL(9990, 500, 9490, "release:tr_1")}
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'reversal', 9490, 'stripe', 'trr_1', 'succeeded', 'chargeback dp_9', 'reversal:trr_1');
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'chargeback', 9990, 'stripe', 'dp_9', 'succeeded', 'chargeback_lost', 'chargeback:dp_9');
    update public.contracts set status = 'completed', released_cents = 500, refunded_cents = 9490, chargeback_id = 'dp_9', chargeback_status = 'lost', chargeback_cents = 9990 where id = ${O}; ${owner}
    select 'check: ' || (public.admin_pricing_check()->'problems')::text; select 'decide: ' || (public.admin_pricing_check()->'to_decide')::text;`);
  const all = (() => { try { return JSON.parse(pick(r, "decide")); } catch { return []; } })(), d = all[0] || {};
  vuln(!r.ok || pick(r, "next") !== "500" || kinds(pick(r, "check")) !== "none" || all.length !== 1 || d.lost_part_commission_cents !== 500,
    `P11q €99.90 paid out (5% kept: ${pick(r, "next")}), lost as a chargeback with €94.90 pulled back -> problems ${r.ok ? kinds(pick(r, "check")) : errOf(r)}; the lost part's 5% ${d.lost_part_commission_cents} (must be 500; none; 500)`);
}
{ // P11r ... and never more than the bank took beyond what came back: €100 paid out (€5 kept), the bank takes €50 and all
  // €50 comes back from the freelancer, then €2.50 is refunded in the Stripe dashboard: Cuvori holds €2.50 of its €5, listed
  const r = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, 500, 9500, "release:tr_1")}
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'reversal', 5000, 'stripe', 'trr_p', 'succeeded', 'chargeback dp_p', 'reversal:trr_p');
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'chargeback', 5000, 'stripe', 'dp_p', 'succeeded', 'chargeback_lost', 'chargeback:dp_p');
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key, note) values (${O}, 'refund', 250, 'stripe', 're_d', 'succeeded', 'refund:re_d', 'dashboard_refund');
    update public.contracts set status = 'completed', released_cents = 5000, refunded_cents = 5000, chargeback_id = 'dp_p', chargeback_status = 'lost', chargeback_cents = 5000 where id = ${O}; ${owner}
    select 'check: ' || (public.admin_pricing_check()->'problems')::text;`);
  vuln(!r.ok || kinds(pick(r, "check")) !== "commission_without_money",
    `P11r a €50 chargeback fully pulled back, then a €2.50 dashboard refund -> ${r.ok ? kinds(pick(r, "check")) : errOf(r)} (must be commission_without_money: the chargeback took none of the 5%)`);
}
{ // P11n €150 paid in (€100 and a €50 top-up), all paid out (€7.50 kept). The bank takes the top-up's €50 (lost), €47.50 is
  // pulled back; then €3 is refunded in the Stripe dashboard. Cuvori should still hold €5 (the 5% on what stays paid)
  // but holds €2: the check lists commission_without_money, and the lost part's 5% to decide is €2.50, not the whole €7.50
  const r = tx(`${V2ORDER()} ${FUND()} update public.contracts set amount_cents = 15000, funded_cents = 15000 where id = ${O};
    ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'fund', 5000, 'stripe', 'pi_top', 'succeeded', 'fund:pi_top');
    ${REL(15000, 750, 14250, "release:tr_1")}
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'reversal', 4750, 'stripe', 'trr_t', 'succeeded', 'chargeback dp_t', 'reversal:trr_t');
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'chargeback', 5000, 'stripe', 'dp_t', 'succeeded', 'chargeback_lost', 'chargeback:dp_t');
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key, note) values (${O}, 'refund', 300, 'stripe', 're_d', 'succeeded', 'refund:re_d', 'dashboard_refund');
    update public.contracts set status = 'completed', released_cents = 9700, refunded_cents = 5300, chargeback_id = 'dp_t', chargeback_status = 'lost', chargeback_cents = 5000 where id = ${O}; ${owner}
    select 'check: ' || (public.admin_pricing_check()->'problems')::text; select 'decide: ' || (public.admin_pricing_check()->'to_decide')::text;`);
  const all = (() => { try { return JSON.parse(pick(r, "decide")); } catch { return []; } })(), d = all[0] || {};
  vuln(!/commission_without_money/.test(kinds(pick(r, "check"))) || all.length !== 1 || d.item !== "commission_on_lost_chargeback" || d.lost_part_commission_cents !== 250,
    `P11n a lost top-up chargeback and a €3 dashboard refund -> problems ${r.ok ? kinds(pick(r, "check")) : errOf(r)}; to decide ${d.item}, 5% on the lost part ${d.lost_part_commission_cents} (must list commission_without_money; commission_on_lost_chargeback with 250)`);
}

// ---------- P12 the SQL lines SETUP.md gives you (Parts 20 and 21) run as written, as you in the SQL editor ----------
{ // P12a each one runs; the ones whose answer SETUP gives answer it; the e-mail list holds the freelancers only
  const md = fs.readFileSync(path.join(root, "SETUP.md"), "utf8");
  const parts = md.slice(md.indexOf("## Part 20"));
  const lines = [...new Set([...parts.matchAll(/`((?:select|update|with) [^`]+;)`/g)].map(m => m[1]))];
  const emails = lines.find(l => /from auth\.users/.test(l)), plans = lines.find(l => /select version, rules_version from public\.pricing_plans/.test(l));
  const setRules = lines.find(l => /^update public\.pricing_plans set rules_version/.test(l)), on = lines.find(l => /pricing_switch_to\(2,/.test(l));
  const failed = [];
  for (const l of lines) {
    const sql = l.replace(/'<Order id>'/g, O);
    // the order SETUP gives them in: the rules version before the switch, the switch before Orders at the new prices exist
    const before = l === setRules || l === plans || l === emails || /^update public\.pricing_plans set /.test(l) ? owner
      : l === on ? `${owner} ${setRules || ""}`
      : /audio-editor/.test(l) ? `${owner} insert into public.professions (slug, labels) values ('audio-editor', '{"en":"Audio editor","lt":"Garso montuotojas"}') on conflict (slug) do update set labels = public.professions.labels || '{"lt":"Garso montuotojas"}'::jsonb;`
      : `${V2ORDER()} ${owner}`;
    const r = tx(`${before}\n${sql}`);
    const want = /admin_pricing_check\(\)/.test(l) ? /"problems": \[\]/ : /audio-editor/.test(l) ? /^audio-editor\|Garso editorius$/m : null;   // the answers SETUP gives
    if (!r.ok) failed.push(`${l.slice(0, 60)}… -> ${errOf(r)}`);
    else if (want && !want.test(r.out)) failed.push(`${l.slice(0, 60)}… -> answers ${r.out.split("\n").filter(x => x && !/^(BEGIN|ROLLBACK|RESET|INSERT|UPDATE|SET)/.test(x)).join(" ").slice(0, 120)}`);
  }
  // 863 keeps the client role but has a service (an account whose role was changed back): still a freelancer for the e-mail;
  // 864 is a demo freelancer (one of your test accounts): left out
  const em = emails ? tx(`${owner} insert into public.services (profile_id, profession_slug, rate_unit) select ${U("863")}, slug, pricing_units[1] from public.professions where slug = 'video-editor';
    insert into auth.users (id, email, raw_user_meta_data) values (${U("864")}, 'd864@t.com', '{"first_name":"Dee"}');
    update public.profiles set role = 'editor', visibility = 'demo' where id = ${U("864")};
    ${emails}`) : { out: "" };
  const pl = plans && setRules ? tx(`${owner} ${setRules} ${plans}`) : { out: "" };
  const sw = on && setRules ? tx(`${owner} ${setRules} ${on.replace(/^select /, "select 'switch: ' || ")}`) : { out: "", ok: false, err: "" };
  vuln(lines.length < 10 || failed.length || !emails || !/f862@t\.com/.test(em.out) || !/z863@t\.com/.test(em.out) || /c861@t\.com|d864@t\.com/.test(em.out) || !/^2\|2026-12$/m.test(pl.out) || pick(sw, "switch") !== "ok",
    `P12a ${lines.length} SQL lines in SETUP Parts 20-21 -> ${failed.length ? "failing: " + failed.join("; ") : "all run"}; the freelancers' e-mails -> ${emails ? ["f862", "z863", "c861", "d864"].map(x => x + (new RegExp(x + "@t\\.com").test(em.out) ? " listed" : " not listed")).join(", ") : "no query in SETUP"}; plan 2's rules version after step 3 -> ${(pl.out.match(/^2\|.*$/m) || ["?"])[0]}; the switch -> ${pick(sw, "switch")} (all run; f862 and z863, not c861 or the demo d864; 2|2026-12; ok)`);
}

{ // P12c the switch turned on by mistake, then back (SETUP Part 20): SETUP's query finds every Order made under the new
  // prices, and its cancel line cancels only the agreed ones paid through Cuvori (they can't be paid), with a history line;
  // a proposal (it returns to today's prices when accepted again), an Order paid directly and an Order at today's prices stay
  const md = fs.readFileSync(path.join(root, "SETUP.md"), "utf8"), parts = md.slice(md.indexOf("## Part 20"));
  const sqls = [...parts.matchAll(/`((?:select|update|with) [^`]+;)`/g)].map(m => m[1]);
  const find = sqls.find(l => /^select [^;]*from public\.contracts where pricing_version = 2/.test(l));
  const cancel = sqls.find(l => /status = 'cancelled'/.test(l) && /pricing_version = 2/.test(l));
  const after = (made) => find && cancel ? tx(`${made} ${owner} select public.pricing_switch_to(1, 'back');
      select 'found: ' || count(*) from (${find.replace(/;$/, "")}) f; ${cancel} ${STAMP()} select 'history: ' || (select count(*) from public.order_events where order_id = ${O} and event = 'cancelled')
        || '/' || (select count(*) from public.messages where kind = 'contract' and payload->>'contract_id' = (${O})::text and payload->>'event' = 'cancel' and payload->>'status' = 'cancelled');`)
    : { ok: false, out: "", err: "ERROR: SETUP Part 20 gives no such query or cancel line" };
  const cases = [
    ["agreed, paid through Cuvori", after(V2ORDER()), "1", "2/500/14/cancelled", "1/1"],
    ["agreed, paid directly", after(`${V2ON} ${CREATE(10000, "direct")} ${ACCEPT()}`), "1", "2/0/14/accepted", "0/0"],
    ["a proposal", after(`${V2ON} ${CREATE(10000)}`), "1", "2/500/14/proposed", "0/0"],
    ["agreed at today's prices", after(`${CREATE(10000)} ${ACCEPT()}`), "0", "1/0/7/accepted", "0/0"],
  ];
  const wrong = cases.filter(([, r, f, st, h]) => !r.ok || pick(r, "found") !== f || pick(r, "stamp") !== st || pick(r, "history") !== h)
    .map(([what, r, f, st, h]) => `${what}: ${r.ok ? `found ${pick(r, "found")}, ${pick(r, "stamp")}, history line / chat card ${pick(r, "history")} (must be ${f}, ${st}, ${h})` : errOf(r)}`);
  vuln(wrong.length, `P12c after a mistaken switch-on, SETUP's query and cancel line -> ${wrong.length ? wrong.join("; ") : "find the new-price Orders and cancel only the agreed ones paid through Cuvori, with a history line and a chat card"}`);
}

{ // P12b the review window (SETUP Part 19): the command SETUP gives works in the SQL editor
  const md = fs.readFileSync(path.join(root, "SETUP.md"), "utf8");
  const p19 = md.slice(md.indexOf("## Part 19"), md.indexOf("## Part 20"));
  const cmd = ([...p19.matchAll(/`((?:select|insert|update) [^`]*review_window_days[^`]*;)`/g)][0] || [])[1];
  const r = cmd ? tx(`${owner} ${cmd} select 'window: ' || value::text from public.site_settings where key = 'review_window_days';`) : { ok: false, out: "", err: "no command in SETUP Part 19" };
  vuln(!cmd || !r.ok || pick(r, "window") !== "21" || /forbidden/.test(r.out),
    `P12b SETUP Part 19's review-window command, run as you in the SQL editor -> ${cmd ? (r.ok ? "window " + pick(r, "window") + (/forbidden/.test(r.out) ? " (answered forbidden)" : "") : errOf(r)) : "no command"} (must be 21)`);
}

// ---------- P13 the rules no other check exercises ----------
{ // P13a each one refuses (or the ledger check lists) what it is there for
  const line = (kind, ref, extra = "") => `insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key${extra ? ", note" : ""}) values (${O}, '${kind}', 1000, 'stripe', '${ref}', 'succeeded', '${kind}:${ref}:' || gen_random_uuid()${extra ? ", '" + extra + "'" : ""});`;
  const cases = [
    ["the switch row deleted", tx(`${owner} delete from public.pricing_switch;`), /pricing_switch_must_stay/],
    ["a plan given another number", tx(`${owner} update public.pricing_plans set version = 3 where version = 2;`), /pricing_plan_in_use/],
    ["a proposal set to agreed without Accept after the switch moved", tx(`${CREATE(10000)} ${V2ON} ${owner} update public.contracts set status = 'accepted' where id = ${O};`), /pricing_changed/],
    ["a plan 2 line from another provider", tx(`${V2ORDER()} ${svc()} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, entry_key) values (${O}, 'fund', 10000, 'paypal', 'pp_1', 'succeeded', 'fund:pp_1');`), /ledger_provider_stripe_only/],
    ["the same chargeback written twice", tx(`${V2ORDER()} ${FUND()} ${svc()} ${line("chargeback", "dp_9")} ${line("chargeback", "dp_9")}`), /order_payments_v2_object_uq|duplicate key/],
    ["the same pull-back written twice", tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, 500, 9500, "release:tr_9")} ${line("reversal", "trr_9", "chargeback dp_9")} ${line("reversal", "trr_9", "chargeback dp_9")}`), /order_payments_v2_object_uq|duplicate key/],
  ];
  const totals = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, 500, 9500, "release:tr_8")} ${owner} select set_config('cuvori.pricing_ledger', 'on', true); update public.contracts set commission_cents = 999 where id = ${O}; ${PROBLEMS()}`);
  const wrong = cases.filter(([, r, re]) => !re.test(errOf(r))).map(([what, r]) => `${what}: ${r.ok ? "accepted" : errOf(r)}`);
  vuln(wrong.length || !/totals_differ/.test(kinds(pick(totals, "check"))),
    `P13a ${cases.length} refusals -> ${wrong.length ? "not refused: " + wrong.join("; ") : "all refused"}; a commission total written by hand -> ${kinds(pick(totals, "check"))} (must be refused; totals_differ)`);
}
{ // P13b the next 5% counts normal payouts only (a re-payment after a won chargeback is not one) and refuses an amount of
  // zero or less; the commission function refuses a negative amount or a rate outside 0-100%
  const r = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(4010, 201, 3809, "release:tr_1")}
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note, entry_key) values (${O}, 'reversal', 3809, 'stripe', 'trr_1', 'succeeded', 'chargeback dp_1', 'reversal:trr_1');
    ${REL(1990, 0, 1990, "release:tr_2", "repay", "chargeback_won dp_1")}
    select 'next: ' || public.pricing_next_commission(${O}, 5990); ${owner}`);
  const refused = [
    ["the next 5% of 0", `select public.pricing_next_commission(${O}, 0);`], ["the next 5% of -5", `select public.pricing_next_commission(${O}, -5);`],
    ["5% of -1 cent", "select public.pricing_commission(-1, 500);"], ["a rate of -1", "select public.pricing_commission(100, -1);"], ["a rate of 100.01%", "select public.pricing_commission(100, 10001);"],
  ].map(([what, q]) => [what, tx(`${V2ORDER()} ${svc()} ${q}`)]).filter(([, x]) => !/bad_amount/.test(errOf(x))).map(([what, x]) => `${what}: ${x.ok ? "answered " + x.out.split("\n").pop() : errOf(x)}`);
  const empty = pick(run("select 'none: ' || coalesce(public.pricing_commission(100, null)::text, 'null') || '/' || coalesce(public.pricing_commission(null, 500)::text, 'null');"), "none");
  vuln(pick(r, "next") !== "299" || refused.length || empty !== "null/null",
    `P13b €40.10 paid out (5%: €2.01), €19.90 paid again after a won chargeback, the next 5% of €59.90 -> ${pick(r, "next")} (must be 299: counting the re-payment gives 300); refusals ${refused.length ? "missing: " + refused.join("; ") : "all bad_amount"}; no rate or no amount -> ${empty} (must be null/null)`);
}
{ // P13c the switch's history: a change of the note is written down too, an update that changes nothing is not, and the
  // one row can't be given another id
  const r = tx(`${owner} update public.pricing_switch set note = note; select 'same: ' || count(*) from public.pricing_switch_log;
    update public.pricing_switch set note = 'a note'; select 'note: ' || (select count(*) from public.pricing_switch_log) || ' ' || coalesce((select concat_ws('>', from_version, to_version, note) from public.pricing_switch_log order by id desc limit 1), '');`);
  const id = tx(`${owner} update public.pricing_switch set id = false;`);
  const base = pick(run("select 'n: ' || count(*) from public.pricing_switch_log;"), "n");
  vuln(pick(r, "same") !== base || pick(r, "note") !== `${Number(base) + 1} 1>1>a note` || !/pricing_switch_must_stay/.test(errOf(id)),
    `P13c the switch's history (${base} lines) -> after an update that changes nothing: ${pick(r, "same")}; after a new note: ${pick(r, "note")}; the row given another id -> ${errOf(id).slice(0, 60)} (must be ${base}; ${Number(base) + 1} 1>1>a note; pricing_switch_must_stay)`);
}
{ // P13d a finished Order whose payout line is missing is listed as line_missing only: what looks like money left at
  // Cuvori is the payout without its line
  const r = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(4000, 200, 3800, "release:tr_1")} update public.contracts set status = 'completed', released_cents = 10000 where id = ${O}; ${PROBLEMS()}`);
  vuln(!r.ok || kinds(pick(r, "check")) !== "line_missing",
    `P13d a finished €100 Order, €100 paid out but only a €40 payout line -> ${r.ok ? kinds(pick(r, "check")) : errOf(r)} (must be line_missing only)`);
}
{ // P13e the commission report: at most 400 days, both dates needed; it counts plan 2 lines only
  const rep = (from, to) => pick(tx(`${owner} select 'r: ' || public.admin_pricing_report(${from}, ${to})::text;`), "r");
  const long = rep("current_date - 401", "current_date"), max = rep("current_date - 400", "current_date"), none = rep("null", "current_date");
  const plan1 = tx(`${CREATE(10000)} ${ACCEPT()} ${svc(false)} insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status) values (${O}, 'fund', 10000, 'stripe', 'pi_p1', 'succeeded'); ${owner}
    select 'r: ' || (public.admin_pricing_report(current_date - 1, current_date + 1)->'totals'->>'paid_in_cents');`);
  const plan2 = tx(`${V2ORDER()} ${FUND()} ${owner} select 'r: ' || (public.admin_pricing_report(current_date - 1, current_date + 1)->'totals'->>'paid_in_cents');`);
  vuln(!/bad_dates/.test(long) || /error/.test(max) || !/bad_dates/.test(none) || pick(plan1, "r") !== "0" || pick(plan2, "r") !== "10000",
    `P13e the report over 401 days -> ${long.slice(0, 30)}; over 400 -> ${/error/.test(max) ? max.slice(0, 30) : "a report"}; without a start date -> ${none.slice(0, 30)}; €100 paid into an Order at today's prices -> paid in ${pick(plan1, "r")}; into a plan 2 Order -> ${pick(plan2, "r")} (must be bad_dates; a report; bad_dates; 0; 10000)`);
}

{ // P13f a proposal is sent or changed only at the prices its form showed: the page names the plan, and when the switch
  // has moved since, nothing is written ("pricing_changed"); no plan named (an Order paid directly) is not checked
  const make = (shown, label = "made") => `${as("861")} select '${label}: ' || (public.order_create_at_prices(${CV}, ${ORDER(10000)}, ${shown}) is not null); ${owner}`;
  const count = `select 'n: ' || count(*) from public.contracts where conversation_id = ${CV};`;
  const stale = tx(`${V2ON} ${make(1)} ${count}`), right = tx(`${V2ON} ${make(2)} ${STAMP()}`), none = tx(`${V2ON} ${make("null")} ${STAMP()}`);
  const change = (shown) => `${as("861")} select 'changed: ' || public.order_update_at_prices(${O}, ${ORDER(12000)}, ${shown}); ${owner}`;
  const upStale = tx(`${CREATE(10000)} ${V2ON} ${change(1)} select 'v: ' || terms_version || '/' || amount_cents from public.contracts where id = ${O};`);
  const upRight = tx(`${CREATE(10000)} ${V2ON} ${change(2)} ${STAMP()} select 'v: ' || terms_version || '/' || amount_cents from public.contracts where id = ${O};`);
  const anon = tx(`${as("anon")} select public.order_create_at_prices(${CV}, ${ORDER(10000)}, 1);`);
  vuln(!/pricing_changed/.test(errOf(stale)) || pick(right, "stamp") !== "2/500/14/proposed" || pick(none, "stamp") !== "2/500/14/proposed"
       || !/pricing_changed/.test(errOf(upStale)) || pick(upRight, "changed") !== "ok" || pick(upRight, "v") !== "2/12000" || !/permission denied/.test(errOf(anon)),
    `P13f the switch moved, a new proposal that showed plan 1 -> ${errOf(stale).slice(0, 40)}; that showed plan 2 -> ${pick(right, "stamp")}; no plan named -> ${pick(none, "stamp")}; a change that showed plan 1 -> ${errOf(upStale).slice(0, 40)}; that showed plan 2 -> ${pick(upRight, "changed")}, version/price ${pick(upRight, "v")}; a visitor -> ${errOf(anon).slice(0, 40)} (must be pricing_changed; a plan 2 proposal twice; pricing_changed; ok 2/12000; permission denied)`);
}
{ // P13g a card fee charged by mistake on a plan 2 payment can be put right once: its refund is written on the payment's
  // line, and the ledger check stops listing it; never twice, never more than the fee
  const paid = `${svc()} update public.contracts set status = 'funded', funded_cents = 10000, funded_at = now(), stripe_payment_intent = 'pi_861' where id = ${O};
    insert into public.order_payments (order_id, kind, amount_cents, fee_cents, provider, provider_ref, status, entry_key) values (${O}, 'fund', 10000, 370, 'stripe', 'pi_861', 'succeeded', 'fund:pi_861'); ${owner}`;
  const back = (cents, ref = "re_fee1") => `${svc()} update public.order_payments set fee_refund_cents = ${cents}, fee_refund_ref = '${ref}' where order_id = ${O} and kind = 'fund'; ${owner}`;
  const r = tx(`${V2ORDER()} ${paid} ${PROBLEMS("before")} ${back(370)} ${PROBLEMS("after")}`);
  const twice = tx(`${V2ORDER()} ${paid} ${back(370)} ${back(100, "re_fee2")}`), more = tx(`${V2ORDER()} ${paid} ${back(400)}`);
  vuln(!r.ok || !/client_charged_card_fee/.test(kinds(pick(r, "before"))) || /client_charged_card_fee/.test(kinds(pick(r, "after")))
       || !/ledger_line_frozen/.test(errOf(twice)) || !/ledger_line_frozen/.test(errOf(more)),
    `P13g a €3.70 card fee charged on a plan 2 payment -> listed: ${kinds(pick(r, "before"))}; its refund written on the line -> ${r.ok ? kinds(pick(r, "after")) : errOf(r)}; written a second time -> ${errOf(twice).slice(0, 40)}; more than the fee -> ${errOf(more).slice(0, 40)} (must be listed, then not; ledger_line_frozen twice)`);
  // ... only with the refund's own Stripe id, only on a payment line, never the id alone; and the same holds for a payment
  // line written with a refund already on it (as a repair from Stripe's record would), and one refund is never on two lines
  const noId = tx(`${V2ORDER()} ${paid} ${svc()} update public.order_payments set fee_refund_cents = 370 where order_id = ${O} and kind = 'fund';`);
  const madeUp = tx(`${V2ORDER()} ${paid} ${back(370, "made_up")}`), idOnly = tx(`${V2ORDER()} ${paid} ${svc()} update public.order_payments set fee_refund_ref = 're_fee1' where order_id = ${O} and kind = 'fund';`);
  const onPayout = tx(`${V2ORDER()} ${FUND()} ${svc()} ${REL(10000, 500, 9500, "release:tr_1")} update public.order_payments set fee_refund_cents = 1, fee_refund_ref = 're_fee1' where order_id = ${O} and kind = 'release';`);
  const line = (cents, ref, key = "pi_861") => `${svc()} insert into public.order_payments (order_id, kind, amount_cents, fee_cents, fee_refund_cents, fee_refund_ref, provider, provider_ref, status, entry_key) values (${O}, 'fund', 10000, 370, ${cents}, ${ref === null ? "null" : `'${ref}'`}, 'stripe', '${key}', 'succeeded', 'fund:${key}'); ${owner}`;
  const insNoId = tx(`${V2ORDER()} ${line(370, null)}`), insMore = tx(`${V2ORDER()} ${line(400, "re_fee1")}`);
  const insRight = tx(`${V2ORDER()} ${line(370, "re_fee1")} ${PROBLEMS("ins")}`), insTwice = tx(`${V2ORDER()} ${line(370, "re_fee1")} ${line(370, "re_fee1", "pi_862")}`);
  // each refused for its own reason (an error in setting the case up would not count)
  const refused = [["no Stripe id", noId, /ledger_line_frozen/], ["a made-up id", madeUp, /ledger_line_frozen/], ["the id alone", idOnly, /ledger_line_frozen/], ["on a payout line", onPayout, /ledger_line_frozen/],
    ["written with the payment, no id", insNoId, /fee_refund_badly_written/], ["written with the payment, more than the fee", insMore, /fee_refund_badly_written/], ["the same refund on two lines", insTwice, /order_payments_v2_fee_refund_uq|duplicate key/]]
    .filter(([, x, re]) => !re.test(errOf(x))).map(([what, x]) => `${what} (${x.ok ? "accepted" : errOf(x).slice(0, 40)})`);
  vuln(refused.length || !insRight.ok || /client_charged_card_fee/.test(kinds(pick(insRight, "ins"))),
    `P13g' a card-fee refund ${refused.length ? "NOT REFUSED AS EXPECTED: " + refused.join("; ") : "refused each time"} without its own Stripe id, on a payout, alone, or twice; written with the payment and its id -> ${insRight.ok ? kinds(pick(insRight, "ins")) : errOf(insRight)} (each must be refused; then not listed)`);
}
{ // P13h a line at today's prices also keeps what it says it kept and sent (empty): it can't be made into a re-payment later
  const line = `${CREATE(10000)} ${ACCEPT()} ${svc(false)} update public.contracts set status = 'funded', funded_cents = 10000, stripe_payment_intent = 'pi_old' where id = ${O};
    insert into public.order_payments (order_id, kind, amount_cents, provider, provider_ref, status, note) values (${O}, 'release', 10000, 'stripe', 'tr_old1', 'succeeded', 'approve');`;
  const purpose = tx(`${line} update public.order_payments set payout_purpose = 'repay' where order_id = ${O} and kind = 'release';`);
  const kept = tx(`${line} update public.order_payments set commission_cents = 0 where order_id = ${O} and kind = 'release';`);
  vuln(!/ledger_line_frozen/.test(errOf(purpose)) || !/ledger_line_frozen/.test(errOf(kept)),
    `P13h a payout line at today's prices made a re-payment afterwards -> ${errOf(purpose).slice(0, 40)}; given a commission afterwards -> ${errOf(kept).slice(0, 40)} (must be ledger_line_frozen twice)`);
}
{ // P13i visitors and members see whether the new prices are on, never your note on the switch
  const seen = (who) => [tx(`${owner} select public.pricing_switch_to(1, 'x'); ${as(who)} select 'note: ' || note from public.pricing_switch; ${owner}`), tx(`${as(who)} select 'v: ' || version from public.pricing_switch; ${owner}`)];
  const [aNote, aVer] = seen("anon"), [mNote, mVer] = seen("861");
  vuln(!/permission denied/.test(errOf(aNote)) || !/permission denied/.test(errOf(mNote)) || pick(aVer, "v") !== "1" || pick(mVer, "v") !== "1",
    `P13i the switch's note read by a visitor -> ${aNote.ok ? "READ: " + pick(aNote, "note") : errOf(aNote).slice(0, 40)}; by a member -> ${mNote.ok ? "READ" : errOf(mNote).slice(0, 40)}; which plan is on, by a visitor/member -> ${pick(aVer, "v")}/${pick(mVer, "v")} (must be permission denied twice; 1/1)`);
}
{ // P13j the money summary says who pays the card costs from the Order's own plan (a later plan may differ)
  const p2 = tx(`${V2ORDER()} ${owner} select 's: ' || (public.order_money_summary(${O})->>'card_costs_paid_by');`);
  const p3 = tx(`${owner} insert into public.pricing_plans (version, name, commission_bps, min_project_cents, card_costs_paid_by, review_days, rules_version) values (3, 'client pays the card costs', 500, 200, 'client', 14, '2026-11');
    update public.pricing_plans set rules_version = '2026-11' where version = 2; ${RULES} select 'switch: ' || public.pricing_switch_to(3, 'test'); ${CREATE(10000)} ${ACCEPT()}
    select 's: ' || (public.order_money_summary(${O})->>'card_costs_paid_by');`);
  vuln(pick(p2, "s") !== "platform" || pick(p3, "s") !== "client",
    `P13j the money summary (for you) of a plan 2 Order -> ${pick(p2, "s")}; of an Order under a plan where the client pays the card costs -> ${pick(p3, "s")} (must be platform, client)`);
}

// ---------- P14 at the same moment: proposals, your switch and your plan changes, in sessions of their own ----------
// (in a copy of the test database, so the switch can really move and Orders can really be written; dropped afterwards)
const PSQL_RACE = PSQL.map(x => x === "cuvori" ? "cuvori_race" : x), PSQL_ADMIN = PSQL.map(x => x === "cuvori" ? "postgres" : x);
const runR = (sql) => { const r = spawnSync("psql", [...PSQL_RACE], { input: sql, encoding: "utf8", env }); return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() }; };
const backR = (sql, name) => { const p = spawn("psql", [...PSQL_RACE], { env: { ...env, PGAPPNAME: name }, stdio: ["pipe", "pipe", "pipe"] }); let buf = "";
  p.stdout.on("data", d => buf += d); p.stderr.on("data", d => buf += d); p.stdin.end(sql + "\n"); return { p, out: new Promise(r => p.on("close", () => r(buf))) }; };
const waiting = (rel, app) => /^n: [1-9]/m.test(run(`select 'n: ' || count(*) from pg_locks l join pg_class c on c.oid = l.relation join pg_stat_activity a on a.pid = l.pid where c.relname = '${rel}' and a.application_name = '${app}' and not l.granted;`).out);
const raceDb = (() => { for (let i = 0; i < 20; i++) { endSessions("cuvori-");
    const r = spawnSync("psql", [...PSQL_ADMIN], { input: "drop database if exists cuvori_race;\ncreate database cuvori_race template cuvori;\n", encoding: "utf8", env });
    if (r.status === 0) return true; spawnSync("sleep", ["0.2"]); } return false; })();
const raceReady = raceDb && runR(`${SETUP} ${owner} update public.pricing_plans set rules_version = '2026-11' where version = 2; ${RULES} select 'ready: ok';`).out.includes("ready: ok");
const switchR = (v) => runR(`${owner} select 'sw: ' || public.pricing_switch_to(${v}, 'race');`);
const makeR = (shown) => `${as("861")} select 'made: ' || (public.order_create_at_prices(${CV}, ${ORDER(10000)}, ${shown}) is not null); ${owner}`;
{ // P14a while a proposal is being written at the prices its form showed, your switch can't move (it would stamp the Order
  // with prices the check had not seen): the switch waits for it. The prices can still be read meanwhile
  const a = backR(`begin;\n${makeR(1)}\nselect pg_sleep(3);\nrollback;`, "cuvori-a");
  const busy = waitUntil(() => holds("pricing_switch", "cuvori-a", "RowShareLock"));
  const b = backR(`select 'sw: ' || public.pricing_switch_to(2, 'race');`, "cuvori-b");
  const queued = waitUntil(() => waiting("pricing_switch", "cuvori-b"));
  const read = timed(() => runR(`set statement_timeout = '1s'; select 'now: ' || (public.pricing_now()->>'version');`));
  const sw = await b.out; await a.out; switchR(1);
  vuln(!raceReady || !busy || !queued || !/sw: ok/.test(sw) || pick(read, "now") !== "1",
    `P14a ${raceReady ? "" : "(the race database could not be made) "}a proposal being written (it held the switch: ${busy}), then your switch to plan 2 -> waited for it: ${queued}, then ${(sw.match(/sw: \w+|ERROR:.*/) || ["no answer"])[0]}; the prices read meanwhile -> plan ${pick(read, "now")} in ${read.ms} ms (must hold, wait, then ok; plan 1 at once)`);
}
{ // P14b a proposal whose form showed plan 1 arrives while your switch to plan 2 is being written: it waits, then is refused
  const b = backR(`begin;\n${owner} select 'sw: ' || public.pricing_switch_to(2, 'race');\nselect pg_sleep(1.5);\ncommit;`, "cuvori-b");
  const busy = waitUntil(() => holds("pricing_switch", "cuvori-b", "ExclusiveLock"));
  const r = timed(() => runR(`begin; ${makeR(1)} rollback;`));
  await b.out; switchR(1);
  vuln(!busy || r.ok || !/pricing_changed/.test(errOf(r)) || r.ms < 800,
    `P14b ${busy ? "" : "(your switch never held: this check proved nothing) "}a proposal that showed plan 1 while your switch to plan 2 is written -> ${r.ok ? "WRITTEN: " + pick(r, "made") : errOf(r).slice(0, 40)} after ${r.ms} ms (must wait, then pricing_changed)`);
}
{ // P14c proposals arriving one after another can't keep your switch waiting: it goes once the proposal it waited for is
  // written (one that arrives after it waits for it), not after all of them
  const hold = (secs) => `begin; select version from public.pricing_switch where id for share; select pg_sleep(${secs}); rollback;`;
  const a = backR(hold(2), "cuvori-c1");
  const busy = waitUntil(() => holds("pricing_switch", "cuvori-c1", "RowShareLock"));
  const c = backR(`select pg_sleep(0.6);\n${hold(3)}`, "cuvori-c2");
  const r = timed(() => runR(`${owner} select 'sw: ' || public.pricing_switch_to(2, 'race');`));
  await a.out; await c.out; switchR(1);
  vuln(!busy || !r.ok || pick(r, "sw") !== "ok" || r.ms < 1000 || r.ms > 3000,
    `P14c ${busy ? "" : "(no proposal held the switch: this check proved nothing) "}your switch while one proposal is written and another arrives 0.6 s later -> ${r.ok ? pick(r, "sw") : errOf(r)} after ${r.ms} ms (must wait for the first, 1-3 s, not for the second until 3.6 s)`);
}
{ // P14d a plan can't be changed under an Order being written with it: the change waits, then is refused because the Order
  // now uses the plan. And it never waits more than 2 seconds (every Order write waits behind it meanwhile)
  switchR(2);
  const a = backR(`begin;\n${as("861")} select 'made: ' || (public.order_create(${CV}, ${ORDER(10000)}) is not null); ${owner}\nselect pg_sleep(1);\ncommit;`, "cuvori-d1");
  const busy = waitUntil(() => holds("contracts", "cuvori-d1", "RowExclusiveLock"));
  const r = timed(() => runR(`${owner} update public.pricing_plans set min_project_cents = 250 where version = 2; select 'changed: yes';`));
  await a.out;
  const used = pick(runR("select 'n: ' || count(*) from public.contracts where pricing_version = 2;"), "n");
  const b = backR(`begin;\n${owner} update public.contracts set title = title where false;\nselect pg_sleep(4);\nrollback;`, "cuvori-d2");
  const busy2 = waitUntil(() => holds("contracts", "cuvori-d2", "RowExclusiveLock"));
  const long = timed(() => runR(`${owner} update public.pricing_plans set min_project_cents = 100 where version = 1; select 'changed: yes';`));
  endSessions("cuvori-d"); b.p.kill();
  vuln(!busy || r.ok || !/pricing_plan_in_use/.test(errOf(r)) || used !== "1" || !busy2 || long.ok || !/lock timeout/.test(errOf(long)) || long.ms > 3000,
    `P14d changing plan 2 while an Order under it is being written -> ${r.ok ? "CHANGED" : errOf(r).slice(0, 40)} after ${r.ms} ms (Orders on plan 2 then: ${used}); a plan change while another Order write stays open -> ${long.ok ? "CHANGED" : errOf(long).slice(0, 40)} after ${long.ms} ms (must be pricing_plan_in_use; a lock timeout within 3 s)`);
}
{ // P14e v56 run again after your switch to plan 2 (for example by mistake): the switch stays on, and its last line says so
  const on = switchR(2), again = raceReady && fs.existsSync(V56) ? runR(fs.readFileSync(V56, "utf8")) : { ok: false, out: "", err: "missing" };
  const said = (again.out.split("\n").map(l => l.trim()).filter(l => /v56 (NOT )?applied/.test(l)).pop() || "");
  const now = pick(runR(`select 'v: ' || version from public.pricing_switch;`), "v"); switchR(1);
  vuln(!raceReady || !/sw: (ok|already)/.test(on.out) || !again.ok || /switched off/.test(said) || !/New Orders get plan 2/.test(said) || now !== "2",
    `P14e v56 run again with the new prices on (${(on.out.match(/sw: \w+/) || [errOf(on).slice(0, 40)])[0]}) -> ${again.ok ? said.slice(0, 90) || "no last line" : errOf(again).slice(0, 60)}; the switch then: plan ${now} (must not say "switched off", must say plan 2; plan 2)`);
}
endSessions("cuvori-");
for (let i = 0; i < 20 && spawnSync("psql", [...PSQL_ADMIN], { input: "drop database if exists cuvori_race;\n", encoding: "utf8", env }).status !== 0; i++) spawnSync("sleep", ["0.2"]);

console.log(out.join("\n"));
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(bad ? 1 : 0);
