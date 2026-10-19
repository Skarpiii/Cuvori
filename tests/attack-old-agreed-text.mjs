// The agreed text of Orders accepted before v38 (schema v48).
// Before v38 the text of an accepted Order (the clauses both people agreed to) was whatever the first browser sent
// afterwards through store_contract_doc, so either person could have saved a made-up contract text, and the Order screen
// and the printable copy show that text as the agreement. v38 made the database save the facts itself at acceptance and
// closed store_contract_doc, but left the copies saved before it as they were (one live Order has one).
// Now v48 rebuilds those copies from the database's own record of the Order (the same facts v38 saves, so the page builds
// the clause wording from its templates), when the Order was not changed after it was agreed. The browser's text is kept
// next to it for the record, but is no longer what the page shows. An Order changed after it was agreed is left as it is
// and counted, because today's values would then not be what was agreed.
// O1 an old Order with a made-up text, O2 one changed after it was agreed, O3 Orders that need nothing, O4 running v48
// again, O5 nobody can change the text afterwards. Every check is rolled back.
// Run: node tests/attack-old-agreed-text.mjs   (needs the local Postgres of tests/db; it is started here)
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
// 8f1 the client and 8f2 the freelancer. OLD: a finished €100 protected Order from before v38 whose saved text says the
// freelancer works for free; CHANGED: an Order paid outside Cuvori from before v38 with a €20 change accepted after it was
// agreed; NEW: an Order agreed after v38 (the database's own record); DRAFT: not agreed yet
const CV = "'1f600000-0000-0000-0000-000000000001'";
const OLD = "'3f600000-0000-0000-0000-000000000001'", CHANGED = "'3f600000-0000-0000-0000-000000000002'", NEW = "'3f600000-0000-0000-0000-000000000003'", DRAFT = "'3f600000-0000-0000-0000-000000000004'";
const MADE_UP = "The freelancer works for free and gives back every payment.";
const LEGACY = `'${JSON.stringify({ version: "v1-2026-09", lang: "en", at: "2026-09-25T03:05:00Z", clauses: [{ t: "Payment", b: MADE_UP }, { t: "Rights", b: "All rights go to the client." }] })}'`;
const SETUP = `
  insert into auth.users (id, email, raw_user_meta_data) values (${U("8f1")}, 'lea8f1@t.com', '{"first_name":"Lea"}'), (${U("8f2")}, 'max8f2@t.com', '{"first_name":"Max"}');
  update public.profiles set role = 'editor' where id = ${U("8f2")};
  insert into public.conversations (id, user_a, user_b) values (${CV}, ${U("8f1")}, ${U("8f2")});
  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, funded_cents, released_cents, accepted_at, funded_at, completed_at, stripe_payment_intent, clauses_version)
    values (${OLD}, ${CV}, ${U("8f2")}, ${U("8f1")}, ${U("8f2")}, 'Wedding film', 100, 'completed', 'escrow', 10000, 10000, 10000, now() - interval '20 days', now() - interval '20 days', now() - interval '9 days', 'pi_old8f1', 'v1-2026-09');
  insert into public.order_payments (order_id, kind, amount_cents, provider_ref) values (${OLD}, 'fund', 10000, 'pi_old8f1'), (${OLD}, 'release', 10000, 'tr_old8f1');
  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, accepted_at, paid_at, clauses_version)
    values (${CHANGED}, ${CV}, ${U("8f2")}, ${U("8f1")}, ${U("8f2")}, 'Teaser', 70, 'completed', 'direct', 7000, now() - interval '19 days', now() - interval '18 days', 'v1-2026-09');
  insert into public.order_amendments (order_id, proposed_by, note, price_delta_cents, status, decided_at, decided_by) values (${CHANGED}, ${U("8f2")}, 'One more cut', 2000, 'accepted', now() - interval '15 days', ${U("8f1")});
  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, accepted_at, paid_at, clauses_version)
    values (${NEW}, ${CV}, ${U("8f2")}, ${U("8f1")}, ${U("8f2")}, 'Reel', 40, 'paid', 'direct', 4000, now() - interval '2 days', now() - interval '1 day', 'v1-2026-09');
  update public.contracts c set terms_doc = public.order_terms_snapshot(c) where c.id = ${NEW};
  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents)
    values (${DRAFT}, ${CV}, ${U("8f2")}, ${U("8f1")}, ${U("8f2")}, 'Draft', 30, 'declined', 'direct', 3000);
  update public.contracts set terms_doc = ${LEGACY}::jsonb where id in (${OLD}, ${CHANGED});
  create temp table t_before on commit drop as select id, terms_doc from public.contracts where id in (${NEW}, ${DRAFT});
`;
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /^(psql:.*)?ERROR/.test(x)) || r.err.split("\n")[0] || "").replace(/^.*ERROR:\s*/, "")); };
const tx = (body) => run(`begin;\n${SETUP}\n${body}\nrollback;\n`);
{ const r = tx(`select 'setup: ok';`); if (pick(r, "setup") !== "ok") { console.log("the test's set-up failed: " + r.err); process.exit(1); } }
const TRY = (label, sql) => `do $$ begin execute ${"$q$" + sql + "$q$"}; perform set_config('t.${label}', 'done', true); exception when others then perform set_config('t.${label}', 'refused: ' || sqlerrm, true); end $$; select '${label}: ' || current_setting('t.${label}');`;
// what an Order's agreed copy is: the database's facts (and their price), or a text a browser saved (and its first clause)
const COPY = (o, label) => `select '${label}: ' || coalesce((select case when terms_doc->>'kind' = 'facts' then 'facts, €' || ((terms_doc->>'amount_cents')::int / 100) || ', version ' || (terms_doc->>'version')
    || case when terms_doc ? 'clauses' then ', with a text' else ', no text of its own' end || case when terms_doc->'browser_copy'->'clauses'->0->>'b' is not null then ', browser text kept aside' else '' end
  else 'browser text: ' || (terms_doc->'clauses'->0->>'b') end from public.contracts where id = ${o}), 'none');`;
const f = path.join(root, "supabase/schema_v48.sql");
const V48 = fs.existsSync(f) ? `\\i ${f}\n` : "";

{ // O1 the old Order with a made-up text
  const r = tx(`${V48} ${COPY(OLD, "old")}`);
  vuln(pick(r, "old") !== "facts, €100, version 1, no text of its own, browser text kept aside",
    `O1 a finished €100 Order agreed before v38, whose saved text says "${MADE_UP}" -> its agreed copy: ${pick(r, "old")} (must be the database's facts of the Order; the browser's text only kept aside)${V48 ? "" : " — supabase/schema_v48.sql is missing"}`);
}
{ // O2 an Order changed after it was agreed: left, and counted
  const r = tx(`${V48} ${COPY(CHANGED, "changed")}`);
  const rows = r.out.split("\n").filter(l => /^v48 /.test(l));
  vuln(!V48 || pick(r, "changed") !== `browser text: ${MADE_UP}` || !/left as they were[^:]*: 1\b/i.test(rows[0] || ""),
    `O2 an Order agreed before v38 and then changed (+€20) -> its copy: ${pick(r, "changed")}; v48 says: ${rows[0] ? `"${rows[0]}"` : "(nothing)"} (must be left as it is and counted: today's price is not what was agreed)`);
}
{ // O3 Orders that need nothing: agreed after v38 (the database's own record), and not agreed
  const r = tx(`${V48} select 'same: ' || count(*) from public.contracts c join t_before b on b.id = c.id where c.terms_doc is not distinct from b.terms_doc;`);
  vuln(!V48 || pick(r, "same") !== "2", `O3 an Order agreed after v38, and one never agreed -> unchanged: ${pick(r, "same")} of 2 (normal)`);
}
{ // O4 running v48 again
  const r = tx(`${V48}${V48} ${COPY(OLD, "old")}`);
  const rows = r.out.split("\n").filter(l => /^v48 /.test(l));
  vuln(!V48 || !r.ok || rows.length !== 2 || !rows.every(l => /^v48 applied/.test(l)) || !/rebuilt[^:]*: 1\b/.test(rows[0] || "") || !/rebuilt[^:]*: 0\b/.test(rows[1] || "")
       || pick(r, "old") !== "facts, €100, version 1, no text of its own, browser text kept aside",
    `O4 running v48 twice -> ${r.ok ? rows.map(l => `"${l}"`).join(" then ") || "no result row" : "error: " + r.err.split("\n").find(x => /ERROR/.test(x))}; the old Order's copy: ${pick(r, "old")}`);
}
{ // O5 nobody signed in can change the text afterwards (as since v38)
  const r = tx(`${V48} ${as("8f1")} ${TRY("rpc", `select public.store_contract_doc(${OLD}, '{"clauses":[{"t":"x","b":"y"}]}')`)}
                ${TRY("direct", `update public.contracts set terms_doc = '{"clauses":[{"t":"x","b":"y"}]}' where id = ${OLD}`)} ${owner} ${COPY(OLD, "old")}`);
  vuln(!V48 || !pick(r, "rpc").startsWith("refused") || pick(r, "old") !== "facts, €100, version 1, no text of its own, browser text kept aside",
    `O5 the client then tries to save a text of her own (the old way, and straight into the table) -> ${pick(r, "rpc").slice(0, 60)}; ${pick(r, "direct").slice(0, 60)}; the copy: ${pick(r, "old")} (must stay)`);
}
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
