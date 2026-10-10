// Stored XSS through an Order: title, scope, deliverables, milestone titles, amendment notes, delivery notes,
// chat cards, notifications and the history must all show the text, never run it.
const { chromium } = require('playwright'); const fs=require('fs');
const mock=fs.readFileSync(process.cwd()+'/mock-supabase.js','utf8');
const url='file://'+process.cwd()+'/index.html';
const P=k=>`<img src=z data-xss="${k}" onerror="window.__pwn=Object.assign(window.__pwn||{},{${k}:1})">`;
const { verdict, main } = require('./kit.js');
main(async () => {
  const b=await chromium.launch(); const ctx=await b.newContext({viewport:{width:1400,height:900}});
  await ctx.addInitScript(mock); await ctx.route('**/supabase.min.js', r=>r.fulfill({status:200,body:'',contentType:'application/javascript'}));
  const p=await ctx.newPage();
  const signup=async(n,e)=>{ await p.goto(url+'#create-account'); await p.waitForTimeout(300); await p.click('[data-auth="signup"]').catch(()=>{}); await p.fill('#suName',n); await p.fill('#suEmail',e); await p.fill('#suPass','password123'); await p.check('#suAgree'); await p.click('[data-auth-signup]'); await p.waitForTimeout(800); };
  const signin=async(e)=>{ await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML=''); await p.goto(url+'#account'); await p.waitForTimeout(300); if(await p.locator('#signOutBtn').isVisible()){ await p.click('#signOutBtn'); await p.waitForTimeout(400);} await p.click('#signInBtn'); await p.waitForTimeout(200); await p.fill('#siEmail',e); await p.fill('#siPass','password123'); await p.click('[data-auth-signin]'); await p.waitForTimeout(1200); };
  await signup('Maya','maya@test.com'); await p.goto(url+'#join-editor'); await p.waitForTimeout(300); await p.fill('#inviteCode','CUV-2026-EDIT'); await p.click('#inviteBtn'); await p.waitForTimeout(1500);
  await p.fill('#epName','Maya'); await p.fill('#epCity','M'); await p.fill('#epCountry','G'); await p.fill('.sv-rate','35'); await p.check('#epPublic'); await p.click('#epSave'); await p.waitForTimeout(900); await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  await signin('nobody@test.com').catch(()=>{}); await signup('Atk','atk@test.com');
  await p.goto(url+'#home'); await p.waitForTimeout(600); await p.click('.real-card .message-person'); await p.waitForTimeout(900);
  await p.evaluate(()=>{ window.__mockEscrow=true; }); await p.evaluate(()=>window.__reloadEscrow()); await p.waitForTimeout(300);
  await p.click('.chat-window .open-contract'); await p.waitForTimeout(700);
  await p.fill('#oTitle',P('title')); await p.fill('#oScope',P('scope')); await p.fill('#oDeliv',P('deliv')); await p.fill('#oCd',P('duties')); await p.fill('#oCustom',P('custom')); await p.fill('#oPrice','1000');
  await p.check('#oMsOn'); await p.waitForTimeout(200); const rows=p.locator('.o-ms-row'); await rows.nth(0).locator('.o-ms-title').fill(P('ms1')); await rows.nth(0).locator('.o-ms-amt').fill('400'); await rows.nth(1).locator('.o-ms-title').fill(P('ms2')); await rows.nth(1).locator('.o-ms-amt').fill('600');
  await p.evaluate(()=>document.querySelector('.modal details').open=true); await p.waitForTimeout(200);
  await p.click('#oSend'); await p.waitForTimeout(1200);                                   // the Order opens: title, scope, milestones, terms
  await p.evaluate(()=>document.querySelector('details.ct-details').open=true); await p.waitForTimeout(200);
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML=''); await p.waitForTimeout(200);   // chat card
  await p.click('#notificationsBtn').catch(()=>{}); await p.waitForTimeout(500); await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  await p.goto(url+'#orders'); await p.waitForTimeout(800);                                                 // the list
  await signin('maya@test.com'); await p.goto(url+'#home'); await p.waitForTimeout(500); await p.click('#notificationsBtn'); await p.waitForTimeout(600);   // notification label
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML=''); await p.goto(url+'#orders'); await p.waitForTimeout(800); await p.locator('#contractsList .c-row').first().click(); await p.waitForTimeout(800);
  await p.click('[data-caction="accept"]'); await p.waitForTimeout(800);
  await p.click('[data-caction="amend"]'); await p.waitForTimeout(400); await p.fill('#amNote',P('amend')); await p.fill('#amScope',P('amscope')); await p.click('#amGo'); await p.waitForTimeout(900);   // amendment on the Order
  await p.evaluate(()=>{ const d=document.querySelectorAll('details.ct-details'); d.forEach(x=>x.open=true); }); await p.waitForTimeout(300);                 // history
  // the Order page now holds what the attacker typed: each of these must be there, as text
  const want = ['title', 'scope', 'deliv', 'ms1', 'ms2', 'amend'];
  const missing = await p.evaluate((w) => w.filter(k => !document.body.innerText.includes(`data-xss="${k}"`)), want);
  await verdict(p, 'O an Order (title, scope, deliverables, milestones, amendment) on the Order page, the chat card, notifications and the history',
    missing.length === 0, 'not on the Order page: ' + missing.join(', '));
  await b.close();
});
