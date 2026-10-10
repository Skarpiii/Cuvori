// Stored XSS through a credential on a profile: a javascript: link (it would run when clicked) and hostile text in
// the credential's name and issuer, on the profile's About tab.
const { bad, asText, attacker, open, textOf, verdict, main } = require('./kit.js');

main(async () => {
  const { b, p } = await open(attacker({ editor: { credentials: [
    { kind: 'course', title: 'Cred one', by: bad('K1'), year: 2025, link: 'javascript:window.__pwn=Object.assign(window.__pwn||{},{K2:1})' },
    { kind: 'course', title: bad('K3'), by: 'By', year: 2024, link: 'JaVaScRiPt:window.__pwn=1' }] } }));
  await p.click('.real-card .view-profile'); await p.waitForTimeout(700);
  await p.click('.ep-tab[data-tab="about"]'); await p.waitForTimeout(400);
  const about = await textOf(p, '#page-profile');
  await verdict(p, 'K a credential (javascript: link, name, issuer) on the profile', about.includes('Cred one') && about.includes(asText('K1')) && about.includes(asText('K3')), 'the credentials on the About tab');
  await b.close();
});
