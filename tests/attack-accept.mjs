// The moment two people accept an Order (schema v38).
// 1. Accept did not say which version the person had read. The Order screen does not refresh by itself, so when the other
//    side changed the Order (a higher price, a shorter deadline) a moment before the click, the click accepted the new
//    version the person never saw, and with the other side's acceptance already on it the Order was agreed at that price.
//    Now the page sends the version it shows, and the database refuses an Accept for any other version (or none).
// 2. The text of an accepted Order (the clauses both people agreed to) was whatever the first browser sent afterwards
//    through store_contract_doc: either person could save a made-up contract text once, and it then counted as the
//    agreed, unchangeable copy. Now the database itself saves what was agreed, in the same step as the acceptance, and
//    nobody signed in can write it.
// A1 a stale Accept, A2 the version shown (normal), A3 no version, A4 the other entry points, A5 what the database saves,
// A6 a made-up text, A7 who may write it, A8 a later amendment, A9 an Order from before v18 (normal), A10 running v38,
// A11 the page. Every database check is rolled back.
// Run: node tests/attack-accept.mjs   (needs the local Postgres of tests/db; it is started here)
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
// 851 the client, 852 the freelancer ("Max Films"), 853 a stranger
const CV = "'1c000000-0000-0000-0000-000000000001'";
const O = `(select id from public.contracts where conversation_id = ${CV} order by created_at desc limit 1)`;
const ORDER = (cents, title = "Wedding film") => `'{"title":"${title}","scope":"Edit the wedding day into a 10-minute film","deliverables":"Final 4K MP4","price_cents":${cents},"deadline":"2026-12-01","revisions":2,"rights":"full","mode":"escrow","language":"en","law":"DE","milestones":[]}'`;
const SETUP = `
  insert into auth.users (id, email, raw_user_meta_data) values (${U("851")}, 'eva851@t.com', '{"first_name":"Eva"}'), (${U("852")}, 'max852@t.com', '{"first_name":"Max"}'), (${U("853")}, 'zed853@t.com', '{"first_name":"Zed"}');
  update public.profiles set role = 'editor' where id = ${U("852")};
  insert into public.editor_profiles (id, display_name) values (${U("852")}, 'Max Films') on conflict (id) do update set display_name = excluded.display_name;
  insert into public.payout_details (id, methods, stripe_account_id, stripe_payouts_enabled) values (${U("852")}, '[]', 'acct_1TestMaxAAAAAAA', true);
  insert into public.conversations (id, user_a, user_b) values (${CV}, ${U("851")}, ${U("852")});
  -- the client drafts a €400 Order (version 1, which the client has accepted by sending it)
  ${as("851")} select 'created: ' || (public.order_create(${CV}, ${ORDER(40000)}) is not null); ${owner}
`;
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /^(psql:.*)?ERROR/.test(x)) || r.err.split("\n")[0] || "").replace(/^.*ERROR:\s*/, "")); };
const tx = (body) => run(`begin;\n${SETUP}\n${body}\nrollback;\n`);
{ const r = tx("select 'setup: ok';"); if (pick(r, "created") !== "true" || pick(r, "setup") !== "ok") { console.log("the test's set-up failed: " + r.err); process.exit(1); } }

// does this database let the page say which version it shows? (before v38 it does not: the page could only send the action)
const takesVersion = pick(run(`select 'v: ' || exists (select 1 from pg_proc where pronamespace = 'public'::regnamespace and proname = 'order_action' and 'p_version' = any(proargnames));`), "v") === "true";
const NOTE = takesVersion ? "" : " [this database cannot be told which version was read, so the page's call is order_action(order, 'accept')]";
const accept = (ver) => takesVersion
  ? `select 'answer: ' || public.order_action(p_order => ${O}, p_action => 'accept', p_version => ${ver});`
  : `select 'answer: ' || public.order_action(${O}, 'accept');`;
const STATE = `select 'order: ' || status || ', version ' || terms_version || ', €' || (amount_cents / 100) || ', freelancer accepted ' || coalesce('version ' || freelancer_accepted_version, 'nothing')
  || coalesce(', agreed on version ' || accepted_version, '') from public.contracts where id = ${O};`;
// the client raises the price to €500 (version 2); the freelancer's screen still shows version 1 at €400
const RAISE = `${as("851")} select 'raised: ' || public.order_update(${O}, ${ORDER(50000)}); ${owner}`;
const DOC = `select 'doc: ' || coalesce(jsonb_pretty(terms_doc), 'none') from public.contracts where id = ${O};`;
const docOf = (r) => { const i = r.out.indexOf("doc: "); if (i < 0) return null; const s = r.out.slice(i + 5); if (s.startsWith("none")) return null; try { return JSON.parse(s.slice(0, s.lastIndexOf("}") + 1)); } catch (e) { return null; } };

{ // A1 a stale Accept
  const r = tx(`${RAISE} ${as("852")} ${accept(1)} ${owner} ${STATE}`);
  vuln(pick(r, "raised") !== "ok" || pick(r, "answer") !== "order_changed" || pick(r, "order") !== "proposed, version 2, €500, freelancer accepted nothing",
    `A1 the client raises the price from €400 to €500 a moment before the freelancer, still looking at version 1, clicks Accept -> ${pick(r, "answer")}; ${pick(r, "order")}${NOTE} (must be refused: order_changed, and the Order stays unaccepted)`);
}
{ // A2 the version shown (normal)
  const r = tx(`${RAISE} ${as("852")} ${accept(2)} ${owner} ${STATE}`);
  vuln(pick(r, "answer") !== "ok" || pick(r, "order") !== "accepted, version 2, €500, freelancer accepted version 2, agreed on version 2",
    `A2 the freelancer reads version 2 at €500 and accepts it -> ${pick(r, "answer")}; ${pick(r, "order")} (normal: agreed)`);
}
{ // A3 no version: an old page left open, or a call made by hand
  const r = tx(`${as("852")} select 'answer: ' || public.order_action(${O}, 'accept'); ${owner} ${STATE}`);
  vuln(pick(r, "answer") !== "order_changed" || !pick(r, "order").startsWith("proposed"),
    `A3 an Accept that names no version (a page opened before the update) -> ${pick(r, "answer")}; ${pick(r, "order")} (must be refused: the database cannot know what was read)`);
}
{ // A4 the other two ways in: order_accept itself, and the old contract_action
  const direct = takesVersion ? `select 'answer: ' || public.order_accept(${O}, 1);` : `select 'answer: ' || public.order_accept(${O});`;
  const r = tx(`${RAISE} ${as("852")} ${direct} ${owner} ${STATE}`);
  vuln(pick(r, "answer") !== "order_changed" || !pick(r, "order").startsWith("proposed"),
    `A4a order_accept called directly for version 1 after the change -> ${pick(r, "answer")}; ${pick(r, "order")}${NOTE.replace("order_action(order, 'accept')", "order_accept(order)")} (must be refused)`);
  const r2 = tx(`${RAISE} ${as("852")} select 'answer: ' || public.contract_action(${O}, 'accept'); ${owner} ${STATE}`);
  vuln(pick(r2, "answer") !== "order_changed" || !pick(r2, "order").startsWith("proposed"),
    `A4b the old contract_action('accept'), which names no version -> ${pick(r2, "answer")}; ${pick(r2, "order")} (must be refused)`);
}
{ // A5 what the database saves when both have accepted
  const r = tx(`${RAISE} ${as("852")} ${accept(2)} ${owner} ${DOC}`);
  const d = docOf(r) || {};
  const okDoc = d.kind === "facts" && d.version === 2 && d.amount_cents === 50000 && Number(d.price) === 500 && d.title === "Wedding film" && d.client_name === "Eva" && d.freelancer_name === "Max Films"
    && d.law_country === "DE" && d.language === "en" && d.payment_mode === "escrow" && d.deadline === "2026-12-01" && !!d.accepted_at && d.clauses_version && d.terms && typeof d.terms === "object";
  vuln(pick(r, "answer") !== "ok" || !okDoc,
    `A5 right after both accepted, what the Order keeps as agreed -> ${docOf(r) ? `${d.kind || "?"} format: version ${d.version}, €${d.price}, "${d.title}", ${d.client_name} and ${d.freelancer_name}, law ${d.law_country}, language ${d.language}, ${d.payment_mode}, deadline ${d.deadline}` : "nothing yet (the first browser to send a text decides it)"} (must be saved by the database, in the same step: version 2, €500, both names, the terms)`);
}
// a call that may be refused: its answer (or the refusal) is kept, and the checks after it still run
const STORE = (doc) => `do $$ begin perform set_config('t.call', public.store_contract_doc(${O}, ${doc}), true); exception when others then perform set_config('t.call', sqlerrm, true); end $$; select 'call: ' || current_setting('t.call');`;
{ // A6 a made-up text, by either person, after acceptance
  const fake = `'{"clauses":[{"t":"Price","b":"The freelancer works for free."}],"version":"v1-2026-09","lang":"en"}'`;
  for (const [who, label] of [["851", "the client"], ["852", "the freelancer"]]) {
    const r = tx(`${RAISE} ${as("852")} ${accept(2)} ${owner} ${as(who)} ${STORE(fake)} ${owner}
                  select 'text: ' || coalesce(terms_doc->'clauses'->0->>'b', terms_doc->>'kind', 'none') from public.contracts where id = ${O};`);
    vuln(pick(r, "text") === "The freelancer works for free.",
      `A6 ${label} sends a made-up contract text after both accepted -> ${pick(r, "call")}; the Order's agreed copy is now: ${pick(r, "text")} (must stay what the database saved)`);
  }
  // the old way also let the first browser win before anything was saved: try it on an Order agreed before v38 (no copy yet)
  const r = tx(`${RAISE} ${as("852")} ${accept(2)} ${owner} update public.contracts set terms_doc = null where id = ${O};
                ${as("851")} ${STORE(fake)} ${owner}
                select 'text: ' || coalesce(terms_doc->'clauses'->0->>'b', 'none') from public.contracts where id = ${O};`);
  vuln(pick(r, "text") === "The freelancer works for free.",
    `A6c the client sends a made-up text for an agreed Order that has no saved copy yet (as every Order agreed before v38) -> ${pick(r, "call")}; saved: ${pick(r, "text")} (must be refused)`);
}
{ // A7 who may write the agreed copy, or call the function that builds it
  const r = run(`select 'rights: ' || coalesce(string_agg(p.proname || ' for ' || r.r, ', ' order by p.proname, r.r), 'none') from pg_proc p cross join (values ('anon'), ('authenticated')) r(r)
                 where p.pronamespace = 'public'::regnamespace and p.proname in ('store_contract_doc', 'order_terms_snapshot') and has_function_privilege(r.r, p.oid, 'execute');`);
  vuln(pick(r, "rights") !== "none", `A7 who may call store_contract_doc or order_terms_snapshot -> ${pick(r, "rights")} (must be none)`);
  const r2 = run(`select 'cols: ' || coalesce(string_agg(grantee || ' ' || privilege_type, ', '), 'none') from information_schema.column_privileges
                  where table_schema = 'public' and table_name = 'contracts' and column_name = 'terms_doc' and grantee in ('anon', 'authenticated') and privilege_type = 'UPDATE';
                  select 'pol: ' || count(*) from pg_policies where schemaname = 'public' and tablename = 'contracts' and cmd in ('UPDATE', 'ALL');`);
  vuln(!(pick(r2, "cols") === "none" || pick(r2, "pol") === "0"), `A7b writing the copy straight into the table -> column rights: ${pick(r2, "cols")}; update rules: ${pick(r2, "pol")} (must be no way in)`);
}
{ // A8 an amendment after acceptance changes the Order, not what was agreed at acceptance
  const r = tx(`${RAISE} ${as("852")} ${accept(2)} ${owner}
                ${as("851")} select 'proposed: ' || (public.order_amend(${O}, '{"note":"More footage","price_delta_cents":10000}') is not null); ${owner}
                ${as("852")} select 'amended: ' || public.order_amendment_decide((select id from public.order_amendments where order_id = ${O} order by created_at desc limit 1), true); ${owner}
                select 'now: €' || (amount_cents / 100) || ', agreed copy €' || coalesce(((terms_doc->>'amount_cents')::int / 100)::text, 'none') from public.contracts where id = ${O};`);
  vuln(pick(r, "amended") !== "ok" || pick(r, "now") !== "€600, agreed copy €500",
    `A8 after acceptance both agree an extra €100 -> ${pick(r, "amended")}; ${pick(r, "now")} (the amendment shows on its own; the copy of what was agreed at acceptance must stay €500)`);
}
{ // A9 an Order from before v18 (no acceptance columns), accepted with its version (normal)
  const r = tx(`update public.contracts set client_accepted_version = null, client_accepted_at = null, proposed_by = ${U("851")} where id = ${O};
                ${as("852")} ${accept(1)} ${owner} ${STATE}`);
  vuln(pick(r, "answer") !== "ok" || !pick(r, "order").startsWith("accepted, version 1"),
    `A9 an Order from before v18 accepted by the other side with the version shown -> ${pick(r, "answer")}; ${pick(r, "order")} (normal)`);
}
{ // A10 running v38 (twice: the SQL editor may be run again)
  const f = path.join(root, "supabase/schema_v38.sql");
  if (!fs.existsSync(f)) vuln(true, "A10 supabase/schema_v38.sql is missing, so the live database keeps the old Accept and the open store_contract_doc");
  else {
    const r = tx(`${as("852")} ${accept(1)} ${owner} update public.contracts set terms_doc = '{"clauses":[{"t":"x","b":"y"}]}' where id = ${O};
\\i ${f}
\\i ${f}
                  select 'after: ' || (terms_doc->'clauses'->0->>'b') from public.contracts where id = ${O};`);
    const rows = r.out.split("\n").filter(l => /^v38 /.test(l));
    vuln(!r.ok || rows.length !== 2 || !rows.every(l => /^v38 applied/.test(l)) || pick(r, "after") !== "y",
      `A10 running v38 twice over an Order agreed before it -> ${r.ok ? rows.map(l => `"${l}"`).join(" then ") || "no result row" : "error: " + r.err.split("\n").find(x => /ERROR/.test(x))}; the copy that Order already had: ${pick(r, "after")} (must answer "v38 applied" both times and leave existing copies as they are)`);
  }
}
{ // A11 the page: it sends the version it shows, and no longer saves a text of its own
  for (const file of ["index.html", "orders-ui.js"]) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    const line = (src.split("\n").find(l => /act\("accept"/.test(l)) || "");
    const rpcLine = (src.split("\n").find(l => /const rpc=\(a,note,link/.test(l)) || "");
    const sendsVersion = /rpc\("accept",[^)]*o\.terms_version\)/.test(line) && /p_version/.test(rpcLine);
    const stores = /store_contract_doc/.test(src) || /ctFreezeDoc\(/.test(line);
    vuln(!sendsVersion || stores, `A11 ${file}: the Accept button ${sendsVersion ? "sends the version shown" : "sends no version"}; the page ${stores ? "still saves its own contract text" : "saves no contract text"}`);
  }
}
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
