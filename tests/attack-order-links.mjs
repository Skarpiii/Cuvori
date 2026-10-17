// What an Order is linked to (schema v40): the job post it came from, and the freelancer's service.
// order_create saved whatever job post and service the browser sent, without checking whose they were. An Order linked
// to a stranger's job post counted as a hire for it: once the Order was paid the stranger's post was closed as "filled"
// and left the jobs board, their "My jobs" list showed a hire they never made, and a protected payment showed as
// "Payment secured" on it. Two people in a chat (one of them a freelancer) could close anyone's job post this way, for
// free, with an Order paid outside Cuvori that the freelancer marks as received. The service link was not checked either.
// Now an Order keeps a job link only to the client's own job post, and a service link only to the freelancer's own
// service; any other link is not saved (the Order itself is made as usual). v40 also removes such links from Orders made
// before it.
// L1–L3 a stranger's job post (paid outside Cuvori, the stranger's list, a protected payment), L4 the client's own post
// (normal), L5–L6 the service link, L7 the other ways in, L8 Orders made before v40, L9 running v40. Every check is rolled back.
// Run: node tests/attack-order-links.mjs   (needs the local Postgres of tests/db; it is started here)
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
// 871 a client and 872 a freelancer in a chat; 873 a stranger with an open job post on the board; 874 another freelancer
const CV = "'1e000000-0000-0000-0000-000000000001'";
const JOB = "'6e000000-0000-0000-0000-000000000001'", OWNJOB = "'6e000000-0000-0000-0000-000000000002'";
const SVC = "'5e000000-0000-0000-0000-000000000001'", OTHERSVC = "'5e000000-0000-0000-0000-000000000002'";
const O = `(select id from public.contracts where conversation_id = ${CV} order by created_at desc limit 1)`;
const SETUP = `
  insert into auth.users (id, email, raw_user_meta_data) values (${U("871")}, 'ola871@t.com', '{"first_name":"Ola"}'), (${U("872")}, 'pim872@t.com', '{"first_name":"Pim"}'),
    (${U("873")}, 'rut873@t.com', '{"first_name":"Rut"}'), (${U("874")}, 'sam874@t.com', '{"first_name":"Sam"}');
  update public.profiles set role = 'editor' where id in (${U("872")}, ${U("874")});
  update public.profiles set visibility = 'public' where id in (${U("871")}, ${U("873")});
  insert into public.payout_details (id, methods, stripe_account_id, stripe_payouts_enabled) values (${U("872")}, '[]', 'acct_1TestPimAAAAAAA', true);
  insert into public.services (id, profile_id, profession_slug) select ${SVC}::uuid, ${U("872")}, slug from public.professions order by slug limit 1;
  insert into public.services (id, profile_id, profession_slug) select ${OTHERSVC}::uuid, ${U("874")}, slug from public.professions order by slug limit 1;
  insert into public.jobs (id, owner, title, status) values (${JOB}, ${U("873")}, 'Rut needs a wedding film', 'open'), (${OWNJOB}, ${U("871")}, 'Ola needs a promo video', 'open');
  insert into public.conversations (id, user_a, user_b) values (${CV}, ${U("871")}, ${U("872")});
`;
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /^(psql:.*)?ERROR/.test(x)) || r.err.split("\n")[0] || "").replace(/^.*ERROR:\s*/, "")); };
const tx = (body) => run(`begin;\n${SETUP}\n${body}\nrollback;\n`);
{ const r = tx("select 'setup: ok';"); if (pick(r, "setup") !== "ok") { console.log("the test's set-up failed: " + r.err); process.exit(1); } }
const ORDER = (mode, links) => `'${JSON.stringify({ title: "Wedding film", scope: "Edit the day", price_cents: 10000, deadline: "2099-12-01", revisions: 2, rights: "full", mode, language: "en", law: "DE", milestones: [], ...links })}'`;
// the freelancer sends the Order (from the job post, as the page does after "Apply"), the client accepts version 1
const MAKE = (mode, links, who = "872") => `${as(who)} select 'created: ' || (public.order_create(${CV}, ${ORDER(mode, links)}) is not null); ${owner}
  ${as(who === "872" ? "871" : "872")} select 'accepted: ' || public.order_action(p_order => ${O}, p_action => 'accept', p_version => 1); ${owner}`;
const PAID_OUTSIDE = `${as("872")} select 'paid: ' || public.order_action(${O}, 'confirm_paid'); ${owner}`;
const FUNDED = `update public.contracts set status = 'funded', funded_cents = amount_cents, funded_at = now() where id = ${O};`;
const LINKS = `select 'links: job ' || coalesce((select title from public.jobs where id = c.job_id), 'none') || ', service ' || coalesce((select p.first_name from public.services s join public.profiles p on p.id = s.profile_id where s.id = c.service_id), 'none') from public.contracts c where c.id = ${O};`;
const JOBSTATE = (j = JOB) => `select 'job: ' || status || ', on the board ' || (exists (select 1 from public.browse_jobs() b where b.id = ${j}))::text || ', payment secured ' || public.job_payment_secured(${j})::text from public.jobs where id = ${j};`;
const MYJOBS = (who, j = JOB) => `${as(who)} select 'list: ' || string_agg(x::text, '') from public.my_jobs() x where x.id = ${j}; ${owner}`;

{ // L1 a stranger's job post, with an Order paid outside Cuvori (free: the freelancer marks the money as received)
  const r = tx(`${MAKE("direct", { job_id: JOB.slice(1, -1) })} ${PAID_OUTSIDE} ${LINKS} ${JOBSTATE()}`);
  vuln(pick(r, "paid") !== "ok" || pick(r, "job") !== "open, on the board true, payment secured false" || !/^job none/.test(pick(r, "links")),
    `L1 a client and a freelancer link their Order to a stranger's job post and the freelancer marks it paid -> ${pick(r, "links")}; the stranger's post: ${pick(r, "job")} (must stay open on the board, and the Order must not be linked to it)`);
}
{ // L2 what the stranger sees in "My jobs"
  const r = tx(`${MAKE("direct", { job_id: JOB.slice(1, -1) })} ${PAID_OUTSIDE} ${MYJOBS("873")}`);
  const row = pick(r, "list"), hires = (row.match(/,(\d+),[tf]\)$/) || [])[1];
  vuln(hires !== "0", `L2 the stranger's "My jobs" list after that -> hires ${hires ?? "?"} (must be 0: they hired nobody)`);
}
{ // L3 a protected payment into such an Order
  const r = tx(`${MAKE("escrow", { job_id: JOB.slice(1, -1) })} ${FUNDED} ${JOBSTATE()}`);
  vuln(pick(r, "job") !== "open, on the board true, payment secured false", `L3 the same with a protected payment held -> the stranger's post: ${pick(r, "job")} (must stay open, and not say "Payment secured")`);
}
{ // L4 the client's own job post (normal): the Order is linked, and the post is filled once paid
  const r = tx(`${MAKE("direct", { job_id: OWNJOB.slice(1, -1) })} ${LINKS} ${PAID_OUTSIDE} ${JOBSTATE(OWNJOB)} ${MYJOBS("871", OWNJOB)}`);
  const hires = (pick(r, "list").match(/,(\d+),[tf]\)$/) || [])[1];
  vuln(!/^job Ola needs a promo video/.test(pick(r, "links")) || !/^filled/.test(pick(r, "job")) || hires !== "1",
    `L4 an Order made from the client's own job post (normal) -> ${pick(r, "links")}; her post once paid: ${pick(r, "job")}; her list: hires ${hires ?? "?"}`);
}
{ // L5 the service link: the freelancer's own service (normal), another freelancer's service
  const own = tx(`${MAKE("escrow", { service_id: SVC.slice(1, -1) })} ${LINKS}`);
  vuln(!/service Pim$/.test(pick(own, "links")), `L5a an Order with the freelancer's own service (normal) -> ${pick(own, "links")}`);
  const other = tx(`${MAKE("escrow", { service_id: OTHERSVC.slice(1, -1) })} ${LINKS}`);
  vuln(!/service none$/.test(pick(other, "links")), `L5b an Order with another freelancer's service -> ${pick(other, "links")} (must not be saved)`);
}
{ // L6 changing the service while the Order is still a draft
  const r = tx(`${as("872")} select 'created: ' || (public.order_create(${CV}, ${ORDER("escrow", { service_id: SVC.slice(1, -1) })}) is not null);
                select 'updated: ' || public.order_update(${O}, ${ORDER("escrow", { service_id: OTHERSVC.slice(1, -1) })}); ${owner} ${LINKS}`);
  vuln(pick(r, "updated") !== "ok" || !/service (Pim|none)$/.test(pick(r, "links")), `L6 the draft is edited to point at another freelancer's service -> ${pick(r, "updated")}; ${pick(r, "links")} (must not point at Sam's service)`);
}
{ // L7 the client sends it instead of the freelancer, and the payment functions write the link (no signed-in person)
  const r = tx(`${MAKE("direct", { job_id: JOB.slice(1, -1) }, "871")} ${LINKS}`);
  vuln(!/^job none/.test(pick(r, "links")), `L7a the client sends the Order linked to a stranger's post -> ${pick(r, "links")} (must not be linked)`);
  const r2 = tx(`${MAKE("direct", {})} update public.contracts set job_id = ${JOB} where id = ${O}; ${LINKS}`);
  vuln(!/^job none/.test(pick(r2, "links")), `L7b the link written straight into the table -> ${pick(r2, "links")} (must not be saved either)`);
}
{ // L8–L9 Orders made before v40, and running it (twice: the SQL editor may be run again)
  const f = path.join(root, "supabase/schema_v40.sql");
  if (!fs.existsSync(f)) vuln(true, "L8 supabase/schema_v40.sql is missing, so the live database keeps saving any job post and service link");
  else {
    // what an Order made before v40 may carry: links to a stranger's job post and to another freelancer's service
    const r = tx(`${MAKE("direct", {})} alter table public.contracts disable trigger user;
                  update public.contracts set job_id = ${JOB}, service_id = ${OTHERSVC} where id = ${O};
                  alter table public.contracts enable trigger user;
                  insert into public.contracts (conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, job_id, service_id)
                    values (${CV}, ${U("872")}, ${U("871")}, ${U("872")}, 'Own links', 50, 'cancelled', 'direct', 5000, ${OWNJOB}, ${SVC});
\\i ${f}
\\i ${f}
                  select 'before: ' || count(*) from public.contracts where conversation_id = ${CV} and (job_id = ${JOB} or service_id = ${OTHERSVC});
                  select 'own: ' || count(*) from public.contracts where conversation_id = ${CV} and job_id = ${OWNJOB} and service_id = ${SVC};`);
    const rows = r.out.split("\n").filter(l => /^v40 /.test(l));
    vuln(!r.ok || pick(r, "before") !== "0" || pick(r, "own") !== "1",
      `L8 an Order made before v40 with a stranger's job post and another freelancer's service -> links left: ${pick(r, "before")} (must be 0); an Order with the people's own links keeps them: ${pick(r, "own")} (must be 1)`);
    vuln(!r.ok || rows.length !== 2 || !/^v40 applied.*unlinked now: 1\./.test(rows[0]) || !/^v40 applied.*unlinked now: 0\./.test(rows[1]),
      `L9 running v40 twice -> ${r.ok ? rows.map(l => `"${l}"`).join(" then ") || "no result row" : "error: " + r.err.split("\n").find(x => /ERROR/.test(x))} (must answer "v40 applied" both times: 1 Order unlinked the first time, 0 the second)`);
  }
}
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
