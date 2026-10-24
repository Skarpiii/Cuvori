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
// The notes name the setting, never the address read from it (stripe-status is public).
// A1 the usual ways of writing an address, A2 not an address at all, A3 a key pasted into the wrong field, A4 ALLOWED_ORIGINS
// written loosely, A5 "*" and nonsense in ALLOWED_ORIGINS, A6 SUPABASE_URL, A7 what stays as it was (normal), A8 a line
// break or tab inside an address, A9 SITE_URL not set, A10 ALLOWED_ORIGINS can't lock the page out, A11 notes name the
// setting only, A12 an "@" inside an address (the part before it is a user name to a web address, so "cuvori.io@evil.com"
// means evil.com): never read as an address. A13 a character that is not a plain letter, digit or sign (an invisible one
// pasted along, a look-alike letter from another alphabet, a full-width dot): the address reader would quietly turn it into
// another website (cuvori.io + an invisible space + evil.com is cuvori.ioevil.com; a Cyrillic "о" in cuvori.io is a domain
// anyone can register), so it counts as not an address. A14 SITE_URL that leads somewhere other than cuvori.io (a typo, a
// password-like value, an address with a folder, whose folder is dropped): it is used, and the admin page says Stripe sends
// clients and freelancers to another website — without repeating it.
// Run: node tests/attack-settings.mjs
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = [];
const vuln = (cond, m) => out.push((cond ? "VULNERABLE " : "safe       ") + m);
// Loads the payment functions with these settings in a fresh process, asks stripe-status (as the page on cuvori.io does)
// and sends the webhook an unsigned event, and returns what they answered plus everything they wrote to the log.
const CHILD = `
  const root = process.env.T_ROOT, out = {};
  try {
    const lib = await import(root + "/netlify/lib/cuvori.mjs");
    Object.assign(out, { site: lib.SITE_URL, origins: lib.ALLOWED_ORIGINS, supabase: lib.SUPABASE_URL, notes: lib.SETTINGS_NOTES ?? null });
    const st = (await import(root + "/netlify/functions/stripe-status.mjs")).default;
    const r = await st(new Request("https://main--cuvori.netlify.app/.netlify/functions/stripe-status", { headers: { origin: "https://cuvori.io" } }));
    Object.assign(out, { status: r.status, cors: r.headers.get("access-control-allow-origin"), body: await r.text() });
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
    const leaked = /SECRETdoNotShow|secretdonotshow/i.test(r.log + (r.body || "") + JSON.stringify(r.notes || ""));
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
    `A11 three settings written the short way -> ${said(r)}; notes: ${JSON.stringify(r.notes).slice(0, 200)} (must name the three settings, and none of the addresses read from them)`);
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
  const OTHER = "a website other than cuvori.io";
  for (const [v, site] of [["cuvori.co", "https://cuvori.co"], ["MySECRETdoNotShow0.Secret", "https://mysecretdonotshow0.secret"], ["https://egidijus.github.io/cuvori/", "https://egidijus.github.io"], ["https://xn--cuvri-lye.io", "https://xn--cuvri-lye.io"]]) {
    const r = load({ SITE_URL: v });
    const shown = JSON.stringify(r.notes || []) + (r.body || "") + r.log;
    const repeated = /cuvori\.co[^a-z]|secretdonotshow|github|cuvri/i.test(shown);
    vuln(!works(r) || r.site !== site || !noted(r, "SITE_URL") || !r.notes.some(n => n.includes(OTHER)) || repeated,
      `A14 SITE_URL = ${JSON.stringify(v)} -> ${said(r)}; notes: ${r.notes ? JSON.stringify(r.notes).slice(0, 160) : "none"}; repeated: ${repeated ? "YES" : "no"} (must say Stripe sends people to ${OTHER}, never which one)`);
  }
  for (const v of ["cuvori.io", "https://www.cuvori.io", "https://cuvori.io/#home", "localhost:8888", "http://127.0.0.1:8888"]) {
    const r = load({ SITE_URL: v });
    vuln(r.error || (r.notes || []).some(n => n.includes(OTHER)), `A14b SITE_URL = ${JSON.stringify(v)} -> ${r.error || r.site}; notes ${JSON.stringify(r.notes)} (normal: no "other website" note)`);
  }
}
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
