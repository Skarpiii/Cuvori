// Check of 19 November (both branches): what the checks of 18 November found no test for. The code was right; nothing
// would have noticed had it broken.
// N1/N2 the page on cuvori.io calls the payment functions on another address (main--cuvori.netlify.app), so the browser
//    lets it read an answer only when the answer names cuvori.io (Access-Control-Allow-Origin). A refusal thrown inside a
//    payment step ("Sign-in verification is temporarily unavailable") and an unexpected error must name it too, or the
//    page cannot read why and says the payment functions cannot be reached.
// N3 every unexpected error gets its own reference number, the one the person is shown and the Netlify log names, so a
//    person's "ref …" leads to the right log line.
// N4 each request has a store of its own for the website that sent it: an answer made outside a request (the webhook's,
//    the hourly job's) never names the website of the request before, and requests at the same moment never swap them.
// N5 while a webhook secret is being changed in Stripe, each notice carries two signatures, in an order Stripe does not
//    promise: a notice is taken whichever of the two is right, and refused when neither is.
const H = await import("./fn-harness.mjs");
const { users, req, call, reset, fns, sigFor } = H;
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const logs = []; const realError = console.error; console.error = (...a) => logs.push(a.map(String).join(" "));
// one kind of request that fails (the sign-in check, or the database reading an Order), or waits a moment first
const FAULT = { auth: false, contracts: false, slowAuth: false };
const inner = globalThis.fetch;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes("/auth/v1/user")) {
    if (FAULT.auth) return new Response(JSON.stringify({ message: "upstream timeout" }), { status: 503, headers: { "content-type": "application/json" } });
    if (FAULT.slowAuth) await new Promise(r => setTimeout(r, Math.random() * 25));
  }
  if (FAULT.contracts && /\/rest\/v1\/contracts\?/.test(u) && (init.method || "GET") === "GET")
    return new Response(JSON.stringify({ message: "canceling statement due to statement timeout" }), { status: 500, headers: { "content-type": "application/json" } });
  return inner(url, init);
};
const guard = async (name, fn) => { try { await fn(); } catch (e) { out.push(`VULNERABLE ${name} threw: ${e && e.stack ? e.stack.split("\n").slice(0, 2).join(" ") : e}`); } finally { reset(); FAULT.auth = FAULT.contracts = FAULT.slowAuth = false; } };
const fx = await fns();
const from = (origin, method, token, body) => req(method, "x", { token, body, headers: origin ? { origin } : {} });
const allow = (r) => (r.headers && r.headers.get("access-control-allow-origin")) || null;
const CUVORI = "https://cuvori.io", WWW = "https://www.cuvori.io", EVIL = "https://evil.example";

// ---------- N1 a refusal thrown inside a payment step ----------
await guard("N1", async () => {
  FAULT.auth = true;
  const a = await call(fx.confirm, from(CUVORI, "POST", "tok_cl", { contract_id: H.uuid() }));
  const b = await call(fx.confirm, from(EVIL, "POST", "tok_cl", { contract_id: H.uuid() }));
  vuln(a.status !== 503 || !a.json || a.json.code !== "signin_unavailable" || allow(a) !== CUVORI || allow(b) !== null,
    `N1 Supabase's sign-in check is down while a client on cuvori.io confirms a payment -> ${a.status} ${a.json && a.json.code}, readable by ${allow(a)}; the same from another website -> readable by ${allow(b)} (must be: the refusal readable by cuvori.io only)`);
});
// ---------- N2/N3 unexpected errors: readable by cuvori.io, each with its own reference number, in the log ----------
await guard("N2", async () => {
  FAULT.contracts = true; const n = logs.length;
  const a = await call(fx.confirm, from(CUVORI, "POST", "tok_cl", { contract_id: H.uuid() }));
  const b = await call(fx.confirm, from(WWW, "POST", "tok_cl", { contract_id: H.uuid() }));
  const refA = a.json && a.json.ref, refB = b.json && b.json.ref, said = logs.slice(n);
  vuln(a.status !== 500 || b.status !== 500 || allow(a) !== CUVORI || allow(b) !== WWW,
    `N2 the database fails while reading the Order -> ${a.status} from cuvori.io (readable by ${allow(a)}), ${b.status} from www.cuvori.io (readable by ${allow(b)}) (must be: each readable by the website that asked)`);
  const ownLine = (ref) => said.some(l => l.startsWith("fn error " + ref));
  vuln(!/^[0-9a-f]{8}$/.test(String(refA)) || !/^[0-9a-f]{8}$/.test(String(refB)) || refA === refB || !ownLine(refA) || !ownLine(refB) || !String(a.json.error).includes(refA),
    `N3 two unexpected errors -> refs ${refA} and ${refB}; each in its own log line: ${ownLine(refA)}/${ownLine(refB)}; the person is shown it: ${!!(a.json && String(a.json.error).includes(refA))} (must be: two different 8-character refs, each in the person's message and in its own log line)`);
});
// ---------- N4 a store of its own for each request ----------
await guard("N4", async () => {
  const s = await call(fx.status, from(CUVORI, "GET"));
  const w = await call(fx.webhook, from(null, "POST", null, { type: "x" }));        // not signed: refused, made outside any browser request
  const h = await call(fx.autoRelease, from(null, "POST"));
  FAULT.slowAuth = true;
  const origins = Array.from({ length: 30 }, (_, i) => [CUVORI, WWW, EVIL][i % 3]);
  const got = await Promise.all(origins.map(o => call(fx.status, from(o, "GET", "tok_cl")).then(allow)));
  const swapped = got.filter((g, i) => g !== (origins[i] === EVIL ? null : origins[i])).length;
  vuln(allow(s) !== CUVORI || allow(w) !== null || allow(h) !== null || swapped,
    `N4 a request from cuvori.io (${allow(s)}), then the webhook's answer (names ${allow(w)}) and the hourly job's (names ${allow(h)}); 30 requests at the same moment from 3 websites: ${30 - swapped} answered for their own website, ${swapped} for another (must be: only browser requests name their own website)`);
});
// ---------- N5 two signatures on one notice (a webhook secret being changed) ----------
await guard("N5", async () => {
  const raw = JSON.stringify({ id: "evt_rot1", type: "account.updated", data: { object: { id: "acct_1EditorAAAAAAAA", object: "account" } } });
  const s = sigFor(raw), other = "0".repeat(64);
  const send = (v1s) => call(fx.webhook, req("POST", "x", { raw, headers: { "stripe-signature": `t=${s.t},${v1s.map(v => "v1=" + v).join(",")}` } }));
  const first = await send([s.v1, other]), second = await send([other, s.v1]), neither = await send([other, "f".repeat(64)]);
  vuln(first.status !== 200 || second.status !== 200 || neither.status !== 400,
    `N5 a notice with two signatures: the right one first -> ${first.status}, the right one second -> ${second.status}, neither right -> ${neither.status} (must be: 200, 200, 400)`);
});

console.error = realError;
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
