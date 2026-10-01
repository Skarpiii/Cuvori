// The smallest and largest amounts Cuvori takes are written in several places: the payment code, the Order page, the
// page tests' fake backend and the database. They must be the same everywhere, or a client sees a button that cannot work
// (a Fund button the payment code refuses, or a release the page hides although the server would allow it), or
// people are told the wrong rule.
// This check reads the files themselves, so it fails as soon as one copy is changed without the others.
import fs from "node:fs";
const root = (process.env.ROOT || new URL("..", import.meta.url).pathname).replace(/\/?$/, "/");
const read = (f) => fs.readFileSync(root + f, "utf8");
const out = [];
const check = (ok, m) => out.push((ok ? "PASS " : "FAIL ") + m);
const num = (text, re) => { const m = text && text.match(re); return m ? Number(m[1]) : null; };
const euros = (text, re) => { const v = num(text, re); return v == null ? null : Math.round(v * 100); };   // a rule written in euros, as cents
const schemaFiles = () => fs.readdirSync(root + "supabase").filter(f => /^schema_v\d+\.sql$/.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
// the database uses the newest definition of a function: the highest schema_vNN.sql that (re)defines it
function latestSql(fn) {
  let found = { file: null, body: null };
  for (const f of schemaFiles()) {
    const t = read("supabase/" + f), i = t.indexOf(`create or replace function public.${fn}(`);
    if (i >= 0) found = { file: f, body: t.slice(i, t.indexOf("$$;", i)) };
  }
  return found;
}
// and the newest version of a table rule: the last file that adds it, unless a later one drops it again
function latestConstraint(name) {
  let found = { file: null, body: null };
  for (const f of schemaFiles()) {
    const t = read("supabase/" + f), re = new RegExp(`(drop|add) constraint (if exists )?${name}\\b`, "g");
    for (const m of t.matchAll(re)) found = m[1] === "add" ? { file: f, body: t.slice(m.index, t.indexOf(";", m.index)) } : { file: f + " (dropped)", body: null };
  }
  return found;
}

const lib = read("netlify/lib/cuvori.mjs"), checkout = read("netlify/functions/stripe-checkout.mjs"), page = read("index.html"), mock = read("mock-supabase.js");
const topup = num(lib, /\bMIN_TOPUP_CENTS\s*=\s*(\d+)/), whole = num(lib, /\bMIN_CENTS\s*=\s*(\d+)/), most = num(lib, /\bMAX_CENTS\s*=\s*(\d+)/);
const onePayment = num(lib, /\bMAX_PAYMENT_CENTS\s*=\s*(\d+)/);
check(Number.isInteger(topup) && Number.isInteger(whole) && Number.isInteger(most), `the payment code sets the limits: a top-up from ${topup} cents, an Order from ${whole} up to ${most} cents`);
check(checkout.includes(`kind === "topup" ? MIN_TOPUP_CENTS : MIN_CENTS`), "the Stripe payment page takes its minimums from the payment code, €1 unless it is a price increase (stripe-checkout.mjs)");
check(checkout.includes("price > MAX_CENTS") && checkout.includes("amount > MAX_CENTS"), "the Stripe payment page takes its maximum from the payment code (stripe-checkout.mjs)");
// the biggest Order, with the highest card fee on top (the default fee row, worked out the way order_quote does it),
// must still fit in one payment
let fee = null;
for (const f of schemaFiles()) for (const m of read("supabase/" + f).matchAll(/set percent = (\d+(?:\.\d+)?), fixed_cents = (\d+)/g)) fee = { percent: Number(m[1]), fixed: Number(m[2]), file: f };
const biggest = fee && Math.ceil((most + fee.fixed) / (1 - fee.percent / 100));
check(fee && biggest <= onePayment, `the biggest Order (${most} cents) plus the highest card fee (${fee && fee.percent}% + ${fee && fee.fixed} cents, ${fee && fee.file}) is ${biggest} cents, at most one payment (${onePayment})`);

// the page and the fake backend each write the two numbers once, and every check there uses them
const pageTopup = num(page, /\bMIN_TOPUP_CENTS=(\d+)/), pageWhole = num(page, /\bMIN_ORDER_CENTS=(\d+)/), pageMost = num(page, /\bMAX_ORDER_CENTS=(\d+)/);
const mockTopup = num(mock, /\bMIN_TOPUP_CENTS=(\d+)/), mockWhole = num(mock, /\bMIN_ORDER_CENTS=(\d+)/), mockMost = num(mock, /\bMAX_ORDER_CENTS=(\d+)/);
const uses = (text, file, list) => { for (const [what, code] of list) check(text.includes(code), `${file}: ${what} uses its own limit (${code})`); };
uses(page, "the Order page", [
  ["the Fund button and the release", "topupRaw>=MIN_TOPUP_CENTS"],
  ["the new Order form", "f.price_cents<MIN_ORDER_CENTS"],
  ["a price change: the new price", "oCents(o)+delta<MIN_ORDER_CENTS"],
  ["a price change: extra money on a paid Order", "delta>0&&delta<MIN_TOPUP_CENTS"],
  ["accepting a price change", "open.price_delta_cents<MIN_TOPUP_CENTS"],
  ["the price field", 'max="${MAX_ORDER_CENTS/100}"'],
  ["the new Order form: the most", "f.price_cents>MAX_ORDER_CENTS"],
  ["a price change: the most", "oCents(o)+delta>MAX_ORDER_CENTS"],
  ["accepting a price change: the most", "oCents(o)+(open.price_delta_cents||0)>MAX_ORDER_CENTS"],
]);
uses(mock, "the page tests' fake backend", [
  ["a new or edited Order", "pc<MIN_ORDER_CENTS"],
  ["a price change: the new price", "c.amount_cents+delta<MIN_ORDER_CENTS"],
  ["a price change: extra money on a paid Order", "delta>0&&delta<MIN_TOPUP_CENTS&&paidIn(c)"],
  ["accepting a price change", "a.price_delta_cents<MIN_TOPUP_CENTS&&paidIn(c)"],
  ["the release", "c.amount_cents-(c.funded_cents||0)>=MIN_TOPUP_CENTS"],
  ["the Stripe payment page", "kind===\"topup\"?MIN_TOPUP_CENTS:MIN_ORDER_CENTS"],
  ["a new or edited Order: the most", "pc>MAX_ORDER_CENTS"],
  ["a price change: the most", "c.amount_cents+delta>MAX_ORDER_CENTS"],
  ["accepting a price change: the most", "c.amount_cents+a.price_delta_cents>MAX_ORDER_CENTS"],
  ["the Stripe payment page: the most", "amount>MAX_ORDER_CENTS"],
]);

const amend = latestSql("order_amend"), decide = latestSql("order_amendment_decide"), input = latestSql("order_input_ok"), oldInput = latestSql("contract_input_ok");
const sane = latestConstraint("contracts_sane");

// the smallest extra money that can be paid in on an Order that is already paid (€0.50 today)
const topupPlaces = [
  ["the Order page", pageTopup],
  ["the page tests' fake backend", mockTopup],
  [`the database: proposing extra money (order_amend, ${amend.file})`, num(amend.body, /delta > 0 and delta < (\d+)/)],
  [`the database: accepting extra money (order_amendment_decide, ${decide.file})`, num(decide.body, /a\.price_delta_cents > 0 and a\.price_delta_cents < (\d+)/)],
];
for (const [where, v] of topupPlaces) check(v === topup, `smallest extra money on a paid Order: ${where} says ${v}, the payment code ${topup}`);

// the smallest Order price (€1 today)
const wholePlaces = [
  ["the Order page", pageWhole],
  ["the page tests' fake backend", mockWhole],
  [`the database: a new or edited Order (order_input_ok, ${input.file})`, num(input.body, /price < (\d+) or price >/)],
  [`the database: a price after a change (order_amend, ${amend.file})`, num(amend.body, /new_total < (\d+)/)],
  [`the database: the Orders table rule for protected payments (contracts_sane, ${sane.file}, in euros)`, euros(sane.body, /pricing = 'project' and price >= (\d+(?:\.\d+)?)/)],
  [`the database: the old Order functions (contract_input_ok, ${oldInput.file}, in euros)`, euros(oldInput.body, /mode = 'escrow' and price < (\d+(?:\.\d+)?)/)],
];
for (const [where, v] of wholePlaces) check(v === whole, `smallest Order price: ${where} says ${v}, the payment code ${whole}`);

// the largest Order price (€950,000 today). The Orders table keeps its own wider sanity limit (€1,000,000), which is
// not a copy of this rule: every way of setting a price goes through the functions below.
const mostPlaces = [
  ["the Order page", pageMost],
  ["the page tests' fake backend", mockMost],
  [`the database: a new or edited Order (order_input_ok, ${input.file})`, num(input.body, /price < \d+ or price > (\d+)/)],
  [`the database: a price after a change (order_amend, ${amend.file})`, num(amend.body, /new_total > (\d+)/)],
  [`the database: accepting a price change (order_amendment_decide, ${decide.file})`, num(decide.body, /a\.price_delta_cents > (\d+) then return/)],
  [`the database: the old Order functions (contract_input_ok, ${oldInput.file}, in euros)`, euros(oldInput.body, /price < 0 or price > (\d+(?:\.\d+)?)/)],
];
for (const [where, v] of mostPlaces) check(v === most, `largest Order price: ${where} says ${v}, the payment code ${most}`);

console.log(out.join("\n"));
const failed = out.filter(l => l.startsWith("FAIL")).length;
console.log(`\n${out.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
