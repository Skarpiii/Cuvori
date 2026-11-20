// Check of 2 December: what the Order screen says about the money, in the person's words.
// - A note on an Order whose payout stopped (the freelancer's Stripe account not ready, banned, Stripe refused, …) read
//   "The payment provider is still settling the card payment … nothing to do" for every note: the freelancer whose Stripe
//   setup was not finished was never told, and an Order whose automatic payout waited for it kept promising the payout
//   "by" a date gone by. Now the freelancer is told to finish their Stripe setup (with the button that opens it), the client
//   that it waits for the freelancer, any other note that Cuvori has to check it, and only settling says settling.
// - Payout timing: a new Stripe account's first payout takes 7–14 days, in some countries up to 30 (Stripe's help pages),
//   not "up to 7". A chargeback can take 2–3 months, not "a few weeks". No text promises that Cuvori answers the bank: no
//   code does (the owner's choice of 2 December: say only what happens by itself).
// - money-i18n.js was an old copy of these texts the page never loaded (the copy reviewed on 2 December): only index.html
//   has them now.
// Run: node tests/money-notes.js   (TARGET=<folder> checks another copy)
const { chromium } = require('playwright'); const fs=require('fs'), path=require('path');
const log=[]; const ok=(c,m)=>log.push((c?'PASS ':'FAIL ')+m);
const root=process.env.TARGET?path.resolve(process.env.TARGET):path.resolve(__dirname,'..');   // the copy under test (TARGET), else this one
const html=fs.readFileSync(root+'/index.html','utf8'), lib=fs.readFileSync(root+'/netlify/lib/cuvori.mjs','utf8');
const LANGS=['en','de','ru','lt','es','pl','uk'];
const moneyTexts=()=>{ const a=html.indexOf('const T_MONEY'), b=html.indexOf('for(const code in T_MONEY)',a); if(a<0||b<0) return null; return new Function(html.slice(a,b)+';return T_MONEY;')(); };
// the server's own sentence, as netlify/lib/cuvori.mjs writes it into the Order's note
const said=(name)=>{ const m=new RegExp(`^const ${name} = "([^"]*)";`,'m').exec(lib); return m?m[1]:''; };
const NOT_READY=said('NOT_READY'), SETTLING=said('SETTLING'), REFUND_SETTLING=said('REFUND_SETTLING'), BANNED=said('BANNED');
const step=(what,text)=>`Money step stopped (${what}): ${text}`;
// a text of the page's main table (en, de, ru, lt, es, pl, uk, in that order)
const pageText=(key,l)=>([...html.matchAll(new RegExp(`\\b${key}:"([^"]*)"`,'g'))].map(m=>m[1]))[LANGS.indexOf(l)]||'\u0000missing '+key;

(async () => {
  // ---------- the texts (all 7 languages) ----------
  const TM=moneyTexts();
  ok(!!TM && LANGS.every(l=>TM[l]),'the money texts are in index.html in all 7 languages');
  const NEW=['es_flNotReadyHint','es_clNotReadyHint','es_moneyCheck'];
  ok(!!TM && LANGS.every(l=>NEW.every(k=>typeof TM[l][k]==='string'&&TM[l][k].trim()&&(l==='en'||TM[l][k]!==TM.en[k]))),'every language has its own text for: the freelancer\'s Stripe account not ready (to the freelancer, to the client), and a note Cuvori has to check');
  ok(!!TM && LANGS.every(l=>Object.keys(TM.en).every(k=>k in TM[l]) && Object.keys(TM[l]).every(k=>k in TM.en) && Object.keys(TM.en).every(k=>((TM.en[k].match(/\{\w+\}/g)||[]).sort().join())===((TM[l][k].match(/\{\w+\}/g)||[]).sort().join()))),'every language has the same texts as English, with the same {placeholders}');
  ok(!!TM && LANGS.every(l=>['es_payoutTiming','es_payoutTimingFl'].every(k=>TM[l][k].includes('7–14')&&/\b30\b/.test(TM[l][k])&&!/\b7\)|\(\D*7\D*\)/.test(TM[l][k]))),'payout timing in every language: a new Stripe account\'s first payout 7–14 days, in some countries up to 30 (was: up to 7)');
  ok(!!TM && LANGS.every(l=>TM[l].es_chargebackOpen.includes('2–3')),'a chargeback in every language: it can take 2–3 months (was: a few weeks)');
  ok(!!TM && LANGS.every(l=>!/Cuvori/.test(TM[l].es_chargebackOpen)&&!/Cuvori/.test(TM[l].o_ev_chargeback)),'no language promises that Cuvori answers the bank or sends it anything (no code does)');
  ok(!!TM && !/Uwolnione|na (jego|Twój) bank\b/.test(TM.pl.es_payoutTiming+TM.pl.es_payoutTimingFl) && !/на ваш банк\b/.test(TM.uk.es_payoutTimingFl) && !/'/.test(TM.uk.es_notConfirmed),'Polish says the money was passed on to a bank account, Ukrainian a bank account, and its apostrophe is the one the page uses (’)');
  // the page reads the server's sentences: each of its markers is in the sentence it stands for
  const marks=/const O_NOTE_NOT_READY="([^"]+)", O_NOTE_SETTLING=\[("[^"]+"(?:,"[^"]+")*)\];/.exec(html);
  const settleMarks=marks?JSON.parse('['+marks[2]+']'):[];
  ok(!!marks && !!NOT_READY && NOT_READY.includes(marks[1]) && settleMarks.length===2 && SETTLING.includes(settleMarks[0]) && REFUND_SETTLING.includes(settleMarks[1]) && !settleMarks.some(s=>NOT_READY.includes(s)||BANNED.includes(s)) && !SETTLING.includes(marks[1]),
     'the page tells the notes apart by the server\'s own sentences (NOT_READY, SETTLING, REFUND_SETTLING in netlify/lib/cuvori.mjs), each marker in its own sentence only');
  // one copy of the texts: the page's (an old copy is what gets reviewed or changed, and changes nothing)
  const copies=fs.readdirSync(root).filter(f=>/\.(js|mjs|html)$/.test(f)&&fs.readFileSync(path.join(root,f),'utf8').includes('const T_MONEY'));
  ok(copies.join()==='index.html','only index.html has the money texts (found in: '+copies.join(', ')+')');

  // ---------- the page ----------
  const b=await chromium.launch(); const ctx=await b.newContext({viewport:{width:1400,height:900}});
  await ctx.addInitScript(fs.readFileSync(root+'/mock-supabase.js','utf8'));
  await ctx.route('**/supabase.min.js', r=>r.fulfill({status:200,body:'/* mocked */',contentType:'application/javascript'}));
  const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  const url='file://'+root+'/index.html';
  try {
    await p.goto(url); await p.waitForTimeout(500);
    const clear=async()=>{ await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML=''); };
    const signUp=async(name,email)=>{ await p.goto(url+'#create-account'); await p.waitForTimeout(300); await p.fill('#suName',name); await p.fill('#suEmail',email); await p.fill('#suPass','password123'); await p.check('#suAgree'); await p.click('[data-auth-signup]'); await p.waitForTimeout(900); };
    const signOut=async()=>{ await clear(); await p.goto(url+'#account'); await p.waitForTimeout(300); await p.click('#signOutBtn'); await p.waitForTimeout(400); };
    const signIn=async(email)=>{ await p.goto(url+'#create-account'); await p.waitForTimeout(300); await p.click('#authSeg [data-auth="signin"]'); await p.waitForTimeout(200); await p.fill('#siEmail',email); await p.fill('#siPass','password123'); await p.click('[data-auth-signin]'); await p.waitForTimeout(1300); };
    await signUp('Ana','ana@test.com'); await signOut(); await signUp('Bo','bo@test.com');
    const past=new Date(Date.now()-3*86400000).toISOString();
    const NOTES={
      notReady:step('settlement',NOT_READY), banned:step('settlement',BANNED), refused:step('settlement','Stripe refused the request (Netlify log ref ab12cd34)'),
      settling:step('settlement',SETTLING), refundSettling:step('settlement',REFUND_SETTLING), settlingAndRefused:step('settlement',SETTLING)+' · Also: '+step('milestone m-x','Stripe refused the request (Netlify log ref ab12cd35)'),
      autoNotReady:step('automatic payout',NOT_READY), partNotReady:step('milestone m-probe-1',NOT_READY) };
    const CASES=[
      ['not ready','releasing',NOTES.notReady,{}], ['banned','releasing',NOTES.banned,{}], ['Stripe refused','resolving',NOTES.refused,{}],
      ['settling','releasing',NOTES.settling,{}], ['refund settling','resolving',NOTES.refundSettling,{}], ['settling and refused','releasing',NOTES.settlingAndRefused,{}],
      ['no note','releasing',null,{}],
      ['automatic payout waits','delivered',NOTES.autoNotReady,{delivered_at:past, auto_release_at:past, delivery_url:'https://example.com/final'}],
      ['part waits','funded',NOTES.partNotReady,{has_milestones:true}],
      ['completed','completed',null,{released_cents:10000, resolution:'release', closed_at:past}],
      ['chargeback open','disputed',null,{chargeback_status:'open', chargeback_id:'du_probe', chargeback_cents:10000, dispute_by:'CLIENT', dispute_reason:'Card chargeback du_probe (fraudulent)', disputed_at:past}] ];
    await p.evaluate((CASES)=>{ const db=window.__mockdb; const ana=db.profiles.find(x=>x.email==='ana@test.com').id, bo=db.profiles.find(x=>x.email==='bo@test.com').id; const now=new Date().toISOString();
      const [ua,ub]=[ana,bo].sort(); db.conversations.push({id:'cv-notes', user_a:ua, user_b:ub, created_at:now, last_message_at:now});
      CASES.forEach(([name,status,note,more],i)=>{ const m={...more}; if(m.dispute_by==='CLIENT') m.dispute_by=ana; const id='c-notes-'+i;
        db.contracts.push({id, conversation_id:'cv-notes', editor:bo, client:ana, proposed_by:ana, title:'Notes: '+name, description:'', price:100, currency:'EUR', pricing:'project', revisions:2, status, payment_mode:'escrow', amount_cents:10000, funded_cents:10000, released_cents:0, refunded_cents:0, terms:{}, terms_version:1, accepted_version:1, client_accepted_version:1, freelancer_accepted_version:1, accepted_at:now, created_at:new Date(Date.now()-i*1000).toISOString(), changes_used:0, amendments:0, money_error:note, ...m});
        if(m.has_milestones) db.order_milestones.push({id:'m-probe-1', order_id:id, position:1, title:'Part one', amount_cents:10000, status:'approved', created_at:now});
        if(status==='disputed') db.order_events.push({id:'ev-notes-cb', order_id:id, actor:null, event:'chargeback', data:{chargeback:'du_probe', amount_cents:10000, reason:'fraudulent'}, created_at:now}); }); }, CASES);
    const open=async(name)=>{ await clear(); await p.goto(url+'#orders'); await p.waitForTimeout(800);
      if(await p.locator('.modal.locked [data-avpick="open"]').count()){ await p.click('.modal.locked [data-avpick="open"]'); await p.waitForTimeout(500); }
      const row=p.locator('#contractsList .c-row',{hasText:'Notes: '+name}).first(); if(!(await row.count())) return '';
      await row.click(); await p.waitForTimeout(800); return (await p.textContent('#modalRoot')).replace(/\s+/g,' '); };
    const T=(l,k)=>TM?TM[l][k]:'\u0000missing '+k;
    const has=(txt,k,l='en')=>!!TM&&txt.includes(T(l,k));
    const OLD_SETTLING='The payment provider is still settling the card payment';
    const sides=[['freelancer','bo@test.com'],['client','ana@test.com']];
    for(const [side,email] of sides){
      if(side==='client'){ await signOut(); await signIn(email); }
      const fl=side==='freelancer';
      let x=await open('not ready');
      ok(x && has(x,fl?'es_flNotReadyHint':'es_clNotReadyHint') && !x.includes(OLD_SETTLING),`${side}, payout stopped because the freelancer's Stripe account is not ready: ${fl?'told to finish the Stripe setup':'told it waits for the freelancer\'s Stripe setup'}, not "still settling … nothing to do"`);
      const btns=await p.locator('#modalRoot [data-set-open="payout"]').count();
      const btnText=btns===1?(await p.textContent('#modalRoot [data-set-open="payout"]')).trim():'';
      ok(!!x && (fl ? btns===1 && btnText===pageText('st_continue','en') : btns===0), fl?'…with a "Continue Stripe setup" button':'…and no button to the freelancer\'s Stripe setup');
      if(fl){ if(btns===1){ await p.click('#modalRoot [data-set-open="payout"]'); await p.waitForTimeout(500); }
        ok(btns===1 && await p.evaluate(()=>location.hash==='#settings'&&!!document.querySelector(".snav[data-set='payout'].active")),'…which opens Settings → Payout details'); }
      for(const name of ['banned','Stripe refused','settling and refused']){ x=await open(name);
        ok(x && has(x,'es_moneyCheck') && !x.includes(OLD_SETTLING) && !has(x,'es_flNotReadyHint') && !has(x,'es_clNotReadyHint'),`${side}, payout stopped (${name}): Cuvori has to check it, not "still settling"`); }
      for(const name of ['settling','refund settling']){ x=await open(name);
        ok(x && x.includes(OLD_SETTLING) && !has(x,'es_moneyCheck'),`${side}, ${name} at the payment provider: still said as settling, nothing to do`); }
      x=await open('no note'); ok(x && x.includes(pageText('es_processing','en')) && !x.includes(OLD_SETTLING) && !has(x,'es_moneyCheck'),`${side}, no note yet: being processed`);
      x=await open('automatic payout waits');
      ok(x && has(x,fl?'es_flNotReadyHint':'es_clNotReadyHint') && (fl ? !x.includes('If nothing happens by') : true),`${side}, the automatic payout waits for the freelancer's Stripe setup: said on the delivered Order${fl?', and no promise of a payout by a date gone by':''}`);
      x=await open('part waits'); ok(x && has(x,fl?'es_flNotReadyHint':'es_clNotReadyHint'),`${side}, a part's payout waits for the freelancer's Stripe setup: said on the Order`);
      x=await open('completed'); ok(x && has(x,fl?'es_payoutTimingFl':'es_payoutTiming') && x.includes('7–14'),`${side}, released: Stripe pays out in a few days, a new account's first payout 7–14 days`);
      x=await open('chargeback open');
      ok(x && has(x,'es_chargebackOpen') && x.includes('2–3') && !/Cuvori (sends|answers)/.test(x) && !!TM && T('en','o_ev_chargeback').split('{amt}').every(part=>x.includes(part.trim())),`${side}, a chargeback is open: it can take 2–3 months, and nothing says Cuvori answers the bank (notice and history)`);
      ok(x && !has(x,'es_flNotReadyHint') && !has(x,'es_clNotReadyHint') && !has(x,'es_moneyCheck'),`${side}, an Order without a note says nothing about one`);
    }
    // in another language: the client's words, then the freelancer's, in German
    await p.evaluate(()=>document.querySelector('[data-lang="de"]').click()); await p.waitForTimeout(400);
    let x=await open('not ready'); ok(x && has(x,'es_clNotReadyHint','de') && !has(x,'es_clNotReadyHint'),'in German: the client reads it in German');
    await signOut(); await signIn('bo@test.com'); await p.evaluate(()=>document.querySelector('[data-lang="de"]').click()); await p.waitForTimeout(400);
    x=await open('not ready'); ok(x && has(x,'es_flNotReadyHint','de') && x.includes(pageText('st_continue','de')),'in German: the freelancer reads it in German, with the button in German');
    x=await open('banned'); ok(x && has(x,'es_moneyCheck','de'),'in German: a note Cuvori has to check');
    await p.evaluate(()=>document.querySelector('[data-lang="en"]').click());
    ok(errs.length===0,'no page errors '+errs.join(' | '));
  } catch(e){ log.push('CRASH '+e.message.split('\n')[0]); }
  await b.close();
  console.log(log.join('\n')); const f=log.filter(l=>!l.startsWith('PASS')).length; console.log(`\n${log.length-f}/${log.length} passed`); process.exit(f?1:0);
})();
