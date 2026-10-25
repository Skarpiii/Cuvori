// The admin can mark an Order's note as handled (schema v55).
// Payouts and refunds now remove only their own note (attack-order-notes.mjs), so the other notes — a top-up that may not
// be recorded, a refund made in the Stripe dashboard, a chargeback Cuvori covered — stay in the admin panel's "Needs a hand"
// until a person has dealt with them. admin_clear_order_note is that person's button: only an admin, only while the note
// still reads what the admin saw, and never one of the notes Cuvori's hourly run works from (they go by themselves).
// H1 the admin marks a note as handled, H2 a newer note came in meanwhile, H3 the hourly run's notes, H4 not an admin
// (the client, the freelancer, someone signed out), H5 no note or no such Order, H6 running v55. Every check is rolled back.
// Run: node tests/attack-note-handled.mjs   (needs the local Postgres of tests/db; it is started here)
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
const O = "'30000000-0000-0000-0000-000000000003'";            // a paid Order: client 101, freelancer 202
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /^(psql:.*)?ERROR/.test(x)) || r.err.split("\n")[0] || "").replace(/^.*ERROR:\s*/, "")); };
const tx = (body) => run(`begin;\n${body}\nrollback;\n`);
const setNote = (note) => `update public.contracts set money_error = ${note == null ? "null" : lit(note)} where id = ${O};`;
const CLEAR = (label, who, note, order = O) => `${as(who)} select '${label}: ' || public.admin_clear_order_note(${order}, ${note == null ? "null" : lit(note)}); ${owner}`;
const NOTE = (label) => `select '${label}: ' || coalesce(money_error, '(none)') || ' / ' || coalesce(money_error_at::text, 'no time') from public.contracts where id = ${O};`;
const TOPUP = "top-up pi_3HandledTopup1 may not be recorded — check by hand";
{ const r = tx(`select 'setup: ' || count(*) from public.contracts where id = ${O};`); if (pick(r, "setup") !== "1") { console.log("the test's set-up failed: " + (r.err || r.out)); process.exit(1); } }
const fnThere = pick(tx(`select 'fn: ' || count(*) from pg_proc where proname = 'admin_clear_order_note';`), "fn") === "1";
if (!fnThere) vuln(true, "H0 there is no way for the admin to mark an Order's note as handled (admin_clear_order_note is missing), so a note now stays in \"Needs a hand\" for good");
else {
  { // H1 the admin marks a note as handled: it goes, with its time
    const r = tx(`${setNote(TOPUP)} ${CLEAR("clear", "401", TOPUP)} ${NOTE("after")}`);
    const lost = tx(`${setNote("chargeback lost; 12.00 could not be pulled back from the freelancer — Cuvori covered it, check by hand")}
      ${CLEAR("clear", "401", "chargeback lost; 12.00 could not be pulled back from the freelancer — Cuvori covered it, check by hand")} ${NOTE("after")}`);
    vuln(pick(r, "clear") !== "ok" || pick(r, "after") !== "(none) / no time" || pick(lost, "clear") !== "ok" || pick(lost, "after") !== "(none) / no time",
      `H1 the admin marks "${TOPUP.slice(0, 40)}…" as handled -> ${pick(r, "clear")}; the Order's note: ${pick(r, "after")}; a covered chargeback's note -> ${pick(lost, "clear")}, ${pick(lost, "after")} (must be ok and gone)`);
  }
  { // H2 a newer note came in after the admin opened the page: it stays, so the admin reads it first
    const r = tx(`${setNote("counter update failed for milestone 4c2a…")} ${CLEAR("clear", "401", TOPUP)} ${NOTE("after")}`);
    vuln(pick(r, "clear") !== "changed" || !pick(r, "after").startsWith("counter update failed"),
      `H2 the note changed after the admin saw it -> ${pick(r, "clear")}; the note: ${pick(r, "after").slice(0, 70)} (must be "changed" and kept)`);
  }
  { // H3 the notes the hourly run works from are not removed by hand
    const hourly = ["chargeback: Stripe did not answer (Netlify log ref 1a2b3c4d)", "chargeback won; re-payment pending",
      "chargeback won, re-payment failed: Stripe had a problem on its side (Netlify log ref 2b3c4d5e)",
      "ledger line of the first payment not saved: pi_3Handled1 (the hourly run adds it from Stripe's record; if this note stays, check by hand)",
      "ledger line of a milestone payout not saved: 9d1e (transfer tr_1; the hourly run adds it from Stripe's record; if this note stays, check by hand)",
      "ledger line of the re-payment not saved: tr_2 (100 paid again after chargeback dp_1; the hourly run adds it from Stripe's record; if this note stays, check by hand)"];
    const res = hourly.map(n => { const r = tx(`${setNote(n)} ${CLEAR("clear", "401", n)} ${NOTE("after")}`); return `${pick(r, "clear")}/${pick(r, "after").startsWith(n) ? "kept" : "GONE"}`; });
    vuln(res.some(x => x !== "automatic/kept"), `H3 the hourly run's own notes (${hourly.length}) -> ${res.join(", ")} (each must be "automatic" and kept)`);
  }
  { // H4 not an admin: the client, the freelancer on the Order, someone signed out
    const r = tx(`${setNote(TOPUP)} ${CLEAR("client", "101", TOPUP)} ${CLEAR("freelancer", "202", TOPUP)} ${NOTE("after")}`);
    const a = tx(`${setNote(TOPUP)} ${CLEAR("anon", "anon", TOPUP)}`); const after = tx(`${setNote(TOPUP)} ${NOTE("after")}`);
    vuln(pick(r, "client") !== "forbidden" || pick(r, "freelancer") !== "forbidden" || !pick(r, "after").startsWith(TOPUP) || pick(a, "anon").startsWith("ok") || !/permission denied/.test(pick(a, "anon")),
      `H4 not an admin -> the client ${pick(r, "client")}, the freelancer ${pick(r, "freelancer")}, the note ${pick(r, "after").startsWith(TOPUP) ? "kept" : "GONE"}; signed out ${pick(a, "anon").slice(0, 70)} (must be forbidden, kept, no permission)`);
  }
  { // H5 no note any more, or no such Order
    const r = tx(`${setNote(null)} ${CLEAR("none", "401", TOPUP)} ${CLEAR("nosuch", "401", TOPUP, "'30000000-0000-0000-0000-0000000000ff'")}`);
    vuln(pick(r, "none") !== "ok" || pick(r, "nosuch") !== "not_found", `H5 no note left -> ${pick(r, "none")}; no such Order -> ${pick(r, "nosuch")} (must be ok, not_found)`);
  }
}
{ // H6 running v55 (twice: the SQL editor may be run again)
  const f = path.join(root, "supabase/schema_v55.sql");
  if (!fs.existsSync(f)) vuln(true, "H6 supabase/schema_v55.sql is missing");
  else {
    const r = tx(`\\i ${f}
\\i ${f}
      ${setNote(TOPUP)} ${CLEAR("clear", "401", TOPUP)}`);
    const rows = r.out.split("\n").filter(l => /^v55 /.test(l));
    vuln(!r.ok || rows.length !== 2 || !rows.every(l => /^v55 applied/.test(l)) || pick(r, "clear") !== "ok",
      `H6 running v55 twice -> ${r.ok ? rows.map(l => `"${l.slice(0, 60)}"`).join(" then ") || "no result row" : "error: " + r.err.split("\n").find(x => /ERROR/.test(x))}; then marking a note handled -> ${pick(r, "clear")}`);
  }
}
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
