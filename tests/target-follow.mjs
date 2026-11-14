// Checks of 20 and 21 November: every test reads and loads the copy of Cuvori it is pointed at.
// The tests can be run against another copy of the repository (TARGET=<folder>): to show a check failing on the code that
// is on GitHub now, or that a deliberate break of the code is caught. A test that finds the repository by itself instead
// (from its own file: new URL("../…", import.meta.url), __dirname, dirname "$0"; or from the folder it was started in:
// process.cwd()) then quietly checks this folder's code, page, database scripts or notes, not the copy's, and passes or
// fails for the wrong copy. 20 November: 36 test files and A23 of attack-functions.mjs did. 21 November: this check had
// looked only at the .mjs files directly in tests/, and took a test that followed ROOT alone as fine: the page tests (.js),
// the shell tests (.sh), the page tests next to index.html, the XSS proofs and the database runner did the same, and
// limits-match.mjs followed ROOT but not TARGET. Every such place must follow TARGET and fall back to this copy only when
// it is not set.
// Run: node tests/target-follow.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = process.env.TARGET ? path.resolve(process.env.TARGET) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");   // the copy under test (TARGET), else this one
const SELF = "tests/target-follow.mjs";

// --- which files are tests: everything in tests/ and its folders (.mjs, .js, .sh), and every file tests/run-all.sh runs
function testFiles(base) {
  const walk = (dir) => fs.readdirSync(path.join(base, dir), { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : /\.(mjs|js|sh)$/.test(e.name) ? [path.join(dir, e.name)] : []);
  const runAll = fs.readFileSync(path.join(base, "tests/run-all.sh"), "utf8");
  const ranByRunAll = [...runAll.matchAll(/(?:^|[\s;(])(?:page|node|bash)\s+([\w./-]+\.(?:m?js|sh))\b/g)].map(m => path.normalize(m[1]));
  return [...new Set([...walk("tests"), ...ranByRunAll])].filter(f => fs.existsSync(path.join(base, f))).sort();
}

// --- how a line finds the repository by itself, and how it follows TARGET
const OWN = /import\.meta\.url|__dirname|dirname\s+"?\$0"?|BASH_SOURCE/;      // from the test's own file
const CWD = /process\.cwd\(\)/;                                               // from the folder it was started in
const FOLLOWS = (l, sh) => sh ? /\$\{?TARGET\b/.test(l) : /process\.env\.TARGET\b/.test(l);
const comment = (l, sh) => sh ? /^\s*#/.test(l) : /^\s*(\/\/|\*|\/\*)/.test(l);
// a line that finds the repository by itself; depth: how many folders the file is below the repository (0: next to index.html)
function finds(lines, depth, sh) {
  const hits = [], tainted = new Set();
  lines.forEach((l, i) => {
    if (comment(l, sh) || FOLLOWS(l, sh)) return;
    const own = OWN.test(l), up = /\.\.[\/"'`]|\.\.$/.test(l);
    // a variable set from the test's own folder without climbing yet, e.g. const here = path.dirname(fileURLToPath(import.meta.url))
    const set = sh ? /^\s*(\w+)=/.exec(l) : /\b(?:const|let|var)\s+(\w+)\s*=/.exec(l);
    if (own && !up && set && depth > 0) { tainted.add(set[1]); return; }
    const usesTainted = [...tainted].some(v => new RegExp(sh ? `\\$\\{?${v}\\b` : `\\b${v}\\b`).test(l));
    if ((own && (up || depth === 0)) || CWD.test(l) || (usesTainted && up) || (sh && up)) hits.push(i + 1);
  });
  return hits;
}
// places that may find their own folder on purpose: each one names why the copy under test is still the one checked
const ALLOWED = [
  { file: "tests/run-all.sh", line: /^cd "\$\(dirname "\$0"\)\/\.\."$/, why: "the full run checks the copy it is in, and refuses to start when TARGET is set (T3)" },
  { file: "tests/xss/run.sh", line: /^cd "\$\(dirname "\$0"\)\/\.\.\/\.\."$/, why: "finds its own proofs; each proof opens the page of the copy under test (tests/xss/kit.js follows TARGET)" },
];
function scan(base) {
  const files = testFiles(base), bad = [], allowedSeen = new Set();
  for (const f of files) {
    const sh = f.endsWith(".sh"), depth = f.split(path.sep).length - 1;
    let lines = fs.readFileSync(path.join(base, f), "utf8").split("\n");
    if (f === SELF) { const a = lines.indexOf("// samples:"), z = lines.indexOf("// end of samples"); lines = lines.map((l, i) => i > a && i < z ? "" : l); }  // its own samples are the old ways on purpose
    for (const n of finds(lines, depth, sh)) {
      const ok = ALLOWED.findIndex(a => a.file === f && a.line.test(lines[n - 1]));
      if (ok >= 0) allowedSeen.add(ok); else bad.push(`${f}:${n}`);
    }
  }
  return { files, bad, allowedSeen };
}
const { files, bad, allowedSeen } = scan(root);
const out = [];
out.push((bad.length ? "VULNERABLE " : "safe       ") + `T1 ${files.length} test files read (${files.filter(f => f.endsWith(".mjs")).length} .mjs, ${files.filter(f => f.endsWith(".js")).length} .js, ${files.filter(f => f.endsWith(".sh")).length} .sh; ${files.filter(f => !f.startsWith("tests" + path.sep)).length} of them next to index.html), ${bad.length} place${bad.length === 1 ? "" : "s"} that find the repository by themselves without following TARGET: ${bad.slice(0, 60).join(", ")}${bad.length > 60 ? ` (+${bad.length - 60})` : ""} (must be: none)`);

// --- the check itself tells the old ways from the ones that follow TARGET
// samples:
const OLD = [
  ["tests/a.mjs", ['const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");']],
  ["tests/a.mjs", ['const h = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");']],
  ["tests/a.mjs", ['const r = (process.env.ROOT || new URL("..", import.meta.url).pathname);']],
  ["tests/a.mjs", ['const here = path.dirname(fileURLToPath(import.meta.url));', 'const page = fs.readFileSync(path.join(here, "..", "index.html"), "utf8");']],
  ["tests/a.js", ["const url = 'file://' + path.resolve(__dirname, '..') + '/index.html';"]],
  ["tests/a.js", ["const url='file://'+process.cwd()+'/index.html';"]],
  ["a.js", ["const mock = fs.readFileSync(__dirname + '/mock-supabase.js', 'utf8');"]],
  ["tests/a.sh", ['cd "$(dirname "$0")/.."']],
  ["tests/db/a.sh", ['for f in $M; do psql -f "../../supabase/$f"; done']],
  ["tests/db/a.sh", ['H="$(cd "$(dirname "$0")" && pwd)"', 'D="$H/../../supabase"']],
];
const NEW = [
  ["tests/a.mjs", ['const s = process.env.TARGET ? path.resolve(process.env.TARGET) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");']],
  ["tests/a.mjs", ['const r = (process.env.ROOT || process.env.TARGET || new URL("..", import.meta.url).pathname);']],
  ["tests/a.mjs", ['const lib = await import(new URL("../lib/cuvori.mjs", "file://" + F).href);']],
  ["tests/a.mjs", ['const SELF = fileURLToPath(import.meta.url);']],
  ["tests/a.js", ["const root = process.env.TARGET ? path.resolve(process.env.TARGET) : process.cwd();"]],
  ["tests/a.js", ["const { open } = require('./kit.js');"]],
  ["a.js", ["const root = process.env.TARGET ? path.resolve(process.env.TARGET) : __dirname;"]],
  ["tests/a.sh", ['cd "${TARGET:-$(dirname "$0")/..}"']],
  ["tests/db/a.sh", ['for f in $M; do psql -f "${TARGET:-../..}/supabase/$f"; done']],
];
// a made-up copy with one old way in each kind of test file (T5)
const KINDS = {
  "tests/a.mjs": 'const page = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");',
  "tests/b.js": "const url = 'file://' + process.cwd() + '/index.html';",
  "tests/deeper/c.js": "const url = 'file://' + path.resolve(__dirname, '../..') + '/index.html';",
  "tests/d.sh": 'cd "$(dirname "$0")/.."',
  "tests/deeper/e.sh": 'for f in $M; do psql -f "../../supabase/$f"; done',
  "pagetest.js": "const page = fs.readFileSync(__dirname + '/index.html', 'utf8');",
};
// end of samples
const flag = ([f, lines]) => finds(lines, f.split("/").length - 1, f.endsWith(".sh")).length > 0;
const oldFlagged = OLD.map(flag), newFlagged = NEW.map(flag);
out.push((oldFlagged.every(Boolean) && !newFlagged.some(Boolean) ? "safe       " : "VULNERABLE ") + `T2 the check itself: the ${OLD.length} old ways are reported (${oldFlagged.filter(Boolean).length} of ${OLD.length}, ROOT alone and a climb over two lines among them), the ${NEW.length} that follow TARGET or stay in tests/ are not (${newFlagged.filter(Boolean).length} reported, must be 0)`);

// --- the places that find their own folder on purpose are still there, and the full run refuses another copy
const missing = ALLOWED.filter((a, i) => fs.existsSync(path.join(root, a.file)) && !allowedSeen.has(i)).map(a => a.file);
// the full run is started from a copy of itself in an empty folder: if it does not stop, its checks find nothing to run there
// and end at once, instead of opening browsers and databases for this copy
const empty = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "cuvori-empty-"));
fs.mkdirSync(path.join(empty, "tests")); fs.copyFileSync(path.join(root, "tests/run-all.sh"), path.join(empty, "tests/run-all.sh"));
const t0 = Date.now();
const ra = spawnSync("timeout", ["-s", "KILL", "60", "bash", path.join(empty, "tests/run-all.sh")], { cwd: empty, env: { ...process.env, TARGET: "/nonexistent-copy" }, encoding: "utf8" });
fs.rmSync(empty, { recursive: true, force: true });
const refused = ra.status === 2 && /TARGET/.test(ra.stdout + ra.stderr) && !/^== /m.test(ra.stdout) && Date.now() - t0 < 20000;
out.push((refused && !missing.length ? "safe       " : "VULNERABLE ") + `T3 the ${ALLOWED.length} places that find their own folder on purpose say why (${missing.length ? "not found any more: " + missing.join(", ") : "all found"}); tests/run-all.sh with TARGET set stops before running anything (exit ${ra.status}${refused ? ", it says so" : ", ran: " + (ra.stdout.match(/^== .*/m) || [""])[0]})`);

// --- end to end: the deploy rule's test, pointed at a copy whose rule is broken, fails
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "cuvori-copy-"));
fs.mkdirSync(path.join(tmp, "tools"));
fs.copyFileSync(path.join(root, "netlify.toml"), path.join(tmp, "netlify.toml"));
fs.writeFileSync(path.join(tmp, "tools/netlify-skip-build.sh"), "#!/bin/bash\nexit 0\n");     // a rule that skips every build
const good = spawnSync("bash", [path.join(root, "tests/netlify-skip.sh")], { env: { ...process.env, TARGET: root }, encoding: "utf8" });
const broken = spawnSync("bash", [path.join(root, "tests/netlify-skip.sh")], { env: { ...process.env, TARGET: tmp }, encoding: "utf8" });
fs.rmSync(tmp, { recursive: true, force: true });
out.push((good.status === 0 && broken.status !== 0 ? "safe       " : "VULNERABLE ") + `T4 tests/netlify-skip.sh checks the copy it is pointed at: this copy ${good.status === 0 ? "passes" : "fails"}, a copy whose rule skips every build ${broken.status !== 0 ? "fails" : "passes (it checked this folder instead)"}`);

// --- the check reads every kind of test file: a made-up copy with one old way in each kind of place, all must be found
const fake = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || "/tmp"), "cuvori-kinds-"));
for (const [f, line] of Object.entries(KINDS)) { fs.mkdirSync(path.join(fake, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(fake, f), line + "\n"); }
fs.writeFileSync(path.join(fake, "tests/run-all.sh"), "#!/bin/bash\necho \"== a page test\"; page pagetest.js\n");
const kinds = scan(fake), missed = Object.keys(KINDS).filter(f => !kinds.bad.includes(`${path.normalize(f)}:1`));
fs.rmSync(fake, { recursive: true, force: true });
out.push((missed.length ? "VULNERABLE " : "safe       ") + `T5 the check reads every kind of test file (.mjs, .js and .sh in tests/ and its folders, and a page test next to index.html that tests/run-all.sh runs): ${Object.keys(KINDS).length - missed.length} of ${Object.keys(KINDS).length} old ways found in them${missed.length ? ", not found in: " + missed.join(", ") : ""}`);

console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
