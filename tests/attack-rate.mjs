// One person can't use up Stripe's limit for everyone (schema v30, limitTries in the payment library). Stripe takes only
// so many requests a second from Cuvori as a whole; past about 10 tries a minute of one payment button (30 for the
// Payout details status, which the page asks each time it opens) the person is asked to wait and Stripe is not asked.
// Everyone else is unaffected, the limit lifts by itself after the minute, and nothing breaks before the database part is
// set up (payments then work without the limit, and the log says what is missing).
const H = await import("./fn-harness.mjs");
const { users, hooks, urls, req, call, mk, reset, fns, LIMITS } = H;
const fx = await fns();
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
const stripeSince = (n0) => urls.slice(n0).filter(u => u.includes("api.stripe.com")).length;
const TOO_MANY = "Too many tries in a short time. Please wait a minute and try again.";
const refused = (r) => r.status === 429 && r.json && r.json.code === "too_many_tries" && r.json.error === TOO_MANY;
const fundIt = (c, token = "tok_cl") => call(fx.checkout, req("POST", "x", { token, body: { contract_id: c.id } }));
LIMITS.strict = true;

// ---------- R1: Fund: ten tries a minute work, the eleventh is refused before Stripe is asked ----------
{
  const c = mk(); const answers = [];
  for (let i = 0; i < 10; i++) answers.push((await fundIt(c)).status);
  const n0 = urls.length;
  const r = await fundIt(c);
  vuln(answers.some(s => s !== 200) || !refused(r) || stripeSince(n0),
    `R1 Fund pressed 11 times in a minute -> the first 10: ${[...new Set(answers)].join(",")}; the 11th: ${r.status} ${r.json && r.json.error} (${r.json && r.json.code}); Stripe asked for the 11th: ${stripeSince(n0)} (must be refused without asking Stripe)`);
}
// ---------- R2: everyone else is unaffected ----------
{
  const r = await fundIt(mk({ client: users.cl2.id }), "tok_cl2");
  vuln(r.status !== 200, `R2 another client presses Fund meanwhile -> ${r.status} ${r.json && r.json.error || ""} (must work)`);
}
// ---------- R3: the limit lifts by itself after the minute ----------
{
  for (const e of LIMITS.events) if (e.user_id === users.cl.id) e.at -= 61e3;
  const r = await fundIt(mk());
  vuln(r.status !== 200, `R3 a minute later the same client presses Fund -> ${r.status} ${r.json && r.json.error || ""} (must work again)`);
}
// ---------- R4: every payment button has the limit (10 a minute; the Payout details status 30) ----------
for (const [name, fn, token, body, method, max] of [
  ["Set up payouts (Payout details)", fx.connect, "tok_ed2", {}, "POST", 10],
  ["the Payout details status", fx.connect, "tok_ed2", undefined, "GET", 30],
  ["Approve & release", fx.release, "tok_cl2", { contract_id: "00000000-0000-0000-0000-000000000000" }, "POST", 10],
  ["Cancel and refund (freelancer)", fx.cancel, "tok_ed2", { contract_id: "00000000-0000-0000-0000-000000000000" }, "POST", 10],
  ["a dispute decision (admin)", fx.resolve, "tok_adm", { contract_id: "00000000-0000-0000-0000-000000000000", decision: "release" }, "POST", 10],
  ["the check after coming back from Stripe", fx.confirm, "tok_cl2", { contract_id: "00000000-0000-0000-0000-000000000000" }, "POST", 10],
]) {
  const opts = body === undefined ? { token } : { token, body };
  let early = 0;
  for (let i = 0; i < max; i++) if (refused(await call(fn, req(method, "x", opts)))) early++;
  const n0 = urls.length;
  const r = await call(fn, req(method, "x", opts));
  vuln(early || !refused(r) || stripeSince(n0),
    `R4 ${name}: ${max + 1} tries in a minute -> refused early: ${early}; try ${max + 1}: ${r.status} ${r.json && r.json.code}; Stripe asked: ${stripeSince(n0)}`);
}
// ---------- R5: before the database part is set up (schema v30 not run), payments keep working and the log says so ----------
{
  const logged = [], realError = console.error;
  console.error = (...a) => { logged.push(a.map(String).join(" ")); };
  hooks.rpc = (fn) => fn === "rate_limit_for" ? [404, { code: "PGRST202", message: "Could not find the function public.rate_limit_for(p_kind, p_max, p_seconds, p_user) in the schema cache" }] : null;
  const r = await fundIt(mk({ client: users.cl2.id }), "tok_cl2");
  reset(); console.error = realError;
  vuln(r.status !== 200 || !logged.some(l => l.includes("schema_v30.sql")), `R5 the limit not set up yet -> Fund ${r.status}; the log says what is missing: ${logged.some(l => l.includes("schema_v30.sql"))}`);
}
// ---------- R6: the database failing while counting: "something went wrong", and Stripe is not asked ----------
{
  hooks.rpc = (fn) => fn === "rate_limit_for" ? [503, { message: "connection reset" }] : null;
  const n0 = urls.length;
  const r = await fundIt(mk({ client: users.cl2.id }), "tok_cl2");
  reset();
  vuln(r.status !== 500 || (r.json && r.json.code) !== "server_error" || stripeSince(n0), `R6 the database fails while counting -> Fund ${r.status} ${r.json && r.json.code}; Stripe asked: ${stripeSince(n0)}`);
}

console.log(out.join("\n"));
const bad = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${bad} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(bad ? 1 : 0);
