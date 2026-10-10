// Stored XSS through a professional's own data, where everyone browsing sees it: the card on the home page, the
// profile page, and a job on the Jobs page.
const { bad, asText, attacker, open, textOf, verdict, main } = require('./kit.js');

main(async () => {
  // A: a video's thumbnail address on the card. The page only takes plain https:// addresses, and escapes them too.
  { const { b, p } = await open(attacker({ extra: { projects: [{ id: 'pj1', owner: 'atk', title: 't', category: 'catOther', video_url: 'https://example.com/v.mp4',
      thumb_url: "https://example.com/a.jpg'\"><img src=y data-xss=\"A\">" + bad('A'), length_label: '', tags: [], pinned: false, position: 0, created_at: '2026-01-01T00:00:00Z' }] } }));
    const items = await p.locator('.real-card .card-gallery .car-item').count();
    await verdict(p, 'A a video thumbnail address on the browse card', items > 0, `${items} videos on the card`); await b.close(); }

  // B: the languages a professional speaks, on their profile page
  { const { b, p } = await open(attacker({ editor: { languages: [bad('B')] } }));
    await p.click('.real-card .view-profile'); await p.waitForTimeout(700);
    await verdict(p, 'B languages on the profile page', (await textOf(p, '#page-profile')).includes(asText('B')), 'the profile page with the languages'); await b.close(); }

  // C: a specialization (on the profile and in the service), on the card and the profile page. The page may also
  //    leave out a specialization it does not know: that is safe too, as long as the profile itself showed.
  { const { b, p } = await open(attacker({ editor: { specializations: [bad('C')] }, service: { values: { video_specialty: [bad('C')] } } }));
    const card = (await textOf(p, '.real-card')).includes('Atk');
    await p.click('.real-card .view-profile'); await p.waitForTimeout(700);
    await verdict(p, 'C a specialization on the card and the profile page', card && (await textOf(p, '#page-profile')).includes('Atk'), 'the card and the profile page'); await b.close(); }

  // D: a job's category, title, description and budget, on the Jobs page
  { const { b, p } = await open(attacker({ profile: { role: 'client' }, extra: { jobs: [{ id: 'jb1', owner: 'atk', title: bad('D1'), role_needed: 'editor', category: bad('D2'),
      description: bad('D3'), location: '', remote: true, pricing: 'project', budget: bad('D4'), deadline: null, status: 'open', created_at: '2026-01-01T00:00:00Z' }] } }), '#jobs');
    await verdict(p, 'D a job (title, category, description, budget) on the Jobs page',
      (await p.locator('#jobList [data-id="jb1"]').count()) === 1 && (await textOf(p, '#jobList')).includes(asText('D1')), 'the job on the Jobs page'); await b.close(); }
});
