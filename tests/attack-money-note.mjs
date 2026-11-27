// Check of 27 November 2026: an Order's money note (contracts.money_error) is for the payment code and the admin.
// It names Stripe's ids ("chargeback dp_… also open on payment pi_…", "the client's bank asked about payment pi_…"), what
// went wrong at Stripe, and Cuvori's own steps. Both people on the Order could read it whole: the Order's row and the
// Order screen's data (order_bundle) gave every column to its client and its freelancer, so a freelancer could read that
// the client's bank had asked about the payment, with the payment's Stripe id. The page needs only what the note means
// for them (oNoteKind in index.html: the freelancer's Stripe setup to finish, money still settling, or something Cuvori
// checks). Now (schema v56) the two people read every column of their Order but the note, the Order screen's data and the
// Orders list (my_orders) give them only that meaning (money_note), and the admin still reads the whole note.
// M1 the note can't be read from the table (the column, or every column at once) by either person; M2 every other column
// is readable (the page and the database's own rules read them); M3 the Order screen's data; M4 the Orders list; M5 the
// meaning is the page's own (oNoteKind) for every kind of note; M6 the rules on the Order's parts, history and payment lines
// still let both people read them; M7 a stranger and the public role read nothing; M8 undoing v56 gives the page its table
// back. Every check is rolled back.
// Run: node tests/attack-money-note.mjs   (needs the local Postgres of tests/db; it is started here)
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = process.env.TARGET ? path.resolve(process.env.TARGET) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");   // the copy under test (TARGET), else this one
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
// 961 the client, 962 the freelancer, 963 a stranger, 964 an admin; one protected Order whose note names Stripe ids
const CV = "'1a960000-0000-0000-0000-000000000001'", CV2 = "'1a960000-0000-0000-0000-000000000002'", O = "'3a960000-0000-0000-0000-000000000001'";
const NOTE = "chargeback dp_1SecretDispute also open on payment pi_3SecretPayment · Also: the client's bank asked about payment pi_3SecretPayment (an inquiry)";
const q = (s) => "'" + s.replace(/'/g, "''") + "'";
const SETUP = `
  insert into auth.users (id, email, raw_user_meta_data) values (${U("961")}, 'ann961@t.com', '{"first_name":"Ann"}'), (${U("962")}, 'bob962@t.com', '{"first_name":"Bob"}'),
    (${U("963")}, 'cid963@t.com', '{"first_name":"Cid"}'), (${U("964")}, 'dee964@t.com', '{"first_name":"Dee"}');
  update public.profiles set role = 'editor' where id = ${U("962")};
  update public.profiles set is_admin = true where id = ${U("964")};
  insert into public.conversations (id, user_a, user_b) values (${CV}, ${U("961")}, ${U("962")});
  insert into public.conversations (id, user_a, user_b) values (${CV2}, ${U("961")}, ${U("963")});
  insert into public.contracts (id, conversation_id, editor, client, proposed_by, title, price, status, payment_mode, amount_cents, accepted_at)
    values (${O}, ${CV}, ${U("962")}, ${U("961")}, ${U("962")}, 'Protected', 100, 'accepted', 'direct', 10000, now());
  set local session_replication_role = replica;
  update public.contracts set status = 'funded', payment_mode = 'escrow', funded_cents = 10000, money_error = ${q(NOTE)}, money_error_at = now() where id = ${O};
  set local session_replication_role = origin;
`;
const lines = (r) => r.out.split("\n");
const pick = (r, label) => { const l = lines(r).find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + ((r.err.split("\n").find(x => /ERROR/.test(x)) || r.err).replace(/^.*ERROR:\s*/, "").slice(0, 120))); };
const tx = (body) => run(`begin;\n${SETUP}\n${body}\nrollback;\n`);
{ const r = tx("select 'setup: ok';"); if (pick(r, "setup") !== "ok") { console.log("the test's set-up failed: " + r.err); process.exit(1); } }
const leaks = (s) => /SecretDispute|SecretPayment|asked about payment|chargeback dp_/.test(s || "");

// ---------- M1 the note itself, from the table ----------
for (const [who, name] of [["961", "the client"], ["962", "the freelancer"]]) {
  const col = tx(`${as(who)} select 'note: ' || coalesce(money_error, '(empty)') from public.contracts where id = ${O};`);
  const all = tx(`${as(who)} select 'all: ' || to_jsonb(c)::text from public.contracts c where id = ${O};`);
  vuln(!/permission denied/.test(pick(col, "note")) || !/permission denied/.test(pick(all, "all")) || leaks(col.out) || leaks(all.out),
    `M1 ${name} reads the Order's money note from the table -> the column: ${pick(col, "note").slice(0, 90)}; every column at once (select *): ${pick(all, "all").slice(0, 90)} (must be refused)`);
}

// ---------- M2 every other column ----------
{
  const r = tx(`select 'unreadable: ' || coalesce(string_agg(column_name, ',' order by ordinal_position), '') from information_schema.columns
                 where table_schema = 'public' and table_name = 'contracts' and column_name <> 'money_error' and not has_column_privilege('authenticated', 'public.contracts', column_name, 'select');
                select 'columns: ' || count(*) from information_schema.columns where table_schema = 'public' and table_name = 'contracts';
                ${as("961")} select 'row: ' || status || ' ' || coalesce(funded_cents, 0) || ' ' || (money_error_at is not null) from public.contracts where id = ${O};
                select 'page after paying: ' || status || ' ' || funded_cents || ' ' || amount_cents from public.contracts where id = ${O};`);
  vuln(pick(r, "unreadable") !== "" || pick(r, "row") !== "funded 10000 true" || pick(r, "page after paying") !== "funded 10000 10000",
    `M2 every other column of the Order (${pick(r, "columns")} in all) is readable by its people -> not readable: "${pick(r, "unreadable")}"; the client reads the row: ${pick(r, "row")}; the page's read after paying (status, funded_cents, amount_cents): ${pick(r, "page after paying")}`);
}

// ---------- M3 the Order screen's data ----------
for (const [who, name, admin] of [["961", "the client", false], ["962", "the freelancer", false], ["964", "an admin", true]]) {
  const r = tx(`${as(who)} select 'has note: ' || ((public.order_bundle(${O})->'order') ? 'money_error'); select 'meaning: ' || coalesce(public.order_bundle(${O})->'order'->>'money_note', '(none)');
                select 'text: ' || (public.order_bundle(${O}))::text;`);
  const text = pick(r, "text");
  vuln(admin ? pick(r, "has note") !== "true" || !text.includes("SecretDispute") : pick(r, "has note") !== "false" || pick(r, "meaning") !== "other" || leaks(text),
    `M3 the Order screen's data for ${name} -> has the note: ${pick(r, "has note")}; its meaning: ${pick(r, "meaning")}; Stripe's ids in it: ${/Secret/.test(text)} (${admin ? "the admin reads the whole note" : "only its meaning, \"other\": something Cuvori checks"})`);
}

// ---------- M4 the Orders list ----------
{
  const r = tx(`${as("961")} select 'client: ' || jsonb_array_length(public.my_orders()) || ' ' || coalesce(public.my_orders()->0->>'money_note', '(none)') || ' ' || ((public.my_orders()->0) ? 'money_error') || ' ' || (public.my_orders()->0->>'status');
                select 'in the chat: ' || jsonb_array_length(public.my_orders(${CV})) || ', in another chat: ' || jsonb_array_length(public.my_orders(${CV2}));
                select 'client text: ' || public.my_orders()::text;
                ${owner} ${as("962")} select 'freelancer: ' || jsonb_array_length(public.my_orders()) || ' ' || coalesce(public.my_orders()->0->>'money_note', '(none)') || ' ' || ((public.my_orders()->0) ? 'money_error');
                ${owner} ${as("963")} select 'stranger: ' || jsonb_array_length(public.my_orders());
                ${owner} ${as("964")} select 'admin: ' || coalesce(public.my_orders()->0->>'money_error', '(none)');`);
  vuln(pick(r, "client") !== "1 other false funded" || pick(r, "in the chat") !== "1, in another chat: 0" || leaks(pick(r, "client text")) || pick(r, "freelancer") !== "1 other false" || pick(r, "stranger") !== "0" || pick(r, "admin") !== NOTE,
    `M4 the Orders list (my_orders) -> client: ${pick(r, "client")}; ${pick(r, "in the chat")}; freelancer: ${pick(r, "freelancer")}; a stranger: ${pick(r, "stranger")}; the admin's note: ${pick(r, "admin").slice(0, 40)}… (each person their Orders with only the note's meaning; the admin the whole note)`);
}

// ---------- M5 the meaning is the page's own ----------
{
  const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
  const a = html.indexOf("const O_NOTE_NOT_READY="), b = html.indexOf("function oEventLine", a);
  const oNoteKind = a < 0 || b < 0 ? null : new Function(html.slice(a, b) + "\nreturn oNoteKind;")();
  const lib = fs.readFileSync(path.join(root, "netlify/lib/cuvori.mjs"), "utf8");
  const sentence = (name) => { const m = new RegExp(`const ${name} = "([^"]+)"`).exec(lib); return m ? m[1] : null; };
  const SETTLING = sentence("SETTLING"), REFUND_SETTLING = sentence("REFUND_SETTLING");
  const NOT_READY = sentence("NOT_READY") && "Money step stopped (automatic payout): " + sentence("NOT_READY");
  const notes = [null, "", " ", " · Also: ", NOTE, SETTLING, REFUND_SETTLING, NOT_READY, `${SETTLING} · Also: ${REFUND_SETTLING}`, `${SETTLING} · Also: ${NOT_READY}`, `${NOTE} · Also: ${SETTLING}`,
    `${SETTLING} · Also: `, "Stripe check failed: card_declined", "chargeback won: re-payment owed", "x · Also: y · Also: z", "balance still settling", "50% off · Also: _ %"].filter(n => n !== undefined);
  const sql = notes.map((n, i) => `select 'k${i}: ' || public.money_note_kind(${n == null ? "null" : q(n)});`).join("\n");
  const r = tx(sql);
  const wrong = notes.map((n, i) => ({ n, page: oNoteKind ? oNoteKind(n) : "(no oNoteKind)", db: pick(r, "k" + i) })).filter(x => x.page !== x.db);
  vuln(!oNoteKind || !SETTLING || !REFUND_SETTLING || !NOT_READY || wrong.length > 0,
    `M5 the database's meaning of a note is the page's own (oNoteKind), for ${notes.length} notes (the server's sentences, joined ones, empty ones) -> different: ${wrong.length}${wrong.length ? " e.g. " + JSON.stringify(wrong.slice(0, 2)) : ""}`);
}

// ---------- M6 the Order's parts, history and payment lines ----------
{
  const r = tx(`insert into public.order_events (order_id, actor, event, data) values (${O}, null, 'funded', '{}');
                ${as("961")} select 'client: ' || (select count(*) from public.order_events where order_id = ${O}) || ' ' || (select count(*) from public.order_milestones where order_id = ${O}) || ' ' || (select count(*) from public.order_payments where order_id = ${O});
                ${owner} ${as("962")} select 'freelancer: ' || (select count(*) from public.order_events where order_id = ${O});`);
  vuln(pick(r, "client") !== "1 0 0" || pick(r, "freelancer") !== "1", `M6 the rules on the Order's history, parts and payment lines (they read the Order's people) -> client: ${pick(r, "client")}; freelancer: ${pick(r, "freelancer")} (must read its history line, no error)`);
}

// ---------- M7 a stranger and the public role ----------
{
  const s = tx(`${as("963")} select 'stranger: ' || count(*) from public.contracts where id = ${O}; select 'bundle: ' || coalesce(public.order_bundle(${O})::text, '(none)');`);
  const a = tx(`${as("anon")} select 'anon: ' || count(*) from public.contracts;`);
  vuln(pick(s, "stranger") !== "0" || pick(s, "bundle") !== "(none)" || !(pick(a, "anon") === "0" || /permission denied/.test(pick(a, "anon"))),
    `M7 someone not on the Order -> rows: ${pick(s, "stranger")}, the Order screen's data: ${pick(s, "bundle")}; the public role: ${pick(a, "anon")} (nothing)`);
}

// ---------- M8 undoing v56 ----------
{
  const UNDO = path.join(root, "supabase/undo_v56.sql");
  const r = fs.existsSync(UNDO) ? run(`begin;\n${SETUP}\n\\i ${UNDO}\n${as("961")} select 'undone: ' || count(*) from (select * from public.contracts where id = ${O}) x; select 'list: ' || (to_regprocedure('public.my_orders(uuid)') is null);\nrollback;\n`) : { ok: false, out: "", err: "no undo file" };
  vuln(pick(r, "undone") !== "1" || pick(r, "list") !== "true", `M8 undo_v56.sql -> the client reads the Order with select * again: ${pick(r, "undone")}; my_orders gone (the page reads the table again): ${pick(r, "list")}`);
}

console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
