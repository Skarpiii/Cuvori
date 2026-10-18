// Who may read a freelancer's bank details (schema v42).
// On an Order paid outside Cuvori ("direct"), the client needs the freelancer's bank details to pay, and the Order screen
// shows them while the Order waits for that payment or is being paid (accepted, marked paid, paid). payout_info also
// answered for a finished (completed) Order, with no end date: any client the freelancer ever finished such an Order with
// could keep reading the freelancer's bank details, including a new account the freelancer saved months later. The page
// never shows them then, so only someone reading the database's answers directly would see them.
// Now the database answers only while the client has an open direct Order with the freelancer, at the same stages the
// page shows them.
// B1–B2 a finished Order (the details then, and details saved later), B3 the stages that need them (normal), B4 other
// Orders and other people, B5 the page and the database agree on the stages, B6 running v42. Every check is rolled back.
// Run: node tests/attack-payout-info.mjs   (needs the local Postgres of tests/db; it is started here)
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
const as = (who) => who === "anon" ? "set local role anon; select set_config('request.jwt.claim.sub', '', true);"
  : `set local role authenticated; select set_config('request.jwt.claim.sub', ${U(who)}::text, true);`;
const owner = "reset role; select set_config('request.jwt.claim.sub', '', true);";
// 891 the client and 892 the freelancer (bank account LT11 ...) with an Order paid outside Cuvori; 893 a stranger
const CV = "'1a100000-0000-0000-0000-000000000001'", O = "'3a100000-0000-0000-0000-000000000001'";
const SETUP = `
  insert into auth.users (id, email, raw_user_meta_data) values (${U("891")}, 'xia891@t.com', '{"first_name":"Xia"}'), (${U("892")}, 'yan892@t.com', '{"first_name":"Yan"}'), (${U("893")}, 'zoe893@t.com', '{"first_name":"Zoe"}');
  update public.profiles set role = 'editor' where id = ${U("892")};
  insert into public.payout_details (id, methods, note) values (${U("892")}, '[{"type":"bank","details":"LT11 1000 0000 0000 0001"}]', 'Yan, Vilnius');
  insert into public.conversations (id, user_a, user_b) values (${CV}, ${U("891")}, ${U("892")});
  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, accepted_at)
    values (${O}, ${CV}, ${U("892")}, ${U("891")}, ${U("892")}, 'Paid outside', 100, 'accepted', 'direct', 10000, now());
`;
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /^(psql:.*)?ERROR/.test(x)) || r.err.split("\n")[0] || "").replace(/^.*ERROR:\s*/, "")); };
const tx = (body) => run(`begin;\n${SETUP}\n${body}\nrollback;\n`);
{ const r = tx("select 'setup: ok';"); if (pick(r, "setup") !== "ok") { console.log("the test's set-up failed: " + r.err); process.exit(1); } }
const STAGE = (status, mode = "direct") => `update public.contracts set status = '${status}', payment_mode = '${mode}'${status === "completed" ? ", completed_at = now(), closed_at = now()" : ""}${["cancelled", "declined"].includes(status) ? ", closed_at = now()" : ""} where id = ${O};`;
const READ = (who) => `${as(who)} select 'sees: ' || coalesce((public.payout_info(${U("892")})->'methods'->0->>'details'), 'nothing'); ${owner}`;

{ // B1 a finished Order paid outside Cuvori
  const r = tx(`${STAGE("completed")} ${READ("891")}`);
  vuln(pick(r, "sees") !== "nothing", `B1 the client of a finished Order paid outside Cuvori asks for the freelancer's bank details -> ${pick(r, "sees")} (must be nothing: the Order is paid and closed, the page no longer shows them)`);
}
{ // B2 a new bank account saved months later
  const r = tx(`${STAGE("completed")} update public.payout_details set methods = '[{"type":"bank","details":"LT22 2000 0000 0000 0002"}]' where id = ${U("892")}; ${READ("891")}`);
  vuln(pick(r, "sees") !== "nothing", `B2 the freelancer saves a new bank account after the Order finished; the former client asks again -> ${pick(r, "sees")} (must be nothing)`);
}
{ // B3 the stages that need them (normal)
  const got = [];
  for (const s of ["accepted", "paid_marked", "paid"]) { const r = tx(`${STAGE(s)} ${READ("891")}`); got.push(`${s}: ${pick(r, "sees")}`); }
  vuln(!got.every(g => g.endsWith("LT11 1000 0000 0000 0001")), `B3 the client while the Order waits for or is being paid (accepted, marked paid, paid) -> ${got.join("; ")} (normal: the details, to pay)`);
  const self = tx(`${STAGE("completed")} ${READ("892")}`);
  vuln(pick(self, "sees") !== "LT11 1000 0000 0000 0001", `B3b the freelancer reads their own details -> ${pick(self, "sees")} (normal)`);
}
{ // B4 other Orders and other people
  const cases = [["cancelled", "direct", "891", "the client of a cancelled Order"], ["declined", "direct", "891", "the client of a declined Order"],
                 ["proposed", "direct", "891", "the client of an Order not agreed yet"], ["funded", "escrow", "891", "the client of a protected payment"],
                 ["accepted", "direct", "893", "a stranger"], ["accepted", "direct", "anon", "a visitor"]];
  const wrong = [];
  for (const [s, mode, who, label] of cases) { const r = tx(`${STAGE(s, mode)} ${READ(who)}`); if (pick(r, "sees") !== "nothing") wrong.push(`${label}: ${pick(r, "sees")}`); }
  vuln(wrong.length > 0, `B4 ${cases.length} others ask for the details (cancelled, declined, not agreed, protected payment, a stranger, a visitor) -> ${wrong.length ? wrong.join("; ") : "nothing for all of them"}`);
}
{ // B5 the page shows them at the stages the database gives them
  for (const file of ["index.html", "orders-ui.js"]) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    const i = src.indexOf('sb.rpc("payout_info",{ ed:o.editor })');
    const guard = i < 0 ? null : (src.slice(Math.max(0, i - 400), i).match(/if\(\[([^\]]+)\]\.includes\(o\.status\)\)\{[^]*$/) || [])[1];
    const pageStages = guard ? guard.replace(/"/g, "").split(",").sort().join(",") : "(not found)";
    const r = run(`select 'db: ' || coalesce(substring(pg_get_functiondef('public.payout_info(uuid)'::regprocedure) from 'k\\.status in \\(([^)]*)\\)'), '(not found)');`);
    const dbStages = pick(r, "db").replace(/'|\s/g, "").split(",").sort().join(",");
    vuln(pageStages !== dbStages, `B5 ${file} shows the bank details at: ${pageStages}; the database gives them at: ${dbStages} (must be the same)`);
  }
}
{ // B6 running v42 (twice: the SQL editor may be run again)
  const f = path.join(root, "supabase/schema_v42.sql");
  if (!fs.existsSync(f)) vuln(true, "B6 supabase/schema_v42.sql is missing, so the live database keeps giving bank details for finished Orders");
  else {
    const r = tx(`\\i ${f}
\\i ${f}
                  ${STAGE("completed")} ${READ("891")}`);
    const rows = r.out.split("\n").filter(l => /^v42 /.test(l));
    vuln(!r.ok || rows.length !== 2 || !rows.every(l => /^v42 applied/.test(l)) || pick(r, "sees") !== "nothing",
      `B6 running v42 twice -> ${r.ok ? rows.map(l => `"${l}"`).join(" then ") || "no result row" : "error: " + r.err.split("\n").find(x => /ERROR/.test(x))}; then the finished Order's client sees: ${pick(r, "sees")}`);
  }
}
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
