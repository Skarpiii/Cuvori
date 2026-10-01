// The smallest amounts Cuvori takes are written in several places: the payment code, the Order page, the page tests'
// fake backend and the database. They must be the same everywhere, or a client sees a button that cannot work
// (a Fund button the payment code refuses, or a release the page hides although the server would allow it).
// This check reads the files themselves, so it fails as soon as one copy is changed without the others.
import fs from "node:fs";
const root = (process.env.ROOT || new URL("..", import.meta.url).pathname).replace(/\/?$/, "/");
const read = (f) => fs.readFileSync(root + f, "utf8");
const out = [];
const check = (ok, m) => out.push((ok ? "PASS " : "FAIL ") + m);
const num = (text, re) => { const m = text && text.match(re); return m ? Number(m[1]) : null; };
// the database uses the newest definition of a function: the highest schema_vNN.sql that (re)defines it
function latestSql(fn) {
  const files = fs.readdirSync(root + "supabase").filter(f => /^schema_v\d+\.sql$/.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  let found = { file: null, body: null };
  for (const f of files) {
    const t = read("supabase/" + f), i = t.indexOf(`create or replace function public.${fn}(`);
    if (i >= 0) found = { file: f, body: t.slice(i, t.indexOf("$$;", i)) };
  }
  return found;
}

const lib = read("netlify/lib/cuvori.mjs"), page = read("index.html"), mock = read("mock-supabase.js");
const amend = latestSql("order_amend"), decide = latestSql("order_amendment_decide");
const topup = num(lib, /\bMIN_TOPUP_CENTS\s*=\s*(\d+)/), whole = num(lib, /\bMIN_CENTS\s*=\s*(\d+)/);
check(Number.isInteger(topup) && Number.isInteger(whole), `the payment code sets the minimums: a top-up from ${topup} cents, an Order from ${whole} cents`);

// the smallest increase that can be paid in (€0.50 today)
const topupPlaces = [
  ["the Order page (Fund button and release)", num(page, /topupRaw>=(\d+)/)],
  ["the page tests' fake backend (release)", num(mock, /c\.amount_cents-\(c\.funded_cents\|\|0\)>=(\d+)/)],
  [`the database: proposing an increase (order_amend, ${amend.file})`, num(amend.body, /delta > 0 and delta < (\d+)/)],
  [`the database: accepting an increase (order_amendment_decide, ${decide.file})`, num(decide.body, /a\.price_delta_cents > 0 and a\.price_delta_cents < (\d+)/)],
];
for (const [where, v] of topupPlaces) check(v === topup, `smallest increase that can be paid: ${where} says ${v}, the payment code ${topup}`);

// the smallest Order price (€1 today)
const wholePlaces = [
  ["the Order page (new Order form)", num(page, /f\.price_cents<(\d+)/)],
  [`the database: a price after an amendment (order_amend, ${amend.file})`, num(amend.body, /new_total < (\d+)/)],
];
for (const [where, v] of wholePlaces) check(v === whole, `smallest Order price: ${where} says ${v}, the payment code ${whole}`);

console.log(out.join("\n"));
const failed = out.filter(l => l.startsWith("FAIL")).length;
console.log(`\n${out.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
