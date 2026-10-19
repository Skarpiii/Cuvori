// At most 200 portfolio files per person, however they are sent (schema v47).
// The upload rule on storage.objects counts a person's files and lets a new one in while there are fewer than 200. The
// count is read once per command, before anything is saved, so:
//  - uploads sent at the same moment all see the same old number: at 199 files, two uploads at once both got in (201);
//  - one command that saves many files at once got all of them in (250 at once with 1 file there);
//  - Supabase's file service checks the rule with a test write, then uploads the file, then saves the file's row as its
//    own admin role, which the rule never checks; uploads in flight at the same time are never counted.
// Each file is up to 50 MB, and Cuvori pays for the storage. Now a check on the table itself counts again when the row is
// really saved, one new file at a time per person, and refuses the 201st ("too_many_files"). Replacing a file that is
// already there still works, and other people and other buckets are not affected.
// F1 one command, F2 at the same moment, F3 the file service's own save, F4 what still works (normal), F5 moving files in,
// F6 running v47. Every check is rolled back or cleaned up.
// Run: node tests/attack-portfolio-limit.mjs   (needs the local Postgres of tests/db; it is started here)
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync, execFileSync } from "node:child_process";
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
const runAsync = (sql) => new Promise(res => { const p = spawn("psql", [...PSQL], { env }); let o = "", e = ""; p.stdout.on("data", d => o += d); p.stderr.on("data", d => e += d);
  p.on("close", code => res({ ok: code === 0, out: o.trim(), err: e.trim() })); p.stdin.end(sql); });
const U = (n) => `t.u('${n}')`;
const as = (who) => `set local role authenticated; select set_config('request.jwt.claim.sub', ${U(who)}::text, true);`;
const owner = "reset role; select set_config('request.jwt.claim.sub', '', true);";
// 201 (Eva, seeded) and 8e1 (a second freelancer): their portfolio folders
const SETUP = `
  insert into auth.users (id, email, raw_user_meta_data) values (${U("8e1")}, 'kai8e1@t.com', '{"first_name":"Kai"}');
  update public.profiles set role = 'editor' where id = ${U("8e1")};
`;
const FILL = (who, n, tag = "pre") => `insert into storage.objects (bucket_id, name, owner) select 'portfolio', ${U(who)} || '/${tag}' || i || '.mp4', ${U(who)} from generate_series(1, ${n}) i;`;
const COUNT = (who, label = who) => `select '${label}: ' || count(*) from storage.objects where bucket_id = 'portfolio' and name like ${U(who)} || '/%';`;
const pick = (r, label) => { const l = r.out.split("\n").find(x => x.startsWith(label + ": ")); return l ? l.slice(label.length + 2) : (r.ok ? "(nothing)" : "error: " + (r.err.split("\n").find(x => /^(psql:.*)?ERROR/.test(x)) || r.err.split("\n")[0] || "").replace(/^.*ERROR:\s*/, "")); };
const tx = (body) => run(`begin;\n${SETUP}\n${body}\nrollback;\n`);
{ const r = tx(`select 'setup: ok';`); if (pick(r, "setup") !== "ok") { console.log("the test's set-up failed: " + r.err); process.exit(1); } }
// a write that may be refused: the answer (or the refusal) is kept, and the checks after it still run
const TRY = (label, sql) => `do $$ begin execute ${"$q$" + sql + "$q$"}; perform set_config('t.${label}', 'saved', true); exception when others then perform set_config('t.${label}', 'refused: ' || sqlerrm, true); end $$; select '${label}: ' || current_setting('t.${label}');`;
const said = (s) => s.startsWith("refused: ") ? (/too_many_files/.test(s) ? "refused (too many files)" : /row-level security/.test(s) ? "refused (upload rule)" : s) : s;

{ // F1 one command that saves 250 files at once (Eva has 1)
  const r = tx(`${as("201")} ${TRY("call", `insert into storage.objects (bucket_id, name) select 'portfolio', t.u('201') || '/m' || i || '.mp4' from generate_series(1, 250) i`)} ${owner} ${COUNT("201", "files")}`);
  vuln(!pick(r, "call").startsWith("refused") || Number(pick(r, "files")) > 200,
    `F1 the freelancer saves 250 files in one command, with 1 already there -> ${said(pick(r, "call"))}; files now: ${pick(r, "files")} (must stop at 200)`);
}
{ // F2 two uploads at the same moment, at 199 files (each in its own connection, both kept)
  run(`${FILL("201", 198)}`);
  const A = `begin; ${as("201")} insert into storage.objects (bucket_id, name) values ('portfolio', t.u('201') || '/raceA.mp4'); select pg_sleep(1.5); commit;`;
  const B = `begin; ${as("201")} select pg_sleep(0.4); insert into storage.objects (bucket_id, name) values ('portfolio', t.u('201') || '/raceB.mp4'); commit;`;
  const [ra, rb] = await Promise.all([runAsync(A), runAsync(B)]);
  const r = run(COUNT("201", "files"));
  run(`delete from storage.objects where bucket_id = 'portfolio' and (name like ${U("201")} || '/pre%' or name like ${U("201")} || '/race%');`);
  const left = run(COUNT("201", "files"));
  const got = [ra, rb].map(x => x.ok ? "saved" : said("refused: " + (x.err.split("\n").find(l => /ERROR/.test(l)) || "").replace(/^.*ERROR:\s*/, "")));
  vuln(Number(pick(r, "files")) > 200 || pick(left, "files") !== "1",
    `F2 two uploads sent at the same moment with 199 files there -> ${got.join(", ")}; files now: ${pick(r, "files")} (must be 200 at most; cleaned up to ${pick(left, "files")})`);
}
{ // F3 the file service's own save, after its check (it saves the row as its own admin role, without the upload rule)
  const r = tx(`${FILL("201", 199)} ${TRY("call", `insert into storage.objects (bucket_id, name, owner) values ('portfolio', t.u('201') || '/late.mp4', t.u('201'))`)} ${COUNT("201", "files")}`);
  vuln(!pick(r, "call").startsWith("refused") || pick(r, "files") !== "200",
    `F3 at 200 files, the file service saves one more row as its own role (as when uploads were checked at the same time) -> ${said(pick(r, "call"))}; files now: ${pick(r, "files")} (must be refused)`);
}
{ // F4 what still works (normal)
  const upTo = tx(`${FILL("201", 198)} ${as("201")} ${TRY("call", `insert into storage.objects (bucket_id, name) values ('portfolio', t.u('201') || '/v200.mp4')`)} ${owner} ${COUNT("201", "files")}`);
  const replace = tx(`create unique index t_obj_name on storage.objects (bucket_id, name); ${FILL("201", 199)}
                      ${TRY("call", `insert into storage.objects (bucket_id, name, owner, metadata) values ('portfolio', t.u('201') || '/pre5.mp4', t.u('201'), '{"size":2}') on conflict (bucket_id, name) do update set metadata = excluded.metadata`)} ${COUNT("201", "files")}`);
  const others = tx(`${FILL("201", 199)} ${as("8e1")} ${TRY("kai", `insert into storage.objects (bucket_id, name) values ('portfolio', t.u('8e1') || '/first.mp4')`)} ${owner}
                     ${TRY("bucket", `insert into storage.objects (bucket_id, name) values ('avatars', t.u('201') || '/me.png')`)} ${COUNT("8e1", "kai files")}`);
  vuln(pick(upTo, "call") !== "saved" || pick(upTo, "files") !== "200", `F4a the freelancer uploads her 200th file -> ${said(pick(upTo, "call"))}; files: ${pick(upTo, "files")} (normal: 200 is allowed)`);
  vuln(pick(replace, "call") !== "saved" || pick(replace, "files") !== "200", `F4b at 200 files, a file that is already there is saved again (replaced) -> ${said(pick(replace, "call"))}; files: ${pick(replace, "files")} (normal: replacing adds nothing)`);
  vuln(pick(others, "kai") !== "saved" || pick(others, "bucket") !== "saved" || pick(others, "kai files") !== "1",
    `F4c while she has 200, another freelancer uploads his first file, and a file goes to another bucket -> ${said(pick(others, "kai"))}, ${said(pick(others, "bucket"))} (normal: only her portfolio is full)`);
}
{ // F5 moving a file into the full folder (Supabase's move changes the row's bucket or name)
  const r = tx(`${FILL("201", 199)} insert into storage.objects (bucket_id, name, owner) values ('avatars', t.u('201') || '/big.mp4', t.u('201')), ('portfolio', t.u('8e1') || '/x.mp4', t.u('8e1'));
                ${TRY("in", `update storage.objects set bucket_id = 'portfolio' where bucket_id = 'avatars' and name = t.u('201') || '/big.mp4'`)}
                ${TRY("rename", `update storage.objects set name = t.u('201') || '/pre1-renamed.mp4' where bucket_id = 'portfolio' and name = t.u('201') || '/pre1.mp4'`)} ${COUNT("201", "files")}`);
  vuln(!pick(r, "in").startsWith("refused") || pick(r, "rename") !== "saved" || pick(r, "files") !== "200",
    `F5 at 200 files: a file moved in from another bucket -> ${said(pick(r, "in"))}; one of her own files renamed -> ${said(pick(r, "rename"))}; files: ${pick(r, "files")} (moving in must be refused, renaming is normal)`);
}
{ // F6 running v47 (twice: the SQL editor may be run again)
  const f = path.join(root, "supabase/schema_v47.sql");
  if (!fs.existsSync(f)) vuln(true, "F6 supabase/schema_v47.sql is missing, so the live database still lets uploads sent at the same moment go past 200 files");
  else {
    const r = tx(`\\i ${f}
\\i ${f}
                  ${FILL("201", 199)} ${TRY("call", `insert into storage.objects (bucket_id, name, owner) values ('portfolio', t.u('201') || '/late.mp4', t.u('201'))`)}`);
    const rows = r.out.split("\n").filter(l => /^v47 /.test(l));
    vuln(!r.ok || rows.length !== 2 || !rows.every(l => /^v47 applied/.test(l)) || !said(pick(r, "call")).startsWith("refused (too many files)"),
      `F6 running v47 twice -> ${r.ok ? rows.map(l => `"${l}"`).join(" then ") || "no result row" : "error: " + r.err.split("\n").find(x => /ERROR/.test(x))}; then a 201st file: ${said(pick(r, "call"))}`);
  }
}
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
