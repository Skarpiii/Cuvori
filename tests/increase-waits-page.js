// Check of 25 November 2026 (the calendar date; the labels of some earlier checks ran ahead of it): an Order handed in whose
// price increase both sides accepted is not paid in yet. The hourly job does not pay it out automatically (closing it would
// drop the increase for good), but the Order still promised the freelancer "If nothing happens by <date>, the money is
// released to you automatically", and both sides "the money is released automatically on <date>", also once the date had
// gone by. Now both read that the automatic payout waits for the increase, and the freelancer what they can do.
// What stays: an Order handed in without an unpaid increase keeps its payout date.
// Run: node tests/increase-waits-page.js   (TARGET=<folder> checks another copy)
const { chromium } = require('playwright'); const fs=require('fs'), path=require('path');
const log=[]; const ok=(c,m)=>log.push((c?'PASS ':'FAIL ')+m);
const root=process.env.TARGET?path.resolve(process.env.TARGET):path.resolve(__dirname,'..');   // the copy under test (TARGET), else this one
const html=fs.readFileSync(root+'/index.html','utf8');
const LANGS=['en','de','ru','lt','es','pl','uk'];
const moneyTexts=()=>{ const a=html.indexOf('const T_MONEY'), b=html.indexOf('for(const code in T_MONEY)',a); if(a<0||b<0) return null; return new Function(html.slice(a,b)+';return T_MONEY;')(); };
// a text of the page's main table (en, de, ru, lt, es, pl, uk, in that order)
const pageText=(key,l)=>([...html.matchAll(new RegExp(`\\b${key}:"([^"]*)"`,'g'))].map(m=>m[1]))[LANGS.indexOf(l)]||'\u0000missing '+key;
// the parts of a text around its {…} places, each as the page shows it
const parts=(s)=>String(s).split(/\{\w+\}/).map(x=>x.trim()).filter(Boolean);

(async () => {
  const TM=moneyTexts();
  const NEW=['es_autoReleaseWaits','es_editorWaitsTopup'];
  ok(!!TM && LANGS.every(l=>NEW.every(k=>typeof TM[l][k]==='string'&&TM[l][k].trim()&&TM[l][k].includes('{amt}')&&(l==='en'||TM[l][k]!==TM.en[k]))),
     'every language has its own words, with the amount, for: the automatic payout waits for the increase (both sides), and what the freelancer can do');
  ok(!!TM && LANGS.every(l=>NEW.every(k=>!/\{d\}/.test(TM[l][k]))),'…and none of them names a payout date');
  const T=(l,k)=>TM&&TM[l]&&TM[l][k]||'\u0000missing '+k;

  const b=await chromium.launch(); const errs=[];
  for (const [size,viewport] of [['desktop',{width:1400,height:900}],['phone',{width:390,height:844}]]) {
    const ctx=await b.newContext({viewport});
    await ctx.addInitScript(fs.readFileSync(root+'/mock-supabase.js','utf8'));
    await ctx.route('**/supabase.min.js', r=>r.fulfill({status:200,body:'/* mocked */',contentType:'application/javascript'}));
    const p=await ctx.newPage(); p.on('pageerror',e=>errs.push(size+': '+e.message));
    const url='file://'+root+'/index.html';
    try {
      await p.goto(url); await p.waitForTimeout(500);
      const clear=async()=>{ await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML=''); };
      const signUp=async(name,email)=>{ await p.goto(url+'#create-account'); await p.waitForTimeout(300); await p.fill('#suName',name); await p.fill('#suEmail',email); await p.fill('#suPass','password123'); await p.check('#suAgree'); await p.click('[data-auth-signup]'); await p.waitForTimeout(900); };
      const signOut=async()=>{ await clear(); await p.goto(url+'#account'); await p.waitForTimeout(300); await p.click('#signOutBtn'); await p.waitForTimeout(400); };
      const signIn=async(email)=>{ await p.goto(url+'#create-account'); await p.waitForTimeout(300); await p.click('#authSeg [data-auth="signin"]'); await p.waitForTimeout(200); await p.fill('#siEmail',email); await p.fill('#siPass','password123'); await p.click('[data-auth-signin]'); await p.waitForTimeout(1300); };
      await signUp('Ana','ana@test.com'); await signOut(); await signUp('Bo','bo@test.com');
      const gone=new Date(Date.now()-3*86400000).toISOString(), ahead=new Date(Date.now()+5*86400000).toISOString();
      // [name, price, paid in, payout date, note]
      const CASES=[
        ['increase unpaid, date gone by',12000,10000,gone,'Money step stopped (automatic payout): The price increase both sides accepted is not paid in yet: the automatic payout waits until the client pays it, or Cuvori decides the Order.'],
        ['increase unpaid, date ahead',12000,10000,ahead,null],
        ['no increase',10000,10000,ahead,null],
        ['increase under 0.50',10030,10000,ahead,null]];
      await p.evaluate((CASES)=>{ const db=window.__mockdb; const ana=db.profiles.find(x=>x.email==='ana@test.com').id, bo=db.profiles.find(x=>x.email==='bo@test.com').id; const now=new Date().toISOString();
        const [ua,ub]=[ana,bo].sort(); db.conversations.push({id:'cv-incr', user_a:ua, user_b:ub, created_at:now, last_message_at:now});
        CASES.forEach(([name,amount,funded,at,note],i)=>{ db.contracts.push({id:'c-incr-'+i, conversation_id:'cv-incr', editor:bo, client:ana, proposed_by:ana, title:'Increase: '+name, description:'', price:amount/100, currency:'EUR', pricing:'project', revisions:2, status:'delivered', payment_mode:'escrow', amount_cents:amount, funded_cents:funded, released_cents:0, refunded_cents:0, terms:{}, terms_version:1, accepted_version:1, client_accepted_version:1, freelancer_accepted_version:1, accepted_at:now, created_at:new Date(Date.now()-i*1000).toISOString(), changes_used:0, amendments:amount>funded?1:0, money_error:note, delivered_at:now, auto_release_at:at, delivery_url:'https://example.com/final'}); }); }, CASES);
      const open=async(name)=>{ await clear(); await p.goto(url+'#orders'); await p.waitForTimeout(800);
        if(await p.locator('.modal.locked [data-avpick="open"]').count()){ await p.click('.modal.locked [data-avpick="open"]'); await p.waitForTimeout(500); }
        const row=p.locator('#contractsList .c-row',{hasText:'Increase: '+name}).first(); if(!(await row.count())) return '';
        await row.click(); await p.waitForTimeout(800);
        const wide=await p.evaluate(()=>document.documentElement.scrollWidth>window.innerWidth+1);
        return { x:(await p.textContent('#modalRoot')).replace(/\s+/g,' '), wide }; };
      const has=(x,l,k)=>!!x&&parts(T(l,k)).every(s=>x.includes(s));
      const promise=(l,fl)=>parts(pageText(fl?'es_editorDeliveredHint':'es_autoRelease',l))[0];   // the date promise's first words
      const sides=[['freelancer','bo@test.com'],['client','ana@test.com']];
      for(const [side,email] of sides){
        if(side==='client'){ await signOut(); await signIn(email); }
        const fl=side==='freelancer';
        for(const name of ['increase unpaid, date gone by','increase unpaid, date ahead']){
          const r=await open(name); const x=r&&r.x;
          ok(x && has(x,'en','es_autoReleaseWaits') && (fl ? has(x,'en','es_editorWaitsTopup') : true) && !x.includes(promise('en',true)) && !x.includes(promise('en',false)) && /€\s?20(?![\d.,])|\b20\s?€/.test(x),
             `${size}, ${side}, ${name}: the automatic payout waits for the increase of €20${fl?', and what the freelancer can do':''}; no payout date promised`);
          ok(r && !r.wide,`${size}, ${side}, ${name}: nothing wider than the screen`);
        }
        for(const name of ['no increase','increase under 0.50']){
          const r=await open(name); const x=r&&r.x;
          ok(x && x.includes(promise('en',false)) && (fl ? x.includes(promise('en',true)) : true) && !has(x,'en','es_autoReleaseWaits') && !has(x,'en','es_editorWaitsTopup'),
             `${size}, ${side}, ${name}: the payout date as before${name.includes('0.50')?' (an increase under 0.50 can never be charged and holds back nothing)':''}`);
        }
      }
      if(size==='desktop'){
        // in another language: the freelancer, in German
        await signOut(); await signIn('bo@test.com'); await p.evaluate(()=>document.querySelector('[data-lang="de"]').click()); await p.waitForTimeout(400);
        const r=await open('increase unpaid, date gone by'); const x=r&&r.x;
        ok(x && has(x,'de','es_editorWaitsTopup') && has(x,'de','es_autoReleaseWaits') && !x.includes(promise('de',true)),'in German: the freelancer reads it in German, with no payout date');
        await p.evaluate(()=>document.querySelector('[data-lang="en"]').click());
      }
    } catch(e){ log.push('CRASH '+size+': '+e.message.split('\n')[0]); }
    await ctx.close();
  }
  ok(errs.length===0,'no page errors '+errs.join(' | '));
  await b.close();
  console.log(log.join('\n')); const f=log.filter(l=>!l.startsWith('PASS')).length; console.log(`\n${log.length-f}/${log.length} passed`); process.exit(f?1:0);
})();
