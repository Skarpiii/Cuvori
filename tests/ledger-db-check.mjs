// The ledger of the new prices (plan 2) checked by the real database: the money rows a payment test ends with in the fake
// database (tests/fn-harness.mjs: DB.contracts, DB.order_payments, DB.order_milestones, DB.order_events, DB.money_keys)
// are written into a fresh local Postgres built exactly as tests/attack-pricing.mjs builds it (schema v4 ... v55, the
// test seed, then v56), and the database says what the live one would: which ledger lines it refuses (and why), and what
// its ledger check (admin_pricing_check) lists for the Orders.
//
//   import { checkLedgerInDb } from "./ledger-db-check.mjs";
//   const r = await checkLedgerInDb({ contracts: DB.contracts, order_payments: DB.order_payments,
//                                     order_milestones: DB.order_milestones, order_events: DB.order_events, money_keys: DB.money_keys });
//   r.refused    every row the database refused: { table, id, order_id, kind, entry_key, provider_ref, amount_cents, error, code, hint, ... }
//   r.problems   admin_pricing_check()->'problems' for the snapshot's Orders (should be [])
//   r.to_decide  admin_pricing_check()->'to_decide' for the snapshot's Orders
//   r.summaries  { <Order id>: order_money_summary(<Order id>) }
//   r.counters   { <Order id>: the Order's funded/released/refunded/commission cents as the database ends up }
//   r.notes      what was not taken as it was in the snapshot (and why), and commission totals that differ from the lines
//
// How the rows are written:
//   * the people of every Order (client, freelancer, whoever proposed it) are made as the seed makes them (auth.users,
//     then their profile; the freelancer with an editor profile), and one conversation per pair of people;
//   * the Orders are written in the state the snapshot ends in, with the Orders' own triggers switched off for that one
//     insert (they guard how an Order gets there, step by step, and stamp the prices in force: the snapshot is the end of
//     those steps). Their CHECK constraints and foreign keys still apply. The prices are the snapshot's (an Order without a
//     plan gets opts.pricingVersion, 2 by default; a missing commission rate or review days what the plan stamps), and the
//     commission total starts at 0: the database adds it up from the payout lines it takes, it is never copied. The
//     triggers are switched on again before anything else is written;
//   * parts (order_milestones) as they are, then, as the payment functions (role service_role, with the header the new
//     payment code sends, {"x-cuvori-pricing": "2"}): the Order events, the money keys, and every ledger line in created_at
//     order, one at a time, each judged by every trigger, check and unique index exactly as live. A refused row is
//     recorded with its error and the next one is written, as the next request would be.
//   * A row with a column the real table doesn't have is refused as PostgREST refuses the whole request (the id and
//     created_at the fake adds to every row are dropped where the table has no such column). An Order or a part with such a
//     column (made by the test, not by the payment code) is written without it, with a note.
// The scratch database is dropped afterwards (opts.keep: true keeps it and returns its name). The database it is copied
// from (cuvori_ledger_tpl_<fingerprint>) is built once and kept for the next run; it is built again as soon as one of the
// files it is built from changes. dropLedgerDatabases() removes it (and any scratch database left behind).
//
// opts: pricingVersion  the plan of an Order whose snapshot names none (2; null: an Order from before v56)
//       header          the request headers the payment functions send ({"x-cuvori-pricing": "2"}; null: none, as today's code)
//       order           "snapshot": the ledger lines in the snapshot's own order instead of by created_at
//       keep            keep the scratch database (its name is returned as r.database)
//       fresh           build the database copied from again, even if its files did not change
//       v56             another schema_v56.sql to build with (for example the one before a change)
//
// Run on its own: node tests/ledger-db-check.mjs snapshot.json   (or - to read it from stdin): prints the result as JSON,
// exit code 0 when nothing was refused and nothing is listed, 1 otherwise.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PGDIR = process.env.PGDIR || "/tmp/cuvori-pgtest";
const CONN = ["-h", PGDIR, "-p", "5499", "-U", "postgres"];
const env = { ...process.env, PGOPTIONS: "-c client_min_messages=warning" };
const BUILD = "ledger-db-check 1";            // part of the fingerprint: a change in how the copy is built builds it again
const TABLES = ["contracts", "order_milestones", "order_events", "money_keys", "order_payments"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const psql = (db, input, extra = []) => {
  const r = spawnSync("psql", [...CONN, "-d", db, "-At", "-v", "ON_ERROR_STOP=1", ...extra], { input, encoding: "utf8", env, maxBuffer: 1 << 28 });
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
};
const firstError = (r) => (r.err.split("\n").find(l => /ERROR/.test(l)) || r.err.split("\n")[0] || "").replace(/^.*ERROR:\s*/, "");
// CREATE/DROP DATABASE can't run while another session is still on the database it names: tried again for a moment
const admin = (sql) => { let r; for (let i = 0; i < 25; i++) { r = psql("postgres", sql); if (r.ok || !/being accessed by other users/.test(r.err)) return r; spawnSync("sleep", ["0.2"]); } return r; };

// the files, in the order tests/attack-pricing.mjs loads them: tests/db/load.sh's base files and run-all.sh's EXTRA
// without v56, the harness and the seed, run-all.sh's MIGRATE, then v56 (in one transaction, as the SQL editor runs it)
function buildFiles(v56) {
  const runAll = fs.readFileSync(path.join(root, "tests/run-all.sh"), "utf8");
  const extra = ((runAll.match(/EXTRA="([^"]+)"/) || [])[1] || "").split(/\s+/).filter(f => f && f !== "schema_v56.sql");
  const migrate = ((runAll.match(/MIGRATE="([^"]+)"/) || [])[1] || "").split(/\s+/).filter(Boolean);
  const base = ["schema.sql", "schema_v2.sql", "schema_v3.sql", "schema_v4.sql", "schema_v5.sql", "schema_v6.sql", "schema_v7.sql", "schema_v8.sql", ...extra]
    .map(f => path.join(root, "supabase", f)).filter(f => fs.existsSync(f));        // as load.sh: a file that isn't there is skipped
  return { stub: path.join(root, "tests/db/00_supabase_stub.sql"), base, after: [path.join(root, "tests/db/10_harness.sql"), path.join(root, "tests/db/20_seed.sql"), ...migrate.map(m => path.join(root, "supabase", m))],
           v56: v56 ? path.resolve(v56) : path.join(root, "supabase/schema_v56.sql") };
}

let ready = null;   // { name, fingerprint, columns, plans } of the database each check is copied from
let started = false;
function ensureTemplate(opts = {}) {
  if (!started) {     // the test kit's database files (as tests/run-all.sh unpacks them) and the local Postgres, once
    spawnSync("tar", ["--skip-old-files", "-xzf", "tests/test-kit.tar.gz"], { cwd: root });
    execFileSync("bash", [path.join(root, "tests/db/start-pg.sh")], { stdio: "ignore" });
    started = true;
  }
  const files = buildFiles(opts.v56);
  const all = [files.stub, ...files.base, ...files.after, files.v56];
  const missing = all.filter(f => !fs.existsSync(f));
  if (missing.length) throw new Error("ledger-db-check: missing " + missing.map(f => path.relative(root, f)).join(", "));
  const h = crypto.createHash("md5").update(BUILD);
  for (const f of all) h.update("\0" + path.relative(root, f) + "\0").update(fs.readFileSync(f));
  const fingerprint = h.digest("hex"), name = "cuvori_ledger_tpl_" + fingerprint.slice(0, 12);
  if (ready && ready.name === name && !opts.fresh) return ready;
  const have = psql("postgres", `select 'tpl: ' || coalesce(shobj_description(oid, 'pg_database'), '') from pg_database where datname = '${name}';`);
  if (opts.fresh || !have.out.includes("tpl: " + BUILD + " " + fingerprint)) {
    const tmp = `cuvori_ledger_build_${fingerprint.slice(0, 12)}_${process.pid}`;
    const step = (what, r) => { if (!r.ok) { admin(`drop database if exists ${tmp};`); throw new Error(`ledger-db-check: building the database failed at ${what}: ${firstError(r)}`); } return r; };
    step("create", admin(`drop database if exists ${tmp};\ncreate database ${tmp};`));
    // tests/db/load.sh: the Supabase look-alike (its roles are the cluster's, so made only once), then each schema file
    step("roles", psql(tmp, `do $r$ begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin bypassrls; end if; end $r$;`));
    step("00_supabase_stub.sql", psql(tmp, fs.readFileSync(files.stub, "utf8").split("\n").filter(l => !/^create role/.test(l)).join("\n"), ["-q"]));
    for (const f of [...files.base, ...files.after]) step(path.basename(f), psql(tmp, "", ["-q", "-f", f]));
    const v = step(path.basename(files.v56), psql(tmp, `begin;\n\\i ${files.v56}\ncommit;`));
    if (!/v56 applied/.test(v.out)) { admin(`drop database if exists ${tmp};`); throw new Error("ledger-db-check: v56 did not say it was applied: " + v.out.split("\n").pop()); }
    step("comment", psql(tmp, `comment on database ${tmp} is '${BUILD} ${fingerprint}';`));
    // the new copy replaces any older one (of earlier files), never one being copied right now
    const old = psql("postgres", "select datname from pg_database where datname like 'cuvori\\_ledger\\_tpl\\_%';").out.split("\n").filter(Boolean);
    for (const o of old) admin(`drop database if exists ${o};`);
    step("rename", admin(`alter database ${tmp} rename to ${name};`));
  }
  const info = psql(name, `select 'cols: ' || json_object_agg(table_name, cols)::text from (select table_name, json_object_agg(column_name, data_type) as cols
      from information_schema.columns where table_schema = 'public' and table_name in (${TABLES.map(t => `'${t}'`).join(", ")}) group by table_name) x;
    select 'plans: ' || json_object_agg(version, json_build_object('commission_bps', commission_bps, 'review_days', review_days))::text from public.pricing_plans;`);
  if (!info.ok) throw new Error("ledger-db-check: reading the database failed: " + firstError(info));
  const val = (label) => JSON.parse((info.out.split("\n").find(l => l.startsWith(label + ": ")) || "").slice(label.length + 2) || "null");
  ready = { name, fingerprint, columns: val("cols"), plans: val("plans") };
  return ready;
}

// a value as JSON the database can read: Dates as ISO text, undefined left out
const plain = (o) => JSON.parse(JSON.stringify(o ?? null));

function prepare(snapshot, t, opts) {
  const notes = [], refused = [], cols = t.columns;
  const unknown = (table, row) => Object.keys(row).filter(k => !(k in cols[table]));
  const meta = (table, row, i) => ({ table, index: i, id: row.id ?? null, order_id: row.order_id ?? null,
    ...(table === "order_payments" ? { kind: row.kind ?? null, entry_key: row.entry_key ?? null, provider_ref: row.provider_ref ?? null, amount_cents: row.amount_cents ?? null, created_at: row.created_at ?? null } : {}),
    ...(table === "order_events" ? { event: row.event ?? null } : {}), ...(table === "money_keys" ? { scope: row.scope ?? null } : {}) });
  // the id and created_at the fake adds to every row it stores: dropped where the real table has no such column (and an
  // event's id always: the database numbers the events)
  const fakeFields = (table, row) => {
    if ("id" in row && !("id" in cols[table])) delete row.id;
    if (table === "order_events") delete row.id;                       // the database numbers the events itself
    if ("created_at" in row && !("created_at" in cols[table])) delete row.created_at;
    return row;
  };
  const rowsOf = (table) => (Array.isArray(snapshot[table]) ? snapshot[table] : []).map((r, i) => ({ i, row: fakeFields(table, { ...plain(r) }) }));

  // ---- the Orders
  const contracts = [], people = new Map(), pairs = new Map(), usedConv = new Set(), commissionInSnapshot = {};
  const person = (id, editor, src) => { if (typeof id !== "string" || !UUID.test(id)) return; const p = people.get(id) || { id, email: `${id}@ledger.test`, first_name: "", editor: false };
    const prof = (Array.isArray(snapshot.profiles) ? snapshot.profiles : []).find(x => x && x.id === id) || {};
    p.first_name = p.first_name || String(prof.first_name || src || "").slice(0, 80); p.editor = p.editor || editor || prof.role === "editor"; people.set(id, p); };
  for (const { i, row } of rowsOf("contracts")) {
    const extra = unknown("contracts", row);
    if (extra.length) { notes.push({ table: "contracts", id: row.id ?? null, note: "columns the table doesn't have, left out: " + extra.join(", ") }); for (const k of extra) delete row[k]; }
    for (const k of ["job_id", "service_id", "profession_slug"]) if (row[k] != null) { notes.push({ table: "contracts", id: row.id ?? null, note: `${k} left out (it names a ${k.replace(/_id$|_slug$/, "")} that is not in this database)` }); delete row[k]; }
    // the prices: the snapshot's; what is missing is what the plan stamps
    const pv = row.pricing_version === undefined ? (opts.pricingVersion === undefined ? 2 : opts.pricingVersion) : row.pricing_version;
    row.pricing_version = pv;
    if (pv == null) { row.commission_bps = null; row.commission_cents = null; }
    else {
      const plan = t.plans[String(pv)];
      const stamp = plan ? ((row.payment_mode ?? "direct") === "escrow" ? plan.commission_bps : 0) : null;
      if (row.commission_bps == null) row.commission_bps = stamp;
      else if (plan && row.commission_bps !== stamp) notes.push({ table: "contracts", id: row.id ?? null, note: `commission_bps ${row.commission_bps}: plan ${pv} stamps ${stamp} on this Order (kept as in the snapshot)` });
      if (pv >= 2 && plan) { if (row.auto_days == null) row.auto_days = plan.review_days; else if (row.auto_days !== plan.review_days) notes.push({ table: "contracts", id: row.id ?? null, note: `auto_days ${row.auto_days}: plan ${pv} stamps ${plan.review_days} (kept as in the snapshot)` }); }
      if (row.commission_cents != null) commissionInSnapshot[row.id] = row.commission_cents;
      row.commission_cents = 0;                                            // the database adds it up from the payout lines it takes
    }
    person(row.client, false, "Client"); person(row.editor, true, "Freelancer"); person(row.proposed_by, false, "");
    if (UUID.test(String(row.client)) && UUID.test(String(row.editor)) && row.client !== row.editor) {
      const pair = [row.client, row.editor].sort().join("/");
      if (!pairs.has(pair)) { const id = UUID.test(String(row.conversation_id)) && !usedConv.has(row.conversation_id) ? row.conversation_id : crypto.randomUUID(); usedConv.add(id); pairs.set(pair, { id, a: row.client, b: row.editor }); }
      row.conversation_id = pairs.get(pair).id;
    }
    contracts.push({ row, meta: meta("contracts", row, i) });
  }
  const milestones = [];
  for (const { i, row } of rowsOf("order_milestones")) {
    const extra = unknown("order_milestones", row);
    if (extra.length) { notes.push({ table: "order_milestones", id: row.id ?? null, note: "columns the table doesn't have, left out: " + extra.join(", ") }); for (const k of extra) delete row[k]; }
    milestones.push({ row, meta: meta("order_milestones", row, i) });
  }
  // ---- what the payment functions write: a column the table doesn't have makes PostgREST refuse the whole request
  const written = (table) => {
    const out = [];
    for (const { i, row } of rowsOf(table)) {
      const extra = unknown(table, row);
      if (extra.length) refused.push({ ...meta(table, row, i), error: `column ${extra.map(k => `"${k}"`).join(", ")} of ${table} doesn't exist (PostgREST refuses the whole request, PGRST204)`, code: "PGRST204" });
      else out.push({ row, meta: meta(table, row, i) });
    }
    return out;
  };
  const events = written("order_events"), keys = written("money_keys"), lines = written("order_payments");
  // the ledger lines in the order they were written: by created_at (a line without one: after the others, as written now),
  // the snapshot's own order where two are the same; opts.order "snapshot" keeps the snapshot's order throughout
  const at = (x) => { const v = Date.parse(x.row.created_at); return Number.isFinite(v) ? v : Infinity; };
  if (opts.order !== "snapshot") lines.sort((a, b) => (at(a) - at(b)) || (a.meta.index - b.meta.index));
  return { people: [...people.values()], conversations: [...pairs.values()], contracts, milestones, events, keys, lines, notes, refused, commissionInSnapshot };
}

const dollar = (json) => { let tag; do tag = "$j" + crypto.randomBytes(6).toString("hex") + "$"; while (json.includes(tag)); return `${tag}${json}${tag}`; };

// one row after another, each in its own sub-transaction: a refused row is undone on its own, with its error recorded
const tryEach = (arr, table, check = "") => `
  for x in select * from jsonb_array_elements(snap->'${arr}') loop
    begin
      ${check}
      select string_agg(quote_ident(k), ', ' order by k), string_agg('r.' || quote_ident(k), ', ' order by k) into cols, vals from jsonb_object_keys(x->'row') k;
      execute format('insert into public.${table} (%s) select %s from jsonb_populate_record(null::public.${table}, $1) r', cols, vals) using x->'row';
      written := jsonb_set(written, '{${table}}', to_jsonb(coalesce((written->>'${table}')::int, 0) + 1));
    exception when others then
      get stacked diagnostics m = message_text, st = returned_sqlstate, h = pg_exception_hint, d = pg_exception_detail, cn = constraint_name;
      refused := refused || jsonb_build_array(x->'meta' || jsonb_strip_nulls(jsonb_build_object('error', m, 'code', st, 'hint', nullif(h, ''), 'detail', nullif(d, ''), 'constraint', nullif(cn, ''))));
    end;
  end loop;`;

export async function checkLedgerInDb(snapshot = {}, opts = {}) {
  const t = ensureTemplate(opts);
  const prep = prepare(snapshot || {}, t, opts);
  const header = opts.header === undefined ? { "x-cuvori-pricing": "2" } : opts.header;
  const db = `cuvori_ledger_${process.pid}_${Date.now().toString(36)}${crypto.randomBytes(2).toString("hex")}`;
  const made = admin(`create database ${db} template ${t.name};`);
  if (!made.ok) throw new Error("ledger-db-check: could not make the scratch database: " + firstError(made));
  try {
    const pack = (a) => a.map(x => ({ row: x.row, meta: x.meta }));
    const payload = { people: prep.people, conversations: prep.conversations, contracts: pack(prep.contracts), milestones: pack(prep.milestones),
                      events: pack(prep.events), keys: pack(prep.keys), lines: pack(prep.lines) };
    const ids = prep.contracts.map(c => String(c.row.id)).filter(id => UUID.test(id)).map(id => id.toLowerCase());
    const sql = `
create temp table ledger_out (k text primary key, v jsonb);
do $ledger$
declare
  snap jsonb := ${dollar(JSON.stringify(payload))}::jsonb;
  x jsonb; cols text; vals text; m text; st text; h text; d text; cn text;
  refused jsonb := '[]'::jsonb; written jsonb := '{}'::jsonb;
begin
  -- the people of the Orders, as the seed makes them, and one conversation for each pair
  for x in select * from jsonb_array_elements(snap->'people') loop
    insert into auth.users (id, email, raw_user_meta_data) values ((x->>'id')::uuid, x->>'email', jsonb_build_object('first_name', x->>'first_name')) on conflict (id) do nothing;
    if (x->>'editor')::boolean then
      update public.profiles set role = 'editor' where id = (x->>'id')::uuid and role <> 'editor';
      insert into public.editor_profiles (id, display_name) values ((x->>'id')::uuid, coalesce(nullif(x->>'first_name', ''), 'Freelancer')) on conflict (id) do nothing;
    end if;
  end loop;
  for x in select * from jsonb_array_elements(snap->'conversations') loop
    insert into public.conversations (id, user_a, user_b) values ((x->>'id')::uuid, least((x->>'a')::uuid, (x->>'b')::uuid), greatest((x->>'a')::uuid, (x->>'b')::uuid));
  end loop;
  -- the Orders in the state the snapshot ends in: their own triggers off for this insert only (CHECK constraints and
  -- foreign keys still apply), on again before anything else is written
  execute 'alter table public.contracts disable trigger user';
  ${tryEach("contracts", "contracts")}
  execute 'alter table public.contracts enable trigger user';
  ${tryEach("milestones", "order_milestones")}
  -- from here on as the payment functions: Supabase's service key, with the header the new payment code sends
  perform set_config('request.jwt.claim.sub', '', true);
  perform set_config('request.headers', ${header == null ? "''" : dollar(JSON.stringify(header))}, true);
  execute 'set local role service_role';
  ${tryEach("events", "order_events", "if not exists (select 1 from public.contracts where id::text = x->'row'->>'order_id') then raise exception 'order_not_written' using hint = 'its Order was refused or is not in the snapshot'; end if;")}
  ${tryEach("keys", "money_keys")}
  ${tryEach("lines", "order_payments", "if not exists (select 1 from public.contracts where id::text = x->'row'->>'order_id') then raise exception 'order_not_written' using hint = 'its Order was refused or is not in the snapshot'; end if;")}
  execute 'reset role';
  perform set_config('request.headers', '', true);
  insert into ledger_out values ('refused', refused), ('written', written);
end $ledger$;
select 'ledger: ' || jsonb_build_object(
  'refused', (select v from ledger_out where k = 'refused'),
  'written', (select v from ledger_out where k = 'written'),
  'check', public.admin_pricing_check(),
  'summaries', coalesce((select jsonb_object_agg(c.id, public.order_money_summary(c.id)) from public.contracts c where c.id::text = any(${dollar(JSON.stringify(ids).replace(/^\[/, "{").replace(/\]$/, "}"))}::text[])), '{}'::jsonb),
  'counters', coalesce((select jsonb_object_agg(c.id, jsonb_build_object('status', c.status, 'pricing_version', c.pricing_version, 'commission_bps', c.commission_bps,
                 'funded_cents', c.funded_cents, 'released_cents', c.released_cents, 'refunded_cents', c.refunded_cents, 'commission_cents', c.commission_cents))
               from public.contracts c where c.id::text = any(${dollar(JSON.stringify(ids).replace(/^\[/, "{").replace(/\]$/, "}"))}::text[])), '{}'::jsonb))::text;`;
    const r = psql(db, sql);
    if (!r.ok) throw new Error("ledger-db-check: the check itself failed: " + firstError(r));
    const res = JSON.parse((r.out.split("\n").find(l => l.startsWith("ledger: ")) || "ledger: null").slice(8));
    const mine = new Set(ids.map(String));
    const of = (list) => (list || []).filter(x => mine.has(String(x.order)));
    const refused = [...prep.refused, ...(res.refused || [])].sort((a, b) => (TABLES.indexOf(a.table) - TABLES.indexOf(b.table)) || (a.index - b.index));
    const notes = [...prep.notes];
    for (const [id, cents] of Object.entries(prep.commissionInSnapshot)) {
      const c = res.counters[String(id).toLowerCase()], got = c && c.commission_cents;
      // (0 is what an Order starts with in the fake, which adds nothing up: only another number is noted)
      if (got != null && cents !== 0 && got !== cents) notes.push({ table: "contracts", id, note: `commission_cents ${cents} in the snapshot; the database adds up ${got} from the payout lines it took (the payment code can't write it: pricing_counters_from_ledger_only)` });
    }
    return { refused, problems: of(res.check.problems), to_decide: of(res.check.to_decide), summaries: res.summaries, counters: res.counters, notes,
             written: res.written, ...(opts.keep ? { database: db } : {}) };
  } finally {
    if (!opts.keep) admin(`drop database if exists ${db};`);
  }
}

// the database the checks are copied from stays for the next run; this removes it (and any scratch database left behind)
export function dropLedgerDatabases() {
  const all = psql("postgres", "select datname from pg_database where datname like 'cuvori\\_ledger\\_%';").out.split("\n").filter(Boolean);
  for (const d of all) admin(`drop database if exists ${d};`);
  ready = null;
  return all;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const src = process.argv[2];
  if (!src) { console.error("usage: node tests/ledger-db-check.mjs snapshot.json   (or - for stdin)"); process.exit(2); }
  const snap = JSON.parse(src === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(src, "utf8"));
  const r = await checkLedgerInDb(snap);
  console.log(JSON.stringify(r, null, 2));
  console.log(`\n${r.refused.length} refused, ${r.problems.length} problems, ${r.to_decide.length} to decide`);
  process.exit(r.refused.length || r.problems.length ? 1 : 0);
}
