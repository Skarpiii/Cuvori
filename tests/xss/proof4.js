// Stored XSS through a professional's name: on their card, their profile page and the Request quote window a
// signed-in client opens from it.
const { bad, asText, attacker, open, signUp, textOf, verdict, main } = require('./kit.js');

main(async () => {
  const { b, p } = await open(attacker({ editor: { display_name: 'Atk' + bad('Q') } }));
  await signUp(p, 'Vic', 'vic@test.com');
  await p.goto(require('./kit.js').URL + '#home'); await p.waitForTimeout(900);
  const card = (await textOf(p, '.real-card')).includes(asText('Q'));
  await p.click('.real-card .view-profile'); await p.waitForTimeout(700);
  const profile = (await textOf(p, '#page-profile')).includes(asText('Q'));
  await p.click('#epQuote'); await p.waitForTimeout(700);
  const quote = (await textOf(p, '#modalRoot')).length > 0;
  await verdict(p, 'Q a name on the card, the profile page and the Request quote window', card && profile && quote,
    `card ${card}, profile ${profile}, quote window ${quote}`);
  await b.close();
});
