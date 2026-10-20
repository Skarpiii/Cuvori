// A card chargeback flags the client (schema v49).
// When a client's bank takes a payment back (a chargeback), the payment functions (netlify/lib/cuvori.mjs,
// onDisputeCreated) put a flag on the client: kind "chargeback", so the admin page lists them under Bad actors, a later
// account with the same e-mail, card or bank account is matched to them, and deleting the account keeps their details on
// the list new accounts are checked against. The table only allowed the kinds scam, dispute_lost, abuse, fake, match and
// other, so that flag was refused every time, and the payment functions ignore a failed flag: a client who charged back
// was never flagged, and could do it again from a new account unnoticed.
// Now "chargeback" is an allowed kind, and v49 adds the flag for every Order that already had a chargeback.
// C1 the flag the payment functions save, C2 what the flag does, C3 the other kinds (normal), C4 Orders charged back
// before v49 and running it. Every check is rolled back.
// Run: node tests/attack-chargeback-flag.mjs   (needs the local Postgres of tests/db; it is started here)
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
const as = (who) => who === "service" ? "set local role service_role; select set_config('request.jwt.claim.sub', '', true);"
  : `set local role authenticated; select set_config('request.jwt.claim.sub', ${U(who)}::text, true);`;
const owner = "reset role; select set_config('request.jwt.claim.sub', '', true);";
// 8a71 the client, 8a72 the freelancer: a finished €100 protected Order the client's bank then took back; the client's
// card was recorded when she paid
const CV = "'1a700000-0000-0000-0000-000000000001'", O = "'3a700000-0000-0000-0000-000000000001'";
const SETUP = `
  insert into auth.users (id, email, raw_user_meta_data) values (${U("8a71")}, 'nora8a71@t.com', '{"first_name":"Nora"}'), (${U("8a72")}, 'otto8a72@t.com', '{"first_name":"Otto"}');
  update public.profiles set role = 'editor' where id = ${U("8a72")};
  insert into public.conversations (id, user_a, user_b) values (${CV}, ${U("8a71")}, ${U("8a72")});
  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, funded_cents, released_cents, accepted_at, funded_at, completed_at, stripe_payment_intent, chargeback_id, chargeback_status, chargeback_cents)
    values (${O}, ${CV}, ${U("8a72")}, ${U("8a71")}, ${U("8a72")}, 'Wedding film', 100, 'completed', 'escrow', 10000, 10000, 10000, now() - interval '20 days', now() - interval '20 days', now() - interval '9 days', 'pi_cb8a71', 'dp_8a71', 'open', 10000);
  insert into public.order_payments (order_id, kind, amount_cents, provider_ref) values (${O}, 'fund', 10000, 'pi_cb8a71'), (${O}, 'release', 10000, 'tr_cb8a71');
  select public.record_card(${U("8a71")}, 'fpCard8a71', 'visa ••4242');
  select set_config('t.client', ${U("8a71")}::text, true), set_config('t.order', ${O}::text, true);
`;
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /^(psql:.*)?ERROR/.test(x)) || r.err.split("\n")[0] || "").replace(/^.*ERROR:\s*/, "")); };
const tx = (body) => run(`begin;\n${SETUP}\n${body}\nrollback;\n`);
{ const r = tx(`select 'setup: ok';`); if (pick(r, "setup") !== "ok") { console.log("the test's set-up failed: " + r.err); process.exit(1); } }
const TRY = (label, sql) => `do $$ begin execute ${"$q$" + sql + "$q$"}; perform set_config('t.${label}', 'saved', true); exception when others then perform set_config('t.${label}', 'refused: ' || sqlerrm, true); end $$; select '${label}: ' || current_setting('t.${label}');`;
// exactly what onDisputeCreated (netlify/lib/cuvori.mjs) saves, with the payment functions' key
const FLAG = `${as("service")} ${TRY("flag", `insert into public.user_flags (user_id, kind, reason, contract_id) values (current_setting('t.client')::uuid, 'chargeback', 'Chargeback dp_8a71 on "Wedding film" (order was completed)', current_setting('t.order')::uuid)`)} ${owner}`;
const FLAGS = `select 'flags: ' || coalesce((select string_agg(kind, ',' order by kind) from public.user_flags where user_id = ${U("8a71")}), 'none');`;
const said = (s) => s.startsWith("refused: ") && /user_flags_kind_check/.test(s) ? "refused (this kind of flag is not allowed)" : s;

{ // C1 the flag the payment functions save after a chargeback
  const r = tx(`${FLAG} ${FLAGS}`);
  vuln(pick(r, "flag") !== "saved" || pick(r, "flags") !== "chargeback",
    `C1 the client's bank takes back €100 after the Order was finished; the payment functions flag the client -> ${said(pick(r, "flag"))}; the client's flags: ${pick(r, "flags")} (must be saved)`);
}
{ // C2 what the flag does: the Bad actors list, a new account with the same card, and deleting the account
  const r = tx(`${FLAG}
    ${as("401")} select 'listed: ' || count(*) from public.admin_list_bad_actors() b where b.id = ${U("8a71")} and b.flags::text like '%chargeback%'; ${owner}
    insert into auth.users (id, email, raw_user_meta_data) values (${U("8a73")}, 'nora.new8a73@t.com', '{"first_name":"Nora"}');
    select public.record_card(${U("8a73")}, 'fpCard8a71', 'visa ••4242');
    select 'new account: ' || coalesce((select string_agg(kind, ',') from public.user_flags where user_id = ${U("8a73")}), 'not matched');
    update public.contracts set chargeback_status = 'lost' where id = ${O};   -- the bank decided; deleting no longer waits
    ${as("8a71")} select 'delete: ' || public.delete_my_account(); ${owner}
    select 'kept against new accounts: ' || count(*) from public.deleted_user_identifiers where note like '%chargeback%';`);
  vuln(pick(r, "listed") !== "1" || pick(r, "new account") !== "match" || pick(r, "delete") !== "ok" || !(Number(pick(r, "kept against new accounts")) >= 2),
    `C2 after the flag: on the admin's Bad actors list -> ${pick(r, "listed")}; a new account paying with the same card -> ${pick(r, "new account")}; she deletes her account -> ${pick(r, "delete")}, her e-mail and card kept against new accounts: ${pick(r, "kept against new accounts")} (must be: listed, matched, kept)`);
}
{ // C3 the other kinds still work, and a made-up kind is still refused
  const r = tx(`${as("401")} select 'admin flag: ' || public.admin_flag_user(${U("8a72")}, 'scam', 'Sold a stolen film', null); ${owner}
    ${TRY("bogus", `insert into public.user_flags (user_id, kind, reason) values (current_setting('t.client')::uuid, 'bogus', 'x')`)}`);
  vuln(pick(r, "admin flag") !== "ok" || !pick(r, "bogus").startsWith("refused"),
    `C3 an admin flags someone as a scam -> ${pick(r, "admin flag")}; a made-up kind of flag -> ${said(pick(r, "bogus")).slice(0, 60)} (normal: the known kinds work, others are refused)`);
}
{ // C4 Orders charged back before v49, and running it (twice: the SQL editor may be run again)
  const f = path.join(root, "supabase/schema_v49.sql");
  if (!fs.existsSync(f)) vuln(true, "C4 supabase/schema_v49.sql is missing, so the live database still refuses every chargeback flag");
  else {
    const r = tx(`\\i ${f}
\\i ${f}
      select 'flags now: ' || coalesce((select string_agg(kind || ' on ' || coalesce(contract_id::text, '-'), ',') from public.user_flags where user_id = ${U("8a71")}), 'none');
      ${FLAG} ${FLAGS}`);
    const rows = r.out.split("\n").filter(l => /^v49 /.test(l));
    vuln(!r.ok || rows.length !== 2 || !rows.every(l => /^v49 applied/.test(l)) || !/flagged now: [1-9]\d*\b/.test(rows[0] || "") || !/flagged now: 0\b/.test(rows[1] || "")
         || pick(r, "flags now") !== `chargeback on ${O.replace(/'/g, "")}` || pick(r, "flag") !== "saved",
      `C4 an Order charged back before v49 (its flag was refused), then v49 runs twice -> ${r.ok ? rows.map(l => `"${l}"`).join(" then ") || "no result row" : "error: " + r.err.split("\n").find(x => /ERROR/.test(x))}; the client's flags: ${pick(r, "flags now")}`);
  }
}
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
