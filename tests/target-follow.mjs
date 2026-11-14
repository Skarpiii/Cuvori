// Check of 20 November: every test reads and loads the copy of Cuvori it is pointed at.
// The tests can be run against another copy of the repository (TARGET=<folder>): to show a check failing on the code that
// is on GitHub now, or that a deliberate break of the code is caught. A test that finds the repository from its own folder
// instead (new URL("../…", import.meta.url), or the folder above its own) then quietly checks this folder's code, SQL, page
// or notes, not the copy's, and passes or fails for the wrong copy. Report of 18 November: four checks in
// attack-functions.mjs did, and the re-check after 19 November found 36 test files more and A23 of attack-functions.mjs. Every
// such place must follow TARGET (or
// ROOT, which limits-match.mjs takes) and fall back to this folder only when neither is set.
// Run: node tests/target-follow.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = process.env.TARGET ? path.resolve(process.env.TARGET) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "tests");
// climbing from the test's own folder to the repository
const CLIMB = [/new URL\(\s*["']\.\.(?:\/|["'])/, /fileURLToPath\(import\.meta\.url\)\)\s*,\s*["']\.\.["']/, /new URL\(import\.meta\.url\)\.pathname\)\s*,\s*["']\.\.["']/, /__dirname\s*,\s*["']\.\.["']/];
const FOLLOWS = /process\.env\.(TARGET|ROOT)\b/;
// a place counts when it starts from the test's own file (import.meta.url, or __dirname) and climbs out of tests/; one that
// starts from a folder that already follows TARGET (the payment functions' folder F of fn-harness.mjs) does not
const climbs = (l) => !/^\s*\/\//.test(l) && /import\.meta\.url|__dirname/.test(l) && CLIMB.some(re => re.test(l)) && !FOLLOWS.test(l);
const files = fs.readdirSync(dir).filter(f => f.endsWith(".mjs")).sort();
const bad = [];
for (const f of files) {
  const lines = fs.readFileSync(path.join(dir, f), "utf8").split("\n");
  lines.forEach((l, i) => { if (climbs(l)) bad.push(`${f}:${i + 1}`); });
}
const out = [];
out.push((bad.length ? "VULNERABLE " : "safe       ") + `T1 ${files.length} test files read, ${bad.length} place${bad.length === 1 ? "" : "s"} that find the repository from the test's own folder without following TARGET: ${bad.slice(0, 40).join(", ")}${bad.length > 40 ? ` (+${bad.length - 40})` : ""} (must be: none)`);
// the check itself finds them: a place written the old way, in a scratch file, is reported
const probe = ['const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");', 'const t = fs.readFileSync(fileURLToPath(new URL("../SETUP.md", import.meta.url)), "utf8");', 'const h = fs.readFileSync(new URL("../index.html", import.meta.url), "utf8");', 'const r = (process.env.ROOT || new URL("..", import.meta.url).pathname);', 'const s = process.env.TARGET ? path.resolve(process.env.TARGET) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");', 'const lib = await import(new URL("../lib/cuvori.mjs", "file://" + F).href);'];
const flagged = probe.map(climbs);
out.push((flagged.join() !== "true,true,true,false,false,false" ? "VULNERABLE " : "safe       ") + `T2 the check itself: the three old ways are reported (${flagged.slice(0, 3).join(", ")}); one that follows ROOT, one that follows TARGET and one that starts from the payment functions' folder are not (${flagged.slice(3).join(", ")})`);
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
