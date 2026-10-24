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
// A1 the usual ways of writing an address, A2 not an address at all, A3 a key pasted into the wrong field, A4 ALLOWED_ORIGINS
// written loosely, A5 "*" and nonsense in ALLOWED_ORIGINS, A6 SUPABASE_URL, A7 what stays as it was (normal), A8 a line
// break or tab inside an address, A9 SITE_URL not set.
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
    const wh = (await import(root + "/netlify/functions/stripe-webhook.mjs")).default;
    out.webhook = (await wh(new Request("https://main--cuvori.netlify.app/.netlify/functions/stripe-webhook", { method: "POST", body: "{}" }))).status;
  } catch (e) { out.error = String(e && e.message); }
  console.log("RESULT " + JSON.stringify(out));`;
const load = (settings) => {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, T_ROOT: root, STRIPE_SECRET_KEY: "sk_test_abc123", SUPABASE_SERVICE_ROLE_KEY: "eyJ.a.b", STRIPE_WEBHOOK_SECRET: "whsec_x", URL: "https://cuvori.netlify.app", ...settings };
  for (const k of Object.keys(env)) if (env[k] === null) delete env[k];
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", CHILD], { env, encoding: "utf8", timeout: 30000 });
  const all = (r.stdout || "") + (r.stderr || "");
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
                           ["ALLOWED_ORIGINS", "https://cuvori.io,whsec_SECRETdoNotShow"], ["SUPABASE_URL", "sb_secret_SECRETdoNotShow"]]) {
    const r = load({ SITE_URL: "https://cuvori.io", [name]: v });
    const leaked = /SECRETdoNotShow|secretdonotshow/i.test(r.log + (r.body || "") + JSON.stringify(r.notes || ""));
    vuln(!works(r) || leaked || !noted(r, name), `A3 a key pasted into ${name} -> ${said(r)}; repeated anywhere: ${leaked ? "YES" : "no"}; admin note names ${name}: ${noted(r, name) ? "yes" : "no"} (must load, never repeat the key, name the setting)`);
  }
}
{ // A4 ALLOWED_ORIGINS written loosely: every entry read as an address
  const r = load({ SITE_URL: "https://cuvori.io", ALLOWED_ORIGINS: "cuvori.io, www.cuvori.io/ ;https://main--cuvori.netlify.app" });
  vuln(!works(r) || JSON.stringify(r.origins) !== JSON.stringify(["https://cuvori.io", "https://www.cuvori.io", "https://main--cuvori.netlify.app"]),
    `A4 ALLOWED_ORIGINS "cuvori.io, www.cuvori.io/ ;https://main--cuvori.netlify.app" -> ${said(r)} (must load with the three addresses)`);
  const lines = load({ SITE_URL: "https://cuvori.io", ALLOWED_ORIGINS: "https://cuvori.io\nhttps://www.cuvori.io" });
  vuln(!works(lines) || JSON.stringify(lines.origins) !== JSON.stringify(["https://cuvori.io", "https://www.cuvori.io"]),
    `A4b ALLOWED_ORIGINS on two lines -> ${said(lines)} (normal: one address per line, both kept)`);
}
{ // A5 "*" never lets every website in; nonsense is left out; nothing usable at all -> the default list
  const star = load({ SITE_URL: "https://cuvori.io", ALLOWED_ORIGINS: "*" });
  const mixed = load({ SITE_URL: "https://cuvori.io", ALLOWED_ORIGINS: "https://cuvori.io, not a website" });
  vuln(!works(star) || star.origins?.includes("*") || JSON.stringify(star.origins) !== JSON.stringify(["https://cuvori.io", "https://www.cuvori.io"]) || !noted(star, "ALLOWED_ORIGINS"),
    `A5a ALLOWED_ORIGINS "*" -> ${said(star)} (must load with Cuvori's own list, never every website, and say so)`);
  vuln(!works(mixed) || JSON.stringify(mixed.origins) !== JSON.stringify(["https://cuvori.io"]) || !noted(mixed, "ALLOWED_ORIGINS"),
    `A5b ALLOWED_ORIGINS "https://cuvori.io, not a website" -> ${said(mixed)} (must keep cuvori.io, leave the rest out, and say so)`);
}
{ // A6 SUPABASE_URL
  const a = load({ SITE_URL: "https://cuvori.io", SUPABASE_URL: "tnxujwlfatcvxzevllfr.supabase.co" });
  const b = load({ SITE_URL: "https://cuvori.io", SUPABASE_URL: "https://tnxujwlfatcvxzevllfr.supabase.co/rest/v1/" });
  const c = load({ SITE_URL: "https://cuvori.io", SUPABASE_URL: "my supabase" });
  const P = "https://tnxujwlfatcvxzevllfr.supabase.co";
  vuln(!works(a) || a.supabase !== P || !works(b) || b.supabase !== P || !works(c) || c.supabase !== P || !noted(c, "SUPABASE_URL"),
    `A6 SUPABASE_URL without https:// -> ${a.error || a.supabase}; with /rest/v1/ -> ${b.error || b.supabase}; "my supabase" -> ${c.error || c.supabase} (must load with the project address each time; the last one noted)`);
}
{ // A7 what stays as it was: correct settings give no note; local testing keeps http; a missing SITE_URL still uses Netlify's own address
  const ok = load({ SITE_URL: "https://cuvori.io" });
  const local = load({ SITE_URL: "localhost:8888", ALLOWED_ORIGINS: "http://localhost:8888,https://cuvori.io" });
  const none = load({ SITE_URL: null });
  vuln(!works(ok) || !Array.isArray(ok.notes) || ok.notes.length !== 0 || JSON.stringify(ok.origins) !== JSON.stringify(["https://cuvori.io", "https://www.cuvori.io"]) || !/"settingsNotes":\[\]/.test(ok.body || ""),
    `A7a correct settings -> ${said(ok)}; notes ${JSON.stringify(ok.notes)} (normal: no note)`);
  vuln(local.error || local.site !== "http://localhost:8888" || !local.origins?.includes("http://localhost:8888"), `A7b local testing, SITE_URL "localhost:8888" -> ${local.error || local.site} (normal: http://localhost:8888)`);
  vuln(none.error || none.site !== "https://cuvori.netlify.app", `A7c SITE_URL not set -> ${none.error || none.site} (normal: Netlify's own address, as before; A9 checks the note)`);
  const evil = load({ SITE_URL: "https://cuvori.io" });
  vuln(!works(evil), `A7d the page on cuvori.io may call the functions -> allow-origin ${evil.cors} (normal)`);
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
console.log(out.join("\n"));
const badN = out.filter(l => l.startsWith("VULNERABLE")).length;
console.log(`\n${badN} vulnerable, ${out.filter(l => l.startsWith("safe")).length} safe`);
process.exit(badN ? 1 : 0);
