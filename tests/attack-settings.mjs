// A web address written the way people write it in Netlify never stops the payment functions.
// SITE_URL (where Stripe sends the client back after paying), ALLOWED_ORIGINS (which websites may call the functions) and
// SUPABASE_URL were only accepted as complete addresses ("https://cuvori.io"). Anything else — "cuvori.io" without
// https://, "www.cuvori.io/", "https//cuvori.io", a path at the end, "*" — made netlify/lib/cuvori.mjs throw as it loaded,
// so every payment function, the Stripe webhook and the hourly job stopped at once until the setting was corrected, and
// only the Netlify log said why.
// Now those addresses are read the way people write them, and one that is not a web address at all is left out
// (ALLOWED_ORIGINS) or replaced by Cuvori's own address; the admin page says which setting to correct. What was typed is
// never written to the log or shown anywhere (a key pasted into the wrong field must not travel further), and "*" never
// lets every website in.
// A line break or a tab inside an address (a paste that wrapped, two lines in one field) is never glued together into a
// made-up address that Stripe would send clients to: it counts as not an address. And when SITE_URL is not set at all,
// the admin page says so, since Stripe then sends clients back to Netlify's own address, which may show an older page.
// ALLOWED_ORIGINS is split only at commas and semicolons, and the page's own addresses (SITE_URL, cuvori.io,
// www.cuvori.io) are always allowed, so no setting can lock the page out of its payment functions. SUPABASE_URL takes only a
// Supabase project address (….supabase.co, or a local one for testing): anything else would receive the secret database key.
// The notes name the setting, never the address read from it (stripe-status can be asked by anyone; since 1 November only
// a signed-in admin is given the notes).
// A1 the usual ways of writing an address, A2 not an address at all, A3 a key pasted into the wrong field, A4 ALLOWED_ORIGINS
// written loosely, A5 "*" and nonsense in ALLOWED_ORIGINS, A6 SUPABASE_URL, A7 what stays as it was (normal), A8 a line
// break or tab inside an address, A9 SITE_URL not set, A10 ALLOWED_ORIGINS can't lock the page out, A11 notes name the
// setting only, A12 an "@" inside an address (the part before it is a user name to a web address, so "cuvori.io@evil.com"
// means evil.com): never read as an address. A13 a character that is not a plain letter, digit or sign (an invisible one
// pasted along, a look-alike letter from another alphabet, a full-width dot): the address reader would quietly turn it into
// another website (cuvori.io + an invisible space + evil.com is cuvori.ioevil.com; a Cyrillic "о" in cuvori.io is a domain
// anyone can register), so it counts as not an address. A14 SITE_URL that leads somewhere other than cuvori.io (a typo, a
// password-like value, an address with a folder, whose folder is dropped): it is used, and the admin page says Stripe sends
// clients and freelancers to another website — without repeating it. A15 the notes go only to a signed-in admin; A15b not
// to someone signed in who is not an admin, nor to an admin who is banned (check of 1 December).
// Check of 22 November: A16 a webhook signing secret that can't be one (quotes around it, a line break, space or invisible
// character inside, another key pasted in its place): every notice from Stripe would be refused and nothing would say why;
// now the admin page names the setting, never the secret. A17 SITE_URL anything but https://cuvori.io or
// https://www.cuvori.io, also a test address on a computer (localhost) or cuvori.io with a port number, where Stripe would
// send clients after paying to a page that does not open: used, and the admin page says so, never which address.
// Check of 23 November: A18 an address setting written in a way production's older code (13 October) can't read — semicolons
// between the addresses in ALLOWED_ORIGINS, two slashes at the end, a list with no address in it — stopped every payment
// function there at its next deploy while this code said nothing; now the admin page says so, naming only the setting.
// Run: node tests/attack-settings.mjs
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = process.env.TARGET ? path.resolve(process.env.TARGET) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");   // the copy under test (TARGET), else this one
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
// Loads the payment functions with these settings in a fresh process, asks stripe-status (as the page on cuvori.io does:
// for anyone, and for a signed-in admin, who alone is given the settings notes since 1 November) and sends the webhook an
// unsigned event, and returns what they answered plus everything they wrote to the log. body: the admin's answer;
// publicBody: the answer anyone gets. The admin's sign-in is checked by a small stand-in for Supabase in the child.
const CHILD = `
  const root = process.env.T_ROOT, out = {};
  try {
    // who each sign-in is: an admin, a client (not an admin), an admin who is banned (check of 1 December)
    const ADMIN = "00000000-0000-4000-8000-0000000000ad", WHO = { admin_token: { is_admin: true, banned: false }, client_token: { is_admin: false, banned: false }, banned_admin_token: { is_admin: true, banned: true } };
    let token = null;
    globalThis.fetch = async (u, init = {}) => { const p = new URL(String(u)).pathname, ok = (d) => new Response(JSON.stringify(d), { status: 200, headers: { "content-type": "application/json" } });
      if (p === "/auth/v1/user") { token = String(new Headers(init.headers || {}).get("authorization") || "").replace(/^Bearer +/i, "")   /* (a plain space: this code is text inside a template, where a backslash is dropped) */; return WHO[token] ? ok({ id: ADMIN }) : new Response(JSON.stringify({ error_code: "bad_jwt" }), { status: 401, headers: { "content-type": "application/json" } }); }
      if (p === "/rest/v1/profiles") return ok([{ id: ADMIN, email: "a@t.com", first_name: "a", role: "client", ...WHO[token] }]);
      throw new TypeError("fetch failed"); };
    const lib = await import(root + "/netlify/lib/cuvori.mjs");
    Object.assign(out, { site: lib.SITE_URL, origins: lib.ALLOWED_ORIGINS, supabase: lib.SUPABASE_URL, notes: lib.SETTINGS_NOTES ?? null });
    const st = (await import(root + "/netlify/functions/stripe-status.mjs")).default;
    const r = await st(new Request("https://main--cuvori.netlify.app/.netlify/functions/stripe-status", { headers: { origin: "https://cuvori.io" } }));
    Object.assign(out, { status: r.status, cors: r.headers.get("access-control-allow-origin"), publicBody: await r.text() });
    const as = async (t) => (await st(new Request("https://main--cuvori.netlify.app/.netlify/functions/stripe-status", { headers: { origin: "https://cuvori.io", authorization: "Bearer " + t } }))).text();
    out.body = await as("admin_token"); out.clientBody = await as("client_token"); out.bannedBody = await as("banned_admin_token");
    // the same call from a stranger's website: no allow-origin, so the browser never lets that site read the answer
    out.corsStranger = (await st(new Request("https://main--cuvori.netlify.app/.netlify/functions/stripe-status", { headers: { origin: "https://evil.example" } }))).headers.get("access-control-allow-origin");
    const wh = (await import(root + "/netlify/functions/stripe-webhook.mjs")).default;
    out.webhook = (await wh(new Request("https://main--cuvori.netlify.app/.netlify/functions/stripe-webhook", { method: "POST", body: "{}" }))).status;
  } catch (e) { out.error = String(e && e.message); }
  console.log("RESULT " + JSON.stringify(out));`;
const load = (settings) => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, T_ROOT: root, STRIPE_SECRET_KEY: "sk_test_abc123", SUPABASE_SERVICE_ROLE_KEY: "eyJ.a.b", STRIPE_WEBHOOK_SECRET: "whsec_x", URL: "https://cuvori.netlify.app", ...settings };
  for (const k of Object.keys(env)) if (env[k] === null) delete env[k];
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD], { env, encoding: "utf8", timeout: 30000 });
  const all = (r.stdout || "").split("\n").filter(l => !l.startsWith("RESULT ")).join("\n") + (r.stderr || "");   // what the functions wrote, not this test's own report
  const line = (r.stdout || "").split("\n").find(l => l.startsWith("RESULT ")) || "RESULT {}";
  return { ...JSON.parse(line.slice(7)), log: all };
};
const works = (r) => !r.error && r.status === 200 && r.webhook === 400 && r.cors === "https://cuvori.io";
const said = (r) => r.error ? `stops: "${r.error}"` : `loads; SITE_URL ${r.site}, allowed ${JSON.stringify(r.origins)}, status ${r.status}, webhook ${r.webhook}`;
const noted = (r, name) => Array.isArray(r.notes) && r.notes.some(n => n.includes(name)) && (r.body || "").includes(name);

{ // A1 the ways people write cuvori.io
  for (const v of ["cuvori.io", "www.cuvori.io/", "https//cuvori.io", "https:/cuvori.io", "http://cuvori.io", "https://cuvori.io/orders?x=1#top", "  CUVORI.IO  ", "http://cuvori.io:80"]) {
    const r = load({ SITE_URL: v });
    const want = v.includes("www") ? "https://www.cuvori.io" : "https://cuvori.io";
    vuln(!works(r) || r.site !== want, `A1 SITE_URL written as ${JSON.stringify(v)} -> ${said(r)} (must load and read it as ${want})`);
  }
}
{ // A2 not a web address at all: replaced by Cuvori's own address, the admin page is told, nothing typed is repeated
  for (const v of ["cuvori io", "cuvori", "ftp://cuvori.io", "https://", "-"]) {
    const r = load({ SITE_URL: v });
    vuln(!works(r) || r.site !== "https://cuvori.io" || !noted(r, "SITE_URL"),
      `A2 SITE_URL written as ${JSON.stringify(v)} -> ${said(r)}; admin note: ${r.notes ? JSON.stringify(r.notes).slice(0, 140) : "none"} (must load, use https://cuvori.io, and say SITE_URL needs correcting)`);
  }
}
{ // A3 a key pasted into an address field: never repeated in the log or the status answer
  for (const [name, v] of [["SITE_URL", "sk_live_51SECRETdoNotShow0000"], ["SITE_URL", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRueHVqd2xmYXRjdnh6ZXZsbGZyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSJ9.SECRETdoNotShow"],
                           ["ALLOWED_ORIGINS", "https://cuvori.io,whsec_SECRETdoNotShow"], ["SUPABASE_URL", "sb_secret_SECRETdoNotShow"],
                           ["SITE_URL", "MySECRETdoNotShow0.Secret"], ["ALLOWED_ORIGINS", "https://cuvori.io,MySECRETdoNotShow0.Secret"], ["SUPABASE_URL", "MySECRETdoNotShow0.supabase.co"]]) {
    const r = load({ SITE_URL: "https://cuvori.io", [name]: v });
    const leaked = /SECRETdoNotShow|secretdonotshow/i.test(r.log + (r.body || "") + (r.publicBody || "") + JSON.stringify(r.notes || ""));
    vuln(!works(r) || leaked || !noted(r, name), `A3 a key pasted into ${name} -> ${said(r)}; repeated anywhere: ${leaked ? "YES" : "no"}; admin note names ${name}: ${noted(r, name) ? "yes" : "no"} (must load, never repeat the key, name the setting)`);
  }
}
{ // A4 ALLOWED_ORIGINS written loosely: every entry read as an address
  const r = load({ SITE_URL: "https://cuvori.io", ALLOWED_ORIGINS: "cuvori.io, www.cuvori.io/ ;https://main--cuvori.netlify.app" });
  vuln(!works(r) || JSON.stringify(r.origins) !== JSON.stringify(["https://cuvori.io", "https://www.cuvori.io", "https://main--cuvori.netlify.app"]),
    `A4 ALLOWED_ORIGINS "cuvori.io, www.cuvori.io/ ;https://main--cuvori.netlify.app" -> ${said(r)} (must load with the three addresses)`);
  const lines = load({ SITE_URL: "https://cuvori.io", ALLOWED_ORIGINS: "https://cuvori.io\nhttps://main--cuvori.netlify.app" });
  vuln(!works(lines) || JSON.stringify(lines.origins) !== JSON.stringify(["https://cuvori.io", "https://www.cuvori.io"]) || !noted(lines, "ALLOWED_ORIGINS"),
    `A4b ALLOWED_ORIGINS on two lines (no comma) -> ${said(lines)} (must be one entry with a line break inside, left out with a note; the page's own addresses stay allowed)`);
}
{ // A5 "*" never lets every website in; nonsense is left out; nothing usable at all -> the default list
  const star = load({ SITE_URL: "https://cuvori.io", ALLOWED_ORIGINS: "*" });
  const mixed = load({ SITE_URL: "https://cuvori.io", ALLOWED_ORIGINS: "https://cuvori.io, not a website" });
  vuln(!works(star) || star.origins?.includes("*") || JSON.stringify(star.origins) !== JSON.stringify(["https://cuvori.io", "https://www.cuvori.io"]) || !noted(star, "ALLOWED_ORIGINS"),
    `A5a ALLOWED_ORIGINS "*" -> ${said(star)} (must load with Cuvori's own list, never every website, and say so)`);
  vuln(!works(mixed) || JSON.stringify(mixed.origins) !== JSON.stringify(["https://cuvori.io", "https://www.cuvori.io"]) || !noted(mixed, "ALLOWED_ORIGINS"),
    `A5b ALLOWED_ORIGINS "https://cuvori.io, not a website" -> ${said(mixed)} (must keep the page's own addresses, leave the rest out, and say so)`);
}
{ // A6 SUPABASE_URL
  const a = load({ SITE_URL: "https://cuvori.io", SUPABASE_URL: "tnxujwlfatcvxzevllfr.supabase.co" });
  const b = load({ SITE_URL: "https://cuvori.io", SUPABASE_URL: "https://tnxujwlfatcvxzevllfr.supabase.co/rest/v1/" });
  const c = load({ SITE_URL: "https://cuvori.io", SUPABASE_URL: "my supabase" });
  const P = "https://tnxujwlfatcvxzevllfr.supabase.co";
  vuln(!works(a) || a.supabase !== P || !works(b) || b.supabase !== P || !works(c) || c.supabase !== P || !noted(c, "SUPABASE_URL"),
    `A6 SUPABASE_URL without https:// -> ${a.error || a.supabase}; with /rest/v1/ -> ${b.error || b.supabase}; "my supabase" -> ${c.error || c.supabase} (must load with the project address each time; the last one noted)`);
  // the Supabase dashboard's own address pasted in, or any other website: never given the secret database key
  const d = load({ SITE_URL: "https://cuvori.io", SUPABASE_URL: "https://supabase.com/dashboard/project/tnxujwlfatcvxzevllfr/settings/api" });
  const e = load({ SITE_URL: "https://cuvori.io", SUPABASE_URL: "https://evil.example" });
  const f = load({ SITE_URL: "https://cuvori.io", SUPABASE_URL: "http://localhost:54321" });
  vuln(d.supabase !== P || !noted(d, "SUPABASE_URL") || e.supabase !== P || !noted(e, "SUPABASE_URL") || f.supabase !== "http://localhost:54321",
    `A6b SUPABASE_URL the dashboard's address -> ${d.error || d.supabase}; another website -> ${e.error || e.supabase}; local testing -> ${f.error || f.supabase} (must use the project address for the first two, with a note; local stays)`);
}
{ // A7 what stays as it was: correct settings give no note; local testing keeps http; a missing SITE_URL still uses Netlify's own address
  const ok = load({ SITE_URL: "https://cuvori.io" });
  const local = load({ SITE_URL: "localhost:8888", ALLOWED_ORIGINS: "http://localhost:8888,https://cuvori.io" });
  const none = load({ SITE_URL: null });
  vuln(!works(ok) || !Array.isArray(ok.notes) || ok.notes.length !== 0 || JSON.stringify(ok.origins) !== JSON.stringify(["https://cuvori.io", "https://www.cuvori.io"]) || !/"settingsNotes":\[\]/.test(ok.body || ""),
    `A7a correct settings -> ${said(ok)}; notes ${JSON.stringify(ok.notes)} (normal: no note)`);
  vuln(local.error || local.site !== "http://localhost:8888" || !local.origins?.includes("http://localhost:8888"), `A7b local testing, SITE_URL "localhost:8888" -> ${local.error || local.site} (normal: http://localhost:8888)`);
  vuln(none.error || none.site !== "https://cuvori.netlify.app", `A7c SITE_URL not set -> ${none.error || none.site} (normal: Netlify's own address, as before; A9 checks the note)`);
  const evil = load({ SITE_URL: "https://cuvori.io", ALLOWED_ORIGINS: "https://main--cuvori.netlify.app" });
  vuln(!works(evil) || evil.corsStranger !== null, `A7d the page on cuvori.io may call the functions (allow-origin ${evil.cors}); a stranger's website may not (allow-origin ${evil.corsStranger}) (normal: cuvori.io yes, the stranger null)`);
}
{ // A8 a line break or a tab inside an address is never glued into a made-up one
  for (const [name, v] of [["SITE_URL", "cuvori.io\nwww.cuvori.io"], ["SITE_URL", "cuvori\t.io"], ["SITE_URL", "https://cuvo\r\nri.io"], ["SUPABASE_URL", "tnxujwlfatcvxzevllfr.supa\nbase.co"]]) {
    const r = load({ SITE_URL: "https://cuvori.io", [name]: v });
    const used = name === "SITE_URL" ? r.site : r.supabase, want = name === "SITE_URL" ? "https://cuvori.io" : "https://tnxujwlfatcvxzevllfr.supabase.co";
    vuln(!works(r) || used !== want || !noted(r, name) || !r.notes.some(n => n.includes("is not a web address")),
      `A8 ${name} with a line break or tab inside (${JSON.stringify(v)}) -> ${r.error || used}; note: ${r.notes ? JSON.stringify(r.notes).slice(0, 110) : "none"} (must use ${want} and say ${name} is not a web address, never a glued-together address)`);
  }
}
{ // A9 SITE_URL not set: Netlify's own address is used as before, and the admin page says so
  const r = load({ SITE_URL: null });
  vuln(!works(r) || r.site !== "https://cuvori.netlify.app" || !noted(r, "SITE_URL") || !r.notes.some(n => n.includes("not set") && n.includes("https://cuvori.netlify.app")),
    `A9 SITE_URL not set -> ${said(r)}; note: ${r.notes ? JSON.stringify(r.notes).slice(0, 140) : "none"} (must say SITE_URL is not set and where Stripe sends clients back)`);
}
{ // A10 ALLOWED_ORIGINS can never lock the page out of its payment functions, nor let a fragment of a wrapped paste in
  const wrapped = load({ SITE_URL: "https://cuvori.io", ALLOWED_ORIGINS: "https://cuvo\nri.io" });
  vuln(!works(wrapped) || wrapped.origins?.includes("https://ri.io") || !noted(wrapped, "ALLOWED_ORIGINS"),
    `A10a ALLOWED_ORIGINS "https://cuvo⏎ri.io" (a wrapped paste) -> ${said(wrapped)} (must not allow ri.io; cuvori.io must still work; a note)`);
  const spaced = load({ SITE_URL: "https://cuvori.io", ALLOWED_ORIGINS: "https://cuvo ri.io" });
  vuln(!works(spaced) || spaced.origins?.includes("https://ri.io"), `A10b ALLOWED_ORIGINS "https://cuvo ri.io" -> ${said(spaced)} (must not allow ri.io; cuvori.io must still work)`);
  const other = load({ SITE_URL: "https://cuvori.io", ALLOWED_ORIGINS: "https://main--cuvori.netlify.app" });
  vuln(!works(other) || JSON.stringify(other.origins) !== JSON.stringify(["https://cuvori.io", "https://www.cuvori.io", "https://main--cuvori.netlify.app"]) || other.notes.length,
    `A10c ALLOWED_ORIGINS with only another address -> ${said(other)}; notes ${JSON.stringify(other.notes)} (normal: that address is added, cuvori.io stays allowed, no note)`);
}
{ // A11 the notes (shown by the public stripe-status) name the setting, never the address read from it
  const r = load({ SITE_URL: "www.cuvori.io/", ALLOWED_ORIGINS: "main--cuvori.netlify.app", SUPABASE_URL: "tnxujwlfatcvxzevllfr.supabase.co" });
  const shown = JSON.stringify(r.notes || []) + (r.body || "");
  vuln(!works(r) || r.site !== "https://www.cuvori.io" || !noted(r, "SITE_URL") || !noted(r, "ALLOWED_ORIGINS") || !noted(r, "SUPABASE_URL") || /www\.cuvori\.io|main--cuvori|tnxujwlfatcvxzevllfr/.test(shown),
    `A11 three settings written the short way -> ${said(r)}; notes: ${r.notes ? JSON.stringify(r.notes).slice(0, 200) : "none"} (must name the three settings, and none of the addresses read from them)`);
}
{ // A12 an "@" inside an address: "cuvori.io@evil.com" is the website evil.com, so it is never used
  for (const [name, v] of [["SITE_URL", "cuvori.io@evil.com"], ["SITE_URL", "https://cuvori.io@evil.com"], ["ALLOWED_ORIGINS", "cuvori.io@evil.com"], ["SUPABASE_URL", "x@other-project.supabase.co"]]) {
    const r = load({ SITE_URL: "https://cuvori.io", [name]: v });
    const bad = name === "SITE_URL" ? r.site !== "https://cuvori.io" : name === "ALLOWED_ORIGINS" ? (r.origins || []).some(o => /evil/.test(o)) : r.supabase !== "https://tnxujwlfatcvxzevllfr.supabase.co";
    vuln(!works(r) || bad || !noted(r, name), `A12 ${name} = ${JSON.stringify(v)} -> ${said(r)}${name === "SUPABASE_URL" ? ", database " + r.supabase : ""} (must never use the address after the "@"; a note names ${name})`);
  }
}
{ // A13 a character that is not a plain letter, digit or sign: never turned into another website
  const cases = [["SITE_URL", "cuvori.io\u200bevil.com"], ["SITE_URL", "https://cuvori.io\u200bevil.com"], ["SITE_URL", "cuvori.io\u3002evil.com"], ["SITE_URL", "cuvori.io\uff0eevil.com"],
                 ["SITE_URL", "cuv\u043eri.io"], ["SITE_URL", "https://cuv\u043eri.io"], ["SITE_URL", "cuvori.io\u00ad"],
                 ["SUPABASE_URL", "other\u200bproject.supabase.co"], ["ALLOWED_ORIGINS", "https://cuvori.io\u200bevil.com"], ["ALLOWED_ORIGINS", "main--cuv\u043eri.netlify.app"]];
  for (const [name, v] of cases) {
    const r = load({ SITE_URL: "https://cuvori.io", [name]: v });
    const bad = name === "SITE_URL" ? r.site !== "https://cuvori.io" : name === "SUPABASE_URL" ? r.supabase !== "https://tnxujwlfatcvxzevllfr.supabase.co"
      : JSON.stringify(r.origins) !== JSON.stringify(["https://cuvori.io", "https://www.cuvori.io"]);
    const why = name === "ALLOWED_ORIGINS" ? "not one web address" : "is not a web address";
    vuln(!works(r) || bad || !noted(r, name) || !r.notes.some(n => n.includes(why)),
      `A13 ${name} = ${JSON.stringify(v)} -> ${said(r)}${name === "SUPABASE_URL" ? ", database " + r.supabase : ""}; note: ${r.notes ? JSON.stringify(r.notes).slice(0, 110) : "none"} (must count as not a web address: ${name === "ALLOWED_ORIGINS" ? "left out" : "Cuvori's own address used"}, with a note)`);
  }
}
{ // A14 SITE_URL leads to a website other than cuvori.io: used, and the admin page says so without repeating it
  const OTHER = /a website other than cuvori\.io|is not Cuvori's own address/;   // the note before and since 22 November
  for (const [v, site] of [["cuvori.co", "https://cuvori.co"], ["MySECRETdoNotShow0.Secret", "https://mysecretdonotshow0.secret"], ["https://egidijus.github.io/cuvori/", "https://egidijus.github.io"], ["https://xn--cuvri-lye.io", "https://xn--cuvri-lye.io"]]) {
    const r = load({ SITE_URL: v });
    const shown = JSON.stringify(r.notes || []) + (r.body || "") + r.log;
    const repeated = /cuvori\.co[^a-z]|secretdonotshow|github|cuvri/i.test(shown);
    vuln(!works(r) || r.site !== site || !noted(r, "SITE_URL") || !r.notes.some(n => OTHER.test(n)) || repeated,
      `A14 SITE_URL = ${JSON.stringify(v)} -> ${said(r)}; notes: ${r.notes ? JSON.stringify(r.notes).slice(0, 160) : "none"}; repeated: ${repeated ? "YES" : "no"} (must say Stripe sends people to ${OTHER}, never which one)`);
  }
  for (const v of ["cuvori.io", "https://www.cuvori.io", "https://cuvori.io/#home"]) {      // a test address on a computer: A17
    const r = load({ SITE_URL: v });
    vuln(r.error || (r.notes || []).some(n => OTHER.test(n)), `A14b SITE_URL = ${JSON.stringify(v)} -> ${r.error || r.site}; notes ${JSON.stringify(r.notes)} (normal: no "other website" note)`);
  }
}
{ // A15 the settings notes go to a signed-in admin only: the answer anyone gets says what the page needs, never the notes
  const r = load({ SITE_URL: "cuvori.co", ALLOWED_ORIGINS: "*" });
  let pub = {}; try { pub = JSON.parse(r.publicBody || "{}"); } catch {}
  vuln(!works(r) || !noted(r, "SITE_URL") || /SITE_URL|ALLOWED_ORIGINS|settingsNotes/.test(r.publicBody || "") || pub.escrow !== true || pub.autoReleaseDays !== 7 || pub.stripeKeyOk !== true || pub.databaseKeyOk !== true,
    `A15 two settings to correct -> the admin is told: ${noted(r, "SITE_URL") ? "yes" : "no"}; anyone else gets ${r.publicBody} (must be only escrow, the two key checks and the days, no notes)`);
  const told = (b) => /SITE_URL|ALLOWED_ORIGINS|settingsNotes/.test(b || "");
  vuln(!works(r) || !noted(r, "SITE_URL") || told(r.clientBody) || told(r.bannedBody),
    `A15b the same, asked with a sign-in -> a client (not an admin) is told: ${told(r.clientBody) ? "YES" : "no"}; a banned admin is told: ${told(r.bannedBody) ? "YES" : "no"}; the admin: ${noted(r, "SITE_URL") ? "yes" : "no"} (must be the admin only)`);
}
{ // A16 (check of 22 November) a webhook signing secret that can't be one: every notice from Stripe would be refused, and
  // nothing would say why. The admin page names the setting; the secret is never shown or written to the log; payments stay on.
  const GOOD = "whsec_" + "Ab1".repeat(11), CLI = "whsec_" + "0123456789abcdef".repeat(4), SIGNS = "whsec_Ab1+Cd2/Ef3_Gh4-Ij5=";
  const WH = /STRIPE_(CONNECT_)?WEBHOOK_SECRET/;
  for (const [label, sec] of [["as Stripe's dashboard shows them", GOOD], ["from the Stripe CLI", CLI], ["with spaces and a line break at the ends", `  ${GOOD} \n`], ["with the signs a base64 secret may hold (+ / = _ -)", SIGNS]]) {
    const r = load({ SITE_URL: "https://cuvori.io", STRIPE_WEBHOOK_SECRET: sec, STRIPE_CONNECT_WEBHOOK_SECRET: sec });
    vuln(!works(r) || (r.notes || []).some(n => WH.test(n)), `A16a both webhook secrets ${label} -> notes ${JSON.stringify(r.notes)} (normal: no note)`);
  }
  for (const [name, label, sec] of [
    ["STRIPE_WEBHOOK_SECRET", "with quotes around it", '"whsec_SECRETdoNotShow00000000000"'],
    ["STRIPE_WEBHOOK_SECRET", "wrapped onto two lines", "whsec_SECRETdoNot\nShow00000000000"],
    ["STRIPE_WEBHOOK_SECRET", "with a space inside", "whsec_SECRETdoNot Show00000000000"],
    ["STRIPE_WEBHOOK_SECRET", "with an invisible character inside", "whsec_SECRETdoNot\u200bShow0000000000"],
    ["STRIPE_WEBHOOK_SECRET", "with the Stripe secret key pasted in its place", "sk_live_51SECRETdoNotShow0000"],
    ["STRIPE_CONNECT_WEBHOOK_SECRET", "with quotes around it", "'whsec_SECRETdoNotShow00000000000'"],
    ["STRIPE_CONNECT_WEBHOOK_SECRET", "with the publishable key pasted in its place", "pk_live_51SECRETdoNotShow0000"]]) {
    const r = load({ SITE_URL: "https://cuvori.io", STRIPE_WEBHOOK_SECRET: GOOD, STRIPE_CONNECT_WEBHOOK_SECRET: GOOD, [name]: sec });
    const other = name === "STRIPE_WEBHOOK_SECRET" ? "STRIPE_CONNECT_WEBHOOK_SECRET" : "STRIPE_WEBHOOK_SECRET";
    const named = (r.notes || []).some(n => n.startsWith(name + " ")) && (r.body || "").includes(name);
    const wrongOne = (r.notes || []).some(n => n.startsWith(other + " "));
    const leaked = /SECRETdoNot|secretdonot|Show0000/i.test(r.log + (r.body || "") + (r.publicBody || "") + JSON.stringify(r.notes || ""));
    const on = /"escrow":true/.test(r.body || "");
    vuln(!works(r) || !named || wrongOne || leaked || !on,
      `A16 ${name} ${label} -> the admin is told which setting: ${named ? "yes" : "no"}${wrongOne ? " (and the other one too)" : ""}; the secret shown or logged: ${leaked ? "YES" : "no"}; payments on: ${on ? "yes" : "no"} (must name it, never show it)`);
  }
}
{ // A17 (check of 22 November) SITE_URL anything but Cuvori's own address, also a test address on a computer or cuvori.io with a
  // port number: Stripe would send clients there after paying, to a page that does not open. Used, and the admin page says so.
  const SAYS = /is not Cuvori's own address|a website other than cuvori\.io/;
  for (const [v, site] of [["http://localhost:8888", "http://localhost:8888"], ["localhost:8888", "http://localhost:8888"], ["http://127.0.0.1:8888", "http://127.0.0.1:8888"],
                           ["https://cuvori.io:8443", "https://cuvori.io:8443"], ["https://www.cuvori.io:8443", "https://www.cuvori.io:8443"]]) {
    const r = load({ SITE_URL: v });
    const repeated = /8888|8443|localhost|127\.0\.0\.1/.test(JSON.stringify(r.notes || []) + (r.body || "") + r.log);
    vuln(!works(r) || r.site !== site || !noted(r, "SITE_URL") || !r.notes.some(n => SAYS.test(n)) || repeated,
      `A17 SITE_URL = ${JSON.stringify(v)} -> ${said(r)}; notes: ${r.notes ? JSON.stringify(r.notes).slice(0, 160) : "none"}; repeated: ${repeated ? "YES" : "no"} (must be used, and the admin told it is not Cuvori's own address, never which one)`);
  }
  for (const v of ["https://cuvori.io", "https://www.cuvori.io", "cuvori.io", "https://cuvori.io:443", "http://www.cuvori.io:80"]) {
    const r = load({ SITE_URL: v });
    vuln(r.error || (r.notes || []).some(n => SAYS.test(n)), `A17b SITE_URL = ${JSON.stringify(v)} -> ${r.error || r.site}; notes ${JSON.stringify(r.notes)} (normal: no such note)`);
  }
}
{ // A18 (check of 23 November) an address setting written in a way production's older code can't read. Production
  // (cuvori.netlify.app) still runs the code of 13 October, which reads SITE_URL, SUPABASE_URL and ALLOWED_ORIGINS strictly and
  // stops at startup on any other way of writing them: every payment function there, and the hourly payouts with them. Netlify
  // gives production a changed setting only when it is deployed again, and SETUP.md (Part 3, item 7) says to do just that after
  // changing one; so a setting this code reads without a word stopped production at that deploy: semicolons between the
  // addresses in ALLOWED_ORIGINS (which a comment here said were fine), two slashes at the end of an address, a list with no
  // address in it. Now the admin page says so, naming only the setting, and this code still reads it as before.
  // OLD_ONE and OLD: production's own rule, copied from netlify/lib/cuvori.mjs at commit 7131dd0 (configuredOrigin, and the
  // line that splits ALLOWED_ORIGINS): true when that code loads with the setting.
  const OLD_ONE = (value) => { let url; try { url = new URL(value); } catch { return false; }
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return !((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.pathname !== "/" || url.search || url.hash); };
  const OLD = (name, value) => { const v = value.trim(); if (name !== "ALLOWED_ORIGINS") return OLD_ONE(v);
    const list = v.split(",").map(s => s.trim()).filter(Boolean); return list.length > 0 && list.every(OLD_ONE); };
  const prodNotes = (notes, name) => (notes || []).filter(n => n.startsWith(name + " ") && /production/.test(n));
  const P = "https://tnxujwlfatcvxzevllfr.supabase.co", OWN = ["https://cuvori.io", "https://www.cuvori.io"], MAIN = [...OWN, "https://main--cuvori.netlify.app"];
  const texts = {};
  // a: production stops on these; this code must load, read them as before, and tell the admin, once, naming the setting only
  for (const [name, v, want] of [
    ["ALLOWED_ORIGINS", "https://cuvori.io;https://main--cuvori.netlify.app", MAIN], ["ALLOWED_ORIGINS", "https://cuvori.io; https://main--cuvori.netlify.app", MAIN],
    ["ALLOWED_ORIGINS", "https://main--cuvori.netlify.app//", MAIN], ["ALLOWED_ORIGINS", ",", OWN], ["ALLOWED_ORIGINS", ";;", OWN],
    ["SITE_URL", "https://cuvori.io//", "https://cuvori.io"], ["SITE_URL", "HTTPS://WWW.CUVORI.IO///", "https://www.cuvori.io"], ["SUPABASE_URL", P + "//", P],
    ["SITE_URL", "cuvori.io", "https://cuvori.io"], ["ALLOWED_ORIGINS", "*", OWN], ["SUPABASE_URL", "my supabase", P], ["ALLOWED_ORIGINS", "cuvori.io;main--cuvori.netlify.app/", MAIN]]) {
    const r = load({ SITE_URL: "https://cuvori.io", [name]: v });
    const read = name === "SITE_URL" ? r.site : name === "SUPABASE_URL" ? r.supabase : r.origins;
    const mine = prodNotes(r.notes, name), all = (r.notes || []).filter(n => n.startsWith(name + " "));
    for (const n of mine) (texts[name] = texts[name] || new Set()).add(n);
    const told = mine.length === 1 && (r.body || "").includes(JSON.stringify(mine[0]).slice(1, -1)) && mine[0].length <= 400 && (name !== "ALLOWED_ORIGINS" || /commas/.test(mine[0]));
    const twice = all.filter(n => /full/.test(n)).length > 1;   // "write it in full", "not written as a full web address"
    vuln(OLD(name, v) || !works(r) || JSON.stringify(read) !== JSON.stringify(want) || !told || twice,
      `A18 ${name} = ${JSON.stringify(v)} (production's code: ${OLD(name, v) ? "loads" : "stops"}) -> ${said(r)}; the admin told production can't read it: ${told ? "yes" : "no"}${twice ? " (and told twice to write it in full)" : ""}; notes: ${r.notes ? JSON.stringify(r.notes).slice(0, 220) : "none"} (must load and read it as before, and say so once, in at most 400 characters, the page's limit)`);
  }
  for (const [name, set] of Object.entries(texts))   // one text per setting: nothing typed in the setting gets into the note
    vuln(set.size !== 1, `A18 the note for ${name} is the same whatever was typed: ${set.size === 1 ? "yes" : "no, " + set.size + " texts"} (must be one text, so nothing typed is repeated)`);
  // b: the ways production's code reads: no such note
  for (const [name, v] of [["SITE_URL", "https://cuvori.io"], ["SITE_URL", "https://cuvori.io/"], ["SITE_URL", "HTTPS://CUVORI.IO"], ["SITE_URL", "https://www.cuvori.io/"], ["SITE_URL", null],
    ["ALLOWED_ORIGINS", "https://cuvori.io,https://www.cuvori.io"], ["ALLOWED_ORIGINS", " https://cuvori.io , https://main--cuvori.netlify.app/ ,"], ["ALLOWED_ORIGINS", "http://localhost:8888,https://cuvori.io"],
    ["SUPABASE_URL", P], ["SUPABASE_URL", P + "/"]]) {
    const r = load({ SITE_URL: "https://cuvori.io", [name]: v });
    const any = ["SITE_URL", "URL", "SUPABASE_URL", "ALLOWED_ORIGINS"].flatMap(k => prodNotes(r.notes, k));
    vuln(!works(r) || any.length, `A18b ${name} = ${JSON.stringify(v)} -> ${said(r)}; notes ${JSON.stringify(r.notes)} (normal: no note about production)`);
  }
  // c: the note comes exactly when production's code would stop: 633 ways of writing the three settings, each loaded on its own
  const SWEEP = `
    const { pathToFileURL } = await import("node:url"), cases = JSON.parse(process.env.T_CASES), res = [], quiet = console.error;
    const base = { URL: "https://cuvori.netlify.app", SITE_URL: "https://cuvori.io", STRIPE_SECRET_KEY: "sk_test_abc123", SUPABASE_SERVICE_ROLE_KEY: "eyJ.a.b", STRIPE_WEBHOOK_SECRET: "whsec_x" };
    console.error = () => {};
    for (let i = 0; i < cases.length; i++) {
      for (const k of ["SITE_URL", "SUPABASE_URL", "ALLOWED_ORIGINS"]) delete process.env[k];
      Object.assign(process.env, base, { [cases[i][0]]: cases[i][1] });
      try { res.push({ notes: (await import(pathToFileURL(process.env.T_ROOT + "/netlify/lib/cuvori.mjs").href + "?case=" + i)).SETTINGS_NOTES }); }
      catch (e) { res.push({ error: String(e && e.message) }); }
    }
    console.error = quiet; console.log("RESULT " + JSON.stringify(res));`;
  const cases = [];
  for (const p of ["https://", "HTTPS://", "Https://", "https:", "https:/", "https:///", "//", "", "http://"])
    for (const s of ["", "/", "//", "///", "/.", "/./", "/x", "?", "/?", "#", "/#", "?a=1", ":443", ":8443", "\\", "/\\", ".", "/%2e", ":", "/;", ";"])
      cases.push(["SITE_URL", p + "cuvori.io" + s], ["SUPABASE_URL", p + "tnxujwlfatcvxzevllfr.supabase.co" + s], ["ALLOWED_ORIGINS", p + "main--cuvori.netlify.app" + s]);
  for (const sep of [",", ", ", " ,", ";", "; ", " ; ", ",,", ";,", ",;", "\n", "\r\n", " ", "\t", "|", "\uff0c", "\uff1b", " and "])
    for (const [a, b] of [["https://cuvori.io", "https://www.cuvori.io"], ["https://cuvori.io", "https://main--cuvori.netlify.app"], ["http://localhost:8888", "https://cuvori.io"]])
      cases.push(["ALLOWED_ORIGINS", a + sep + b]);
  for (const v of [",", ";", ",,", ", ,", ";;", " , ; ", "https://cuvori.io,", ",https://cuvori.io", "https://cuvori.io;", ";https://cuvori.io", "https://cuvori.io,,https://www.cuvori.io", "https://cuvori.io, ,https://www.cuvori.io", "*", "https://*.cuvori.io", "null"])
    cases.push(["ALLOWED_ORIGINS", v]);
  const sw = spawnSync(process.execPath, ["--input-type=module", "-e", SWEEP], { env: { PATH: process.env.PATH, HOME: process.env.HOME, T_ROOT: root, T_CASES: JSON.stringify(cases) }, encoding: "utf8", timeout: 120000, maxBuffer: 64 << 20 });
  const res = JSON.parse(((sw.stdout || "").split("\n").find(l => l.startsWith("RESULT ")) || "RESULT []").slice(7));
  const wrong = cases.map(([name, v], i) => ({ name, v, stops: !OLD(name, v), r: res[i] || { error: "no answer" } }))
    .filter(c => c.r.error || (prodNotes(c.r.notes, c.name).length === 1) !== c.stops || prodNotes(c.r.notes, c.name).length > 1);
  const stopsN = cases.filter(([name, v]) => !OLD(name, v)).length;
  vuln(res.length !== cases.length || wrong.length, `A18c ${cases.length} ways of writing the three settings (production's code stops on ${stopsN}) -> ${res.length} loaded; told wrongly: ${wrong.length}${wrong.length ? ", e.g. " + wrong.slice(0, 4).map(c => `${c.name}=${JSON.stringify(c.v)} (production ${c.stops ? "stops" : "loads"}; ${c.r.error ? "this code stops: " + c.r.error : "notes " + JSON.stringify(c.r.notes).slice(0, 90)})`).join("; ") : ""} (must be told exactly when production's code stops, and this code never stops)`);
  // d: everything wrong at once: every note still reaches the admin page whole (it shows at most 10, each up to 400 characters)
  const r = load({ SITE_URL: "cuvori io", SUPABASE_URL: "my supabase", ALLOWED_ORIGINS: "*;cuvori.io", STRIPE_WEBHOOK_SECRET: '"whsec_x"', STRIPE_CONNECT_WEBHOOK_SECRET: "sk_live_x" });
  vuln(!works(r) || !r.notes || r.notes.length > 10 || r.notes.some(n => n.length > 400) || ["SITE_URL", "SUPABASE_URL", "ALLOWED_ORIGINS"].some(k => prodNotes(r.notes, k).length !== 1),
    `A18d five settings wrong at once -> ${said(r)}; ${r.notes ? r.notes.length : 0} notes, the longest ${r.notes ? Math.max(0, ...r.notes.map(n => n.length)) : 0} characters (must be at most 10, each at most 400, with the production note for each address setting)`);
}
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
