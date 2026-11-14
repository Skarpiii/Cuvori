// Check of 18 November (pricing-v2): the settings of money held apart at Stripe, as the owner sees them.
// P1 STRIPE_PREVIEW_VERSION was the one setting of money held apart where capital letters mattered: "2026-12-01.Preview"
//    left Stripe's newer preview version unused without a word, while "ON" and "Capture" count. Now its capital letters
//    make no difference either.
// P2 SETUP.md never named STRIPE_PREVIEW_VERSION: the owner could not know it exists, or when to set it.
// P3 Nothing showed the owner whether money is held apart at Stripe (STRIPE_FUNDS_SEGREGATION), or where it is asked for
//    (STRIPE_FS_WHERE) and with which preview version: only Netlify's settings page did. Now the payment status the admin
//    panel reads (stripe-status) says so, to a signed-in admin only; everyone else gets the same answer as before.
//    (The admin panel's own line is checked in the browser: realtest.js, "Money held apart at Stripe".)
import fs from "node:fs";
import path from "node:path";
import { users, req, call, reset, fns, F } from "./fn-harness.mjs";
const root = process.env.TARGET ? path.resolve(process.env.TARGET) : path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const lib = await import(F + "../lib/cuvori.mjs");
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const realError = console.error; console.error = () => {};
const SETTINGS = ["STRIPE_FUNDS_SEGREGATION", "STRIPE_FS_WHERE", "STRIPE_PREVIEW_VERSION"];
const clear = () => { for (const k of SETTINGS) delete process.env[k]; };
const guard = async (name, fn) => { try { await fn(); } catch (e) { out.push(`VULNERABLE ${name} threw: ${e && e.stack ? e.stack.split("\n").slice(0, 2).join(" ") : e}`); } finally { reset(); clear(); users.adm.banned = false; } };
const fx = await fns();
const status = (token) => call(fx.status, req("GET", "x", token ? { token } : {}));
const DEFAULT = "2026-10-28.preview";

// ---------- P1 STRIPE_PREVIEW_VERSION: capital letters ----------
await guard("P1", async () => {
  const read = (v) => { process.env.STRIPE_PREVIEW_VERSION = v; return lib.fsVersion(); };
  const want = "2026-12-01.preview; allocated_funds_preview=v1", dflt = `${lib.FS_PREVIEW_VERSION}; allocated_funds_preview=v1`;
  const got = { capital: read("2026-12-01.Preview"), all: read(" 2026-12-01.PREVIEW\n"), plain: read("2026-12-01.preview"), bad: read("2026-12-01.previews"), word: read("preview") };
  vuln(got.capital !== want || got.all !== want || got.plain !== want || got.bad !== dflt || got.word !== dflt,
    `P1 STRIPE_PREVIEW_VERSION "2026-12-01.Preview" -> ${got.capital}; " 2026-12-01.PREVIEW" with a line break -> ${got.all}; "2026-12-01.preview" -> ${got.plain}; "2026-12-01.previews" -> ${got.bad}; "preview" -> ${got.word} (must be: the version written, whatever its capitals; Cuvori's own one for anything else)`);
});
// ---------- P2 SETUP.md names STRIPE_PREVIEW_VERSION, in the part about money held apart ----------
await guard("P2", async () => {
  const s = fs.readFileSync(path.join(root, "SETUP.md"), "utf8");
  const part = (s.split(/\n(?=#+ )/).find(x => x.includes("STRIPE_FUNDS_SEGREGATION") && /funds segregation/i.test(x)) || "");
  const said = part.includes("STRIPE_PREVIEW_VERSION") && part.includes(DEFAULT);
  vuln(!said, `P2 SETUP.md's part about money held apart names STRIPE_PREVIEW_VERSION and Cuvori's own preview version (${DEFAULT}): ${said} (must be: yes, so the owner knows when to set it)`);
});
// ---------- P3 stripe-status tells a signed-in admin whether money is held apart, where, and with which version ----------
await guard("P3 [nothing set]", async () => {
  const r = await status("tok_adm"); const h = r.json && r.json.heldApart;
  vuln(r.status !== 200 || !h || h.on !== false || h.where !== "checkout" || h.version !== DEFAULT,
    `P3 [nothing set] an admin asks for the payment status -> ${r.status} heldApart ${JSON.stringify(h)} (must be: off, on Stripe's payment page, ${DEFAULT})`);
});
await guard("P3 [on, capture, newer version]", async () => {
  process.env.STRIPE_FUNDS_SEGREGATION = "ON "; process.env.STRIPE_FS_WHERE = " Capture"; process.env.STRIPE_PREVIEW_VERSION = "2026-12-01.Preview";
  const r = await status("tok_adm"); const h = r.json && r.json.heldApart;
  vuln(r.status !== 200 || !h || h.on !== true || h.where !== "capture" || h.version !== "2026-12-01.preview",
    `P3 [on, capture, newer version] STRIPE_FUNDS_SEGREGATION "ON ", STRIPE_FS_WHERE " Capture", STRIPE_PREVIEW_VERSION "2026-12-01.Preview": an admin is told ${JSON.stringify(h)} (must be: on, just before the card is charged, 2026-12-01.preview)`);
});
await guard("P3 [on, payment page]", async () => {
  process.env.STRIPE_FUNDS_SEGREGATION = "on";
  const r = await status("tok_adm"); const h = r.json && r.json.heldApart;
  vuln(!h || h.on !== true || h.where !== "checkout" || h.version !== DEFAULT, `P3 [on, payment page] STRIPE_FUNDS_SEGREGATION "on": an admin is told ${JSON.stringify(h)} (must be: on, on Stripe's payment page, ${DEFAULT})`);
});
// ---------- P4 nobody else is told: the same answer as before ----------
await guard("P4", async () => {
  process.env.STRIPE_FUNDS_SEGREGATION = "on"; process.env.STRIPE_FS_WHERE = "capture";
  const anon = await status(null), member = await status("tok_cl");
  users.adm.banned = true; const banned = await status("tok_adm");
  const keys = (r) => Object.keys(r.json || {}).sort().join(",");
  const plain = "autoReleaseDays,databaseKeyOk,escrow,stripeKeyOk";
  vuln([anon, member, banned].some(r => r.status !== 200 || keys(r) !== plain),
    `P4 the payment status asked without a sign-in (${keys(anon)}), by a client (${keys(member)}), by a banned admin (${keys(banned)}) (must each be only ${plain}: whether money is held apart is said to an admin only)`);
});

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
