// Stripe's answers about a retry key itself, rather than about the request:
//  - "another request with this key is still running": a 409. Stripe's docs give it its own code, idempotency_key_in_use,
//    and use the type idempotency_error for the other case (below); they don't say which type the 409 carries. Stripe's
//    own library resends every 409 with the same key, and Stripe's docs say to wait and retry with that key: "A new key
//    can start a second operation." So every 409 must keep the key, and a second Fund tab must wait for the first one's
//    page, whatever type the 409 carries.
//  - "this key was used for a different request": type idempotency_error, a 400. That one stays as it is.
// And one refusal about the payment: a refund refused because the payment was charged back. Stripe lists two codes for it,
// charge_disputed and refund_disputed_payment; both must say so in Cuvori's own sentence.
// I1 two Fund tabs, I2 the retry key of a money move, I3 the other answers unchanged, I4 charged-back refunds, I5 the test copy of Stripe.
// Run: node tests/attack-idempotency.mjs
const H = await import("./fn-harness.mjs");
const { DB, STRIPE, hooks, req, call, mk, fund, moneyOut, reset } = H;
console.error = () => {};
const lib = await import(H.F + "../lib/cuvori.mjs");
const fx = await H.fns();
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const IN_USE = "There is currently another in-progress request using this idempotent key. Please try again later.";
const SHAPES = {
  "Stripe's code idempotency_key_in_use (type invalid_request_error)": [{ type: "invalid_request_error", code: "idempotency_key_in_use", message: IN_USE }, {}],
  "the same, with Stripe's \"retry\" header": [{ type: "invalid_request_error", code: "idempotency_key_in_use", message: IN_USE }, { "Stripe-Should-Retry": "true" }],
  "type idempotency_error, no code": [{ type: "idempotency_error", message: IN_USE }, {}],
  "a 409 with no code at all (type api_error)": [{ type: "api_error", message: "The request conflicts with another request." }, {}],
};
const answer = (status, error, headers = {}) => new Response(JSON.stringify({ error }), { status, headers: { "content-type": "application/json", ...headers } });
const f0 = globalThis.fetch;
let rewrite409 = null, once = null;
globalThis.fetch = async (u, init = {}) => {
  if (once && /api\.stripe\.com/.test(String(u))) { const r = once(String(u), init); if (r) { once = null; return r; } }
  const r = await f0(u, init);
  return rewrite409 && r.status === 409 && /api\.stripe\.com/.test(String(u)) ? answer(409, rewrite409[0], rewrite409[1]) : r;
};

// ---------- I1: two Fund tabs at the same moment, while Stripe is still making the first tab's page ----------
for (const [what, shape] of Object.entries(SHAPES)) {
  const c = mk({ amount_cents: 10000 });
  const click = () => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, lang: "en" } }));
  hooks.stripe = async (path, method) => { if (path === "/checkout/sessions" && method === "POST") await sleep(300); return null; };
  rewrite409 = shape;
  const [t1, t2] = await Promise.all([click(), (async () => { await sleep(100); return click(); })()]);
  rewrite409 = null; reset();
  const pages = Object.values(STRIPE.sessions).filter(s => s.client_reference_id === c.id);
  vuln(t1.status !== 200 || t2.status !== 200 || !t1.json || !t2.json || t1.json.url !== t2.json.url || pages.length !== 1 || pages[0].status !== "open",
    `I1 two Fund tabs at once, Stripe answers the second "still in use" as ${what} -> tabs ${t1.status}/${t2.status}${t2.status !== 200 ? " " + JSON.stringify(t2.json) : ""}; same page: ${!!(t1.json && t2.json && t1.json.url === t2.json.url)}; pages made ${pages.length} (the second tab must wait and get the same page)`);
}

// ---------- I2: a money move whose key Stripe says is still in use: the key is kept, never a second move with a new key ----------
const b = mk(); await fund(fx, b); b.status = "funded";
let n = 0;
for (const [what, shape] of Object.entries(SHAPES)) {
  const scope = `probe-refund:${b.id}:${++n}`; const key = await lib.moneyKey(scope);
  once = (u, init) => (/\/v1\/refunds$/.test(u) && init.method === "POST" ? answer(409, shape[0], shape[1]) : null);
  let e = null; try { await lib.moneyPost(scope, "/refunds", { payment_intent: b.stripe_payment_intent, amount: 100, metadata: { contract_id: b.id } }); } catch (x) { e = x; }
  once = null;
  const kept = DB.money_keys.some(k => k.scope === scope && k.key === key);
  vuln(!e || !kept || !lib.idemBusy(e) || lib.idemMismatch(e), `I2 a refund whose key is still in use, ${what} -> the key ${kept ? "kept" : "DROPPED"}; seen as "still in use" ${!!(e && lib.idemBusy(e))} (must be kept, so a later try waits for the first request instead of starting a second refund)`);
}

// ---------- I3: every other answer is read as before ----------
for (const [what, status, error, headers, keep, mismatch] of [
  ["a key used for a different request (400 idempotency_error)", 400, { type: "idempotency_error", message: "Keys for idempotent requests can only be used with the same parameters they were first used with." }, {}, true, true],
  ["a plain refusal (400)", 400, { type: "invalid_request_error", message: "Amount must be at least 50 cents" }, {}, false, false],
  ["a card decline (402)", 402, { type: "card_error", code: "card_declined", message: "Your card was declined." }, {}, false, false],
  ["too many requests (429)", 429, { type: "invalid_request_error", code: "rate_limit", message: "Too many requests" }, {}, false, false],
  ["Stripe's error, \"retry\" (500)", 500, { type: "api_error", message: "An unknown error occurred" }, { "Stripe-Should-Retry": "true" }, true, false],
  ["Stripe's error, no retry (500)", 500, { type: "api_error", message: "An unknown error occurred" }, {}, false, false],
]) {
  const scope = `probe-other:${b.id}:${++n}`; const key = await lib.moneyKey(scope);
  once = (u, init) => (/\/v1\/refunds$/.test(u) && init.method === "POST" ? answer(status, error, headers) : null);
  let e = null; try { await lib.moneyPost(scope, "/refunds", { payment_intent: b.stripe_payment_intent, amount: 100, metadata: { contract_id: b.id } }); } catch (x) { e = x; }
  once = null;
  const kept = DB.money_keys.some(k => k.scope === scope && k.key === key);
  vuln(!e || kept !== keep || lib.idemBusy(e) || !!lib.idemMismatch(e) !== mismatch, `I3 ${what} -> key ${kept ? "kept" : "dropped"} (must be ${keep ? "kept" : "dropped"}); "still in use" ${!!(e && lib.idemBusy(e))} (must be false); "different request" ${!!(e && lib.idemMismatch(e))}`);
}

// ---------- I4: a refund refused because the payment was charged back (the bank's notice has not arrived yet) ----------
const CHARGEBACK = "A card chargeback is open on this payment. Nothing can move until the bank decides.";
for (const [what, error] of [
  ["code charge_disputed", { type: "invalid_request_error", code: "charge_disputed", message: "Charge ch_x has been charged back; cannot issue a refund." }],
  ["code refund_disputed_payment", { type: "invalid_request_error", code: "refund_disputed_payment", message: "You can't refund a disputed payment." }],
  ["no code, Stripe's words \"charged back\"", { type: "invalid_request_error", message: "This charge has been charged back." }],
]) {
  const c = mk(); await fund(fx, c); c.status = "funded";
  hooks.stripe = async (path, method) => (method === "POST" && path === "/refunds" ? [400, { error }] : null);
  const r = await call(fx.cancel, req("POST", "x", { token: "tok_ed", body: { contract_id: c.id } }));
  reset();
  vuln(r.status !== 409 || (r.json && r.json.error) !== CHARGEBACK || c.money_error !== CHARGEBACK || moneyOut(c).refunded !== 0,
    `I4 the freelancer cancels, the refund is refused with ${what} -> ${r.status} ${JSON.stringify(r.json).slice(0, 90)}; note ${JSON.stringify(c.money_error).slice(0, 90)} (must be Cuvori's chargeback sentence; nothing moves)`);
}

// ---------- I5: the test copy of Stripe answers "still in use" the way Stripe's docs describe ----------
{
  const c = mk({ amount_cents: 10000 }); let raw = null;
  const g0 = globalThis.fetch;
  globalThis.fetch = async (u, init = {}) => { const r = await g0(u, init); if (r.status === 409 && /api\.stripe\.com/.test(String(u))) raw = await r.clone().json(); return r; };
  hooks.stripe = async (path, method) => { if (path === "/checkout/sessions" && method === "POST") await sleep(300); return null; };
  const click = () => call(fx.checkout, req("POST", "x", { token: "tok_cl", body: { contract_id: c.id, lang: "en" } }));
  await Promise.all([click(), (async () => { await sleep(100); return click(); })()]);
  reset(); globalThis.fetch = g0;
  vuln(!raw || !raw.error || raw.error.code !== "idempotency_key_in_use", `I5 the test copy of Stripe, a key still in use -> ${JSON.stringify(raw)} (must carry Stripe's documented code idempotency_key_in_use, so the tests check the real answer)`);
}

console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
