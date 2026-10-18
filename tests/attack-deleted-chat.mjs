// Nothing new is written into a chat with a person who deleted their account (schema v44).
// When one of two people deletes their account, an Order they agreed is kept, and so is its chat (v35): the other person
// keeps seeing the Order and its history. That person could still send messages, progress reports and change requests
// into the chat. Nobody will ever read them, and the page gave no sign of it, so the person left behind could keep
// writing and waiting for an answer that never comes. v41 already refuses a new Order or change there.
// Now a new message, report or change request written by a signed-in person into such a chat is refused ("not_available":
// the page says "This person can't be contacted right now."), and the page can ask which of its chats these are, to say
// so up front. The Order's own history cards and Cuvori's notes on an Order still arrive (the person left behind keeps
// seeing what happens to a kept Order), and the messages already there stay.
// K1–K2 writing after the freelancer / the client deleted the account, K3 Cuvori's own lines still arrive, K4 two people
// still here (normal), K5 which chats the page is told about, K6 running v44. Every check is rolled back.
// Run: node tests/attack-deleted-chat.mjs   (needs the local Postgres of tests/db; it is started here)
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
  : who === "service" ? "set local role service_role; select set_config('request.jwt.claim.sub', '', true);"
  : `set local role authenticated; select set_config('request.jwt.claim.sub', ${U(who)}::text, true);`;
const owner = "reset role; select set_config('request.jwt.claim.sub', '', true);";
// 8b1 the client and 8b2 the freelancer with a finished €100 protected Order in their chat (it is kept when either
// deletes the account), and a message each already in it; 8b3 and 8b4 two people still here, in their own chat
const CV = "'1b300000-0000-0000-0000-000000000001'", CV2 = "'1b300000-0000-0000-0000-000000000002'", DONE = "'3b300000-0000-0000-0000-000000000001'";
const SETUP = `
  insert into auth.users (id, email, raw_user_meta_data) values (${U("8b1")}, 'ada8b1@t.com', '{"first_name":"Ada"}'), (${U("8b2")}, 'ben8b2@t.com', '{"first_name":"Ben"}'),
    (${U("8b3")}, 'cy8b3@t.com', '{"first_name":"Cy"}'), (${U("8b4")}, 'dee8b4@t.com', '{"first_name":"Dee"}');
  update public.profiles set role = 'editor' where id in (${U("8b2")}, ${U("8b4")});
  insert into public.conversations (id, user_a, user_b) values (${CV}, ${U("8b1")}, ${U("8b2")}), (${CV2}, ${U("8b3")}, ${U("8b4")});
  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, funded_cents, released_cents, accepted_at, funded_at, completed_at, stripe_payment_intent)
    values (${DONE}, ${CV}, ${U("8b2")}, ${U("8b1")}, ${U("8b2")}, 'Wedding film', 100, 'completed', 'escrow', 10000, 10000, 10000, now() - interval '9 days', now() - interval '9 days', now() - interval '1 day', 'pi_chat8b1');
  insert into public.order_payments (order_id, kind, amount_cents, provider_ref) values (${DONE}, 'fund', 10000, 'pi_chat8b1'), (${DONE}, 'release', 10000, 'tr_chat8b1');
  insert into public.messages (conversation_id, sender, kind, body) values (${CV}, ${U("8b1")}, 'text', 'Thanks for the film!'), (${CV}, ${U("8b2")}, 'text', 'Glad you like it');
`;
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /^(psql:.*)?ERROR/.test(x)) || r.err.split("\n")[0] || "").replace(/^.*ERROR:\s*/, "")); };
const tx = (body) => run(`begin;\n${SETUP}\n${body}\nrollback;\n`);
{ const r = tx("select 'setup: ok';"); if (pick(r, "setup") !== "ok") { console.log("the test's set-up failed: " + r.err); process.exit(1); } }
// a write that may be refused: the answer (or the refusal) is kept, and the checks after it still run
const TRY = (label, sql) => `do $$ begin ${sql}; perform set_config('t.${label}', 'saved', true); exception when others then perform set_config('t.${label}', 'refused: ' || sqlerrm, true); end $$; select '${label}: ' || current_setting('t.${label}');`;
const SEND = (cv, who, kind, body, payload = null) => `insert into public.messages (conversation_id, sender, kind, body${payload ? ", payload" : ""}) values (${cv}, ${U(who)}, '${kind}', '${body}'${payload ? `, '${payload}'` : ""})`;
const DELETE = (who) => `${as(who)} select 'deleted: ' || public.delete_my_account(); ${owner}`;
const COUNT = (cv) => `select 'messages: ' || count(*) from public.messages where conversation_id = ${cv};`;
const said = (s) => s.startsWith("refused: not_available") ? "refused: not available" : s;
const REPORT = '{"title":"Cut 2","message":"New version","video_url":null,"comments":[],"status":"pending"}';

{ // K1 the freelancer deleted the account; the client writes in their chat (and the same after a delete in Supabase's dashboard)
  const r = tx(`${DELETE("8b2")} ${as("8b1")} ${TRY("call", SEND(CV, "8b1", "text", "Hello, are you there?"))} ${owner} ${COUNT(CV)}
                select 'kept: ' || coalesce(string_agg(body, ' / ' order by created_at), 'none') from public.messages where conversation_id = ${CV};`);
  vuln(pick(r, "deleted") !== "ok" || !pick(r, "call").startsWith("refused: not_available") || pick(r, "messages") !== "1",
    `K1 the freelancer has deleted the account; the client writes "Hello, are you there?" in their old chat -> ${said(pick(r, "call"))}; messages in the chat: ${pick(r, "messages")} (kept: ${pick(r, "kept")}) (must be refused: nobody will ever read it)`);
  const r2 = tx(`delete from auth.users where id = ${U("8b2")}; ${as("8b1")} ${TRY("call", SEND(CV, "8b1", "text", "Hello?"))} ${owner} ${COUNT(CV)}`);
  vuln(!pick(r2, "call").startsWith("refused: not_available") || pick(r2, "messages") !== "1",
    `K1b the freelancer was deleted in Supabase's dashboard; the client writes in their chat -> ${said(pick(r2, "call"))}; messages in the chat: ${pick(r2, "messages")} (must be refused too)`);
}
{ // K2 the client deleted the account; the freelancer sends a progress report and a change request
  const got = [];
  for (const [kind, body, payload] of [["report", "Cut 2", REPORT], ["change_request", "Please check the intro", null], ["text", "Any news?", null]]) {
    const r = tx(`${DELETE("8b1")} ${as("8b2")} ${TRY("call", SEND(CV, "8b2", kind, body, payload))} ${owner} ${COUNT(CV)}`);
    got.push(`${kind}: ${said(pick(r, "call"))} (messages ${pick(r, "messages")})`);
  }
  vuln(!got.every(g => g.includes("refused: not available (messages 1)")),
    `K2 the client has deleted the account; the freelancer sends a progress report, a change request and a message -> ${got.join("; ")} (must all be refused)`);
}
{ // K3 Cuvori's own lines still arrive: an Order history card and a decision note from the payment functions, and an
  // Order history card the database writes
  const r = tx(`${DELETE("8b2")} select set_config('t.ben', ${U("8b2")}::text, true), set_config('t.cy', ${U("8b3")}::text, true); ${as("service")}
                ${TRY("card", `insert into public.messages (conversation_id, sender, kind, body, payload) values (${CV}, current_setting('t.ben')::uuid, 'contract', 'Wedding film', '{"contract_id":"3b300000-0000-0000-0000-000000000001","event":"chargeback"}')`)}
                ${TRY("note", `insert into public.messages (conversation_id, sender, kind, body) values (${CV}, current_setting('t.cy')::uuid, 'text', 'Cuvori decision: refund')`)} ${owner}
                ${TRY("db", `perform public.order_amount_event((select c from public.contracts c where id = ${DONE}), 'chargeback', 10000, null)`)} ${COUNT(CV)}`);
  vuln(pick(r, "card") !== "saved" || pick(r, "note") !== "saved" || pick(r, "db") !== "saved" || pick(r, "messages") !== "4",
    `K3 after the freelancer deleted the account: the payment functions add a chargeback card and a decision note, the database adds a history card -> ${pick(r, "card")}, ${said(pick(r, "note"))}, ${said(pick(r, "db"))}; messages in the chat: ${pick(r, "messages")} (normal: the client keeps seeing what happens to the kept Order)`);
}
{ // K4 two people still here (normal)
  const got = [];
  for (const [who, kind, body, payload] of [["8b3", "text", "Hi Dee", null], ["8b4", "report", "Cut 1", REPORT], ["8b3", "change_request", "Shorter intro", null]]) {
    const r = tx(`${as(who)} ${TRY("call", SEND(CV2, who, kind, body, payload))} ${owner}`);
    got.push(`${kind}: ${said(pick(r, "call"))}`);
  }
  const r = tx(`${DELETE("8b1")} select 'kept: ' || (select status from public.contracts where id = ${DONE}) || ', chat ' || (select count(*) from public.conversations where id = ${CV});`);
  vuln(!got.every(g => g.endsWith(": saved")) || pick(r, "deleted") !== "ok" || pick(r, "kept") !== "completed, chat 1",
    `K4 two people still here send a message, a progress report and a change request -> ${got.join("; ")}; the client then deletes her account -> ${pick(r, "deleted")}, the finished Order and its chat: ${pick(r, "kept")} (normal)`);
}
{ // K5 the page asks which of its chats have a person who deleted their account
  const ask = (who) => `${as(who)} ${TRY(`w${who}`, `perform set_config('t.list', coalesce((select string_agg(x::text, ',') from unnest(public.chats_with_deleted_people()) x), 'none'), true)`)} select 'list${who}: ' || case when current_setting('t.w${who}') = 'saved' then current_setting('t.list') else current_setting('t.w${who}') end; ${owner}`;
  const r = tx(`${DELETE("8b2")} ${ask("8b1")} ${ask("8b3")} ${ask("anon")}`);
  const cv = CV.replace(/'/g, "");
  vuln(pick(r, "list8b1") !== cv, `K5a the client whose freelancer deleted the account asks which of her chats these are -> ${pick(r, "list8b1")} (must be her chat with him, so the page can say so)`);
  vuln(pick(r, "list8b3") !== "none" || !/^(none|refused: permission denied)/.test(pick(r, "listanon")),
    `K5b someone else, and a visitor, ask the same -> ${pick(r, "list8b3")}; ${pick(r, "listanon")} (must be nothing: it is only about your own chats)`);
}
{ // K6 running v44 (twice: the SQL editor may be run again)
  const f = path.join(root, "supabase/schema_v44.sql");
  if (!fs.existsSync(f)) vuln(true, "K6 supabase/schema_v44.sql is missing, so the live database still takes messages into a chat with a person who deleted their account");
  else {
    const r = tx(`\\i ${f}
\\i ${f}
                  ${DELETE("8b2")} ${as("8b1")} ${TRY("call", SEND(CV, "8b1", "text", "Hello?"))} ${owner}`);
    const rows = r.out.split("\n").filter(l => /^v44 /.test(l));
    vuln(!r.ok || rows.length !== 2 || !rows.every(l => /^v44 applied/.test(l)) || !pick(r, "call").startsWith("refused: not_available"),
      `K6 running v44 twice -> ${r.ok ? rows.map(l => `"${l}"`).join(" then ") || "no result row" : "error: " + r.err.split("\n").find(x => /ERROR/.test(x))}; then a message to the deleted freelancer: ${said(pick(r, "call"))}`);
  }
}
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
