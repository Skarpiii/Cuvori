// Stored XSS through chat: a client opens a chat with a professional, who then saves hostile messages (a plain one
// and an Order card with a made-up event and title). The client reopens the chat and must see them as text.
const { bad, asText, attacker, open, signUp, textOf, verdict, main } = require('./kit.js');

main(async () => {
  const { b, p } = await open(attacker());
  await signUp(p, 'Victim', 'victim@test.com');
  await p.goto(require('./kit.js').URL + '#home'); await p.waitForTimeout(900);
  await p.click('.real-card .message-person'); await p.waitForTimeout(900);
  const conv = await p.evaluate(() => window.__mockdb.conversations[0] && window.__mockdb.conversations[0].id);
  await p.evaluate(({ conv, m, c1, c2 }) => {
    const at = new Date().toISOString();
    window.__mockdb.messages.push({ id: 'm-atk1', conversation_id: conv, sender: 'atk', kind: 'text', body: m, created_at: at });
    window.__mockdb.messages.push({ id: 'm-atk2', conversation_id: conv, sender: 'atk', kind: 'contract', body: 'x', created_at: at,
      payload: { contract_id: 'cid1', title: c1, event: 'x' + c2 } });
  }, { conv, m: bad('M1'), c1: bad('M2'), c2: bad('M3') });
  // the client closes the chat and opens it again: the messages are read from the database and drawn
  await p.locator('.chat-window .close').first().click().catch(() => {}); await p.waitForTimeout(300);
  await p.click('.real-card .message-person'); await p.waitForTimeout(1000);
  const chat = await textOf(p, '.chat-window');
  await verdict(p, 'M1 a chat message', !!conv && chat.includes(asText('M1')), 'the message in the reopened chat');
  await verdict(p, 'M2 an Order card in the chat (title and event)', (await p.locator('.chat-window .contract-card').count()) > 0 && chat.includes(asText('M2')), 'the Order card in the reopened chat');
  await b.close();
});
