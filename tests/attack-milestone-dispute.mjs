// Milestone actions only while the Order is being worked on (schema v43).
// The Order screen shows a milestone's "Request changes" and "Approve" only while the Order is paid in and open (a
// protected payment held, or a payment outside Cuvori confirmed). The database checked only the milestone, not the Order:
// - during a dispute, the client could still send a submitted milestone back ("Request changes", also from the video
//   review screen): it went back to "not delivered", used up one of the paid revision rounds, and changed what Cuvori was
//   deciding on while the freelancer could no longer deliver it again (delivering needs an open Order);
// - after a refund, or after an Order paid outside Cuvori was completed, the same still worked, and "Approve" on an Order
//   paid outside Cuvori still marked a milestone approved after the Order was finished.
// Now both are refused unless the Order is open for work, the same rule the screen uses.
// M1 during a dispute, M2 after a refund, M3 an open Order (normal), M4 an Order paid outside Cuvori, M5 running v43.
// Every check is rolled back.
// Run: node tests/attack-milestone-dispute.mjs   (needs the local Postgres of tests/db; it is started here)
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
// 8a1 the client and 8a2 the freelancer: a €100 Order in two €50 milestones with 2 paid revision rounds, the first
// milestone submitted
const CV = "'1a200000-0000-0000-0000-000000000001'", O = "'3a200000-0000-0000-0000-000000000001'";
const M1 = "'4a200000-0000-0000-0000-000000000001'", M2 = "'4a200000-0000-0000-0000-000000000002'";
const SETUP = (status, mode = "escrow") => `
  insert into auth.users (id, email, raw_user_meta_data) values (${U("8a1")}, 'amy8a1@t.com', '{"first_name":"Amy"}'), (${U("8a2")}, 'bob8a2@t.com', '{"first_name":"Bob"}');
  update public.profiles set role = 'editor' where id = ${U("8a2")};
  insert into public.conversations (id, user_a, user_b) values (${CV}, ${U("8a1")}, ${U("8a2")});
  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, funded_cents, has_milestones, revisions, changes_used, accepted_at, funded_at, paid_at)
    values (${O}, ${CV}, ${U("8a2")}, ${U("8a1")}, ${U("8a2")}, 'Two-part film', 100, '${status}', '${mode}', 10000, 10000, true, 2, 0, now(), now(), now());
  insert into public.order_milestones (id, order_id, position, title, amount_cents, status, submitted_at, auto_release_at)
    values (${M1}, ${O}, 1, 'First cut', 5000, 'submitted', now(), ${mode === "escrow" ? "now() + interval '7 days'" : "null"}), (${M2}, ${O}, 2, 'Final', 5000, 'pending', null, null);
`;
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /^(psql:.*)?ERROR/.test(x)) || r.err.split("\n")[0] || "").replace(/^.*ERROR:\s*/, "")); };
const tx = (setup, body) => run(`begin;\n${setup}\n${body}\nrollback;\n`);
{ const r = tx(SETUP("funded"), "select 'setup: ok';"); if (pick(r, "setup") !== "ok") { console.log("the test's set-up failed: " + r.err); process.exit(1); } }
const MS = (action) => `${as("8a1")} select 'answer: ' || public.order_milestone_action(${M1}, '${action}', 'Please redo the intro'); ${owner}`;
const STATE = `select 'state: milestone ' || (select status from public.order_milestones where id = ${M1}) || ', rounds used ' || changes_used || ', Order ' || status from public.contracts where id = ${O};`;

{ // M1 during a dispute
  const r = tx(SETUP("funded"), `${as("8a1")} select 'disputed: ' || public.order_action(${O}, 'dispute', 'The edit is not what we agreed'); ${owner} ${MS("request_changes")} ${STATE}`);
  vuln(pick(r, "disputed") !== "ok" || pick(r, "answer") !== "not_allowed" || pick(r, "state") !== "milestone submitted, rounds used 0, Order disputed",
    `M1 the client opens a dispute, then asks for changes on the submitted first milestone -> ${pick(r, "answer")}; ${pick(r, "state")} (must be refused: the milestone stays submitted for Cuvori to decide on, no round used)`);
}
{ // M2 after a refund
  const r = tx(SETUP("refunded"), `${MS("request_changes")} ${STATE}`);
  vuln(pick(r, "answer") !== "not_allowed" || !pick(r, "state").startsWith("milestone submitted, rounds used 0"),
    `M2 the Order was refunded; the client asks for changes on the milestone left submitted -> ${pick(r, "answer")}; ${pick(r, "state")} (must be refused: the Order is closed)`);
}
{ // M3 an open Order (normal)
  const r = tx(SETUP("funded"), `${MS("request_changes")} ${STATE}`);
  vuln(pick(r, "answer") !== "ok" || pick(r, "state") !== "milestone pending, rounds used 1, Order funded",
    `M3 the Order is paid in and open; the client asks for changes on the submitted milestone -> ${pick(r, "answer")}; ${pick(r, "state")} (normal: back to the freelancer, one round used)`);
}
{ // M4 an Order paid outside Cuvori: open (normal), and after it was completed
  const open = tx(SETUP("paid", "direct"), `${MS("approve")} ${STATE}`);
  vuln(pick(open, "answer") !== "ok" || !pick(open, "state").startsWith("milestone approved"),
    `M4a an Order paid outside Cuvori and confirmed; the client approves the submitted milestone -> ${pick(open, "answer")}; ${pick(open, "state")} (normal)`);
  const done = [];
  for (const a of ["approve", "request_changes"]) { const r = tx(SETUP("completed", "direct"), `${MS(a)} ${STATE}`); done.push(`${a}: ${pick(r, "answer")} (${pick(r, "state")})`); }
  vuln(!done.every(d => d.includes(": not_allowed (milestone submitted, rounds used 0")),
    `M4b the same Order after it was completed; the client approves, or asks for changes on, the milestone left submitted -> ${done.join("; ")} (must be refused: the Order is finished)`);
}
{ // M5 running v43 (twice: the SQL editor may be run again)
  const f = path.join(root, "supabase/schema_v43.sql");
  if (!fs.existsSync(f)) vuln(true, "M5 supabase/schema_v43.sql is missing, so the live database still lets a milestone be sent back during a dispute");
  else {
    const r = tx(SETUP("disputed"), `\\i ${f}
\\i ${f}
                  ${MS("request_changes")} ${STATE}`);
    const rows = r.out.split("\n").filter(l => /^v43 /.test(l));
    vuln(!r.ok || rows.length !== 2 || !rows.every(l => /^v43 applied/.test(l)) || pick(r, "answer") !== "not_allowed",
      `M5 running v43 twice -> ${r.ok ? rows.map(l => `"${l}"`).join(" then ") || "no result row" : "error: " + r.err.split("\n").find(x => /ERROR/.test(x))}; then changes during a dispute: ${pick(r, "answer")}`);
  }
}
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
