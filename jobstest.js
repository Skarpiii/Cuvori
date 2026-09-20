// Jobs a freelancer can trust: posted time, states, client history, Report job, limits, duplicates, risk, admin queue.
const { chromium } = require('playwright'); const fs=require('fs');
const log=[]; const ok=(c,m)=>log.push((c?'PASS ':'FAIL ')+m);
const mock=fs.readFileSync(__dirname+'/mock-supabase.js','utf8');
(async () => {
  const b = await chromium.launch(); const ctx=await b.newContext({viewport:{width:1400,height:900}});
  const errs=[];
  const url='file://'+process.cwd()+'/index.html';
  await ctx.addInitScript(mock);
  await ctx.route('**/supabase.min.js', r=>r.fulfill({status:200,body:'/* mocked */',contentType:'application/javascript'}));
  const p = await ctx.newPage(); p.on('pageerror',e=>errs.push('P1 '+e.message));
  const clearModal=()=>p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  const signup=async(name,email)=>{ await p.goto(url+'#account'); await p.waitForTimeout(300); if(await p.locator('#signOutBtn').isVisible()){ await p.click('#signOutBtn'); await p.waitForTimeout(400);} await p.goto(url+'#create-account'); await p.waitForTimeout(300); await p.click('#authSeg [data-auth="signup"]'); await p.fill('#suName',name); await p.fill('#suEmail',email); await p.fill('#suPass','password123'); await p.check('#suAgree'); await p.click('[data-auth-signup]'); await p.waitForTimeout(900); await clearModal(); };
  const signin=async(e)=>{ await clearModal(); await p.goto(url+'#account'); await p.waitForTimeout(300); if(await p.locator('#signOutBtn').isVisible()){ await p.click('#signOutBtn'); await p.waitForTimeout(400);} await p.click('#signInBtn'); await p.waitForTimeout(200); await p.fill('#siEmail',e); await p.fill('#siPass','password123'); await p.click('[data-auth-signin]'); await p.waitForTimeout(1200); await clearModal(); };
  const post=async(title,desc,budget)=>{ await p.goto(url+'#post-job'); await p.waitForTimeout(300); await p.selectOption('#jobRole','video-editor'); await p.fill('#jobTitle',title); await p.fill('#jobDesc',desc); await p.fill('#jobBudget',budget||'€300'); await p.click('#publishJob'); await p.waitForTimeout(900); };
  const toastText=()=>p.evaluate(()=>{ const t=[...document.querySelectorAll('#toastWrap .toast')].pop(); return t?t.textContent:''; });
  const jobs=()=>p.evaluate(()=>window.__mockdb.jobs.map(j=>({title:j.title,status:j.status,hidden_reason:j.hidden_reason,expires_at:j.expires_at,risk:j.risk_score})));
  try {
  // ---------- the first account is the admin; the second is a client ----------
  await signup('Admin','admin@test.com');
  await signup('Cleo','cleo@test.com');
  await post('YouTube video editor for a travel series','Ten episodes, 12 minutes each, footage on Google Drive: https://drive.google.com/folder/abc','€1,200');
  let j=await jobs();
  ok(j.length===1 && j[0].status==='open' && j[0].expires_at && (new Date(j[0].expires_at)-Date.now())>29*86400000,'a normal job goes live at once and expires in 30 days unless renewed');
  ok(j[0].risk===0,'a Google Drive link is not suspicious');
  await p.goto(url+'#jobs'); await p.waitForTimeout(800);
  const card=p.locator('#jobList .real-job').first();
  ok(await card.count()===1 && (await card.textContent()).includes('Posted today'),'the card says when the job was posted');
  ok(await card.locator('.job-time').getAttribute('title')!=='' ,'…with the exact time behind it');
  ok((await card.textContent()).includes('New client'),'a first-time client is shown as new, not as a risk');
  ok(!(await card.textContent()).includes('hire rate') && !(await card.textContent()).includes('score'),'no hire rate for someone with no history, and no score anywhere');
  ok((await p.textContent('#myJobsPanel')).includes('My jobs') && (await p.textContent('#myJobsPanel')).includes('Active') && (await p.textContent('#myJobsPanel')).includes('expires in'),'the owner sees My jobs with the state and the expiry');
  ok(await p.locator('#jobSort').count()===1 && await p.locator('#jtVerified').count()===1 && await p.locator('#jtSecured').count()===1 && await p.locator('#jtWithin').count()===1,'sorting and trust filters are on the page');
  // ---------- states ----------
  await p.locator('#myJobsPanel [data-jt="filled"]').click(); await p.waitForTimeout(700);
  j=await jobs(); ok(j[0].status==='filled' && (await p.textContent('#myJobsPanel')).includes('Filled'),'Mark as filled: the job leaves the feed but stays in the owner\'s list');
  ok(await p.locator('#jobList .real-job').count()===0,'…and Browse jobs no longer shows it');
  await p.locator('#myJobsPanel [data-jt="open"]').click(); await p.waitForTimeout(700);
  j=await jobs(); ok(j[0].status==='open' && await p.locator('#jobList .real-job').count()===1,'Reopen puts it back');
  await p.locator('#myJobsPanel [data-jt="closed"]').click(); await p.waitForTimeout(700);
  j=await jobs(); ok(j[0].status==='closed','Close works the same way');
  await p.locator('#myJobsPanel [data-jt="open"]').click(); await p.waitForTimeout(700);
  // an expired job: the owner sees "Expired" and a Renew button, the public sees nothing
  await p.evaluate(()=>{ window.__mockdb.jobs[0].expires_at=new Date(Date.now()-86400000).toISOString(); });
  await p.click('.nav-btn[data-route="how"]'); await p.click('.nav-btn[data-route="jobs"]'); await p.waitForTimeout(800);
  ok(await p.locator('#jobList .real-job').count()===0 && (await p.textContent('#myJobsPanel')).includes('Expired'),'an expired job is gone from the feed; the owner sees it as expired');
  await p.locator('#myJobsPanel [data-jt="renew"]').click(); await p.waitForTimeout(700);
  j=await jobs(); ok(j[0].status==='open' && (new Date(j[0].expires_at)-Date.now())>29*86400000 && await p.locator('#jobList .real-job').count()===1,'Renew gives it another 30 days and it is back in the feed');
  // ---------- limits and duplicates ----------
  await post('YouTube video editor for a travel series','Ten episodes, 12 minutes each, footage on Google Drive: https://drive.google.com/folder/abc','€1,200');
  ok((await jobs()).length===1 && (await toastText()).includes('same job recently'),'posting the same job again is refused with a plain explanation');
  await post('Second job: podcast edit','Weekly 40-minute episode','€120');
  await post('Third job: wedding highlight','Two cameras, 6 minutes','€400');
  ok((await jobs()).length===3,'three different jobs are fine');
  await post('Fourth job: colour grade','Short film','€200');
  ok((await jobs()).length===3 && ((await toastText()).includes('too many active jobs') || (await toastText()).includes('posting limit')),'a fourth active job for a new client is refused, and it says why');
  // ---------- risk: a scam post is held for review, the owner is told, the public never sees it ----------
  // the two extra jobs were filled two days ago: today's quota is free again
  await p.evaluate(()=>{ window.__mockdb.jobs.forEach(x=>{ if(x.title.startsWith('Second')||x.title.startsWith('Third')){ x.status='closed'; x.created_at=new Date(Date.now()-2*86400000).toISOString(); } }); });
  await post('Easy work, no experience needed','Pay the registration fee first, then contact me on telegram for the details. Earn €500 per day.','€9000');
  j=await jobs(); const scam=j.find(x=>x.title.startsWith('Easy work'));
  ok(scam && scam.status==='hidden' && scam.hidden_reason==='auto_review' && scam.risk>=5,'a post asking for a fee and a Telegram chat is hidden for review, not published');
  ok((await toastText()).includes('check it before it goes live'),'the owner is told it will be checked first');
  await p.goto(url+'#jobs'); await p.waitForTimeout(800);
  ok(!(await p.textContent('#jobList')).includes('Easy work') && (await p.textContent('#myJobsPanel')).includes('Under review') && (await p.textContent('#myJobsPanel')).includes('checking this job'),'the feed does not show it; My jobs explains the state');
  ok(await p.locator('#myJobsPanel [data-jt="appeal"]').count()===1,'…and offers a way to ask for a review');
  await post('Colour grading for a music video','Brief: https://bit.ly/abc123 — 3 minutes, two cameras','€350');
  j=await jobs(); const linky=j.find(x=>x.title.startsWith('Colour grading'));
  ok(linky && linky.status==='open' && linky.risk===2,'a shortened link is only flagged, the job stays up');
  // ---------- a freelancer looks at the job and reports it ----------
  await signup('Eva','eva@test.com');
  await p.goto(url+'#jobs'); await p.waitForTimeout(800);
  ok(await p.locator('#myJobsPanel').isHidden(),'someone with no jobs sees no My jobs panel');
  ok(await p.locator('#jobList .real-job').count()===2,'the freelancer sees the two live jobs, not the hidden or closed ones');
  await p.locator('#jobList .real-job').filter({hasText:'travel series'}).click(); await p.waitForTimeout(400);
  const modal=await p.textContent('#modalRoot');
  ok(modal.includes('About this client') && modal.includes('Cleo') && modal.includes('jobs posted') && modal.includes('Member since') && modal.includes('Posted today') && modal.includes('Expires'),'the job details show the client history: posts, member since, posted, expires');
  ok(!modal.includes('cleo@test.com'),'…and never the e-mail address');
  ok(await p.locator('#reportJob').count()===1,'there is a Report job button');
  await p.click('#reportJob'); await p.waitForTimeout(300);
  ok((await p.textContent('#modalRoot')).includes('Report this job') && await p.locator('input[name=jrReason]').count()===7,'the report asks for one of seven reasons');
  await p.check('input[name=jrReason][value=scam]'); await p.fill('#jrNote','Asks to move to Telegram'); await p.click('#jrSend'); await p.waitForTimeout(500);
  ok(await p.evaluate(()=>window.__mockdb.job_reports.length===1 && window.__mockdb.job_reports[0].reason==='scam' && window.__mockdb.jobs.find(x=>x.title.includes('travel')).report_count===1),'the report is stored and counted once');
  ok(await p.evaluate(()=>window.__mockdb.job_flags.some(f=>f.kind==='reports' && f.score===1)),'one report is a signal, not a verdict');
  // sorting by budget
  await p.selectOption('#jobSort','budget'); await p.waitForTimeout(400);
  ok((await p.locator('#jobList .real-job').first().textContent()).includes('travel series'),'sorted by budget: the €1,200 job comes first');
  await p.selectOption('#jobSort','newest'); await p.waitForTimeout(400);
  ok((await p.locator('#jobList .real-job').first().textContent()).includes('Colour grading'),'sorted by newest: the latest job comes first');
  await p.check('#jtVerified'); await p.waitForTimeout(300);
  ok(await p.locator('#jobList .real-job:not(.hidden)').count()===0 && await p.locator('#jobsEmpty').isVisible(),'"Identity verified only" hides jobs from unverified clients, honestly');
  await p.click('#clearJobFilters'); await p.waitForTimeout(300);
  ok(await p.locator('#jobList .real-job:not(.hidden)').count()===2,'clearing the filters brings them back');
  // ---------- a visitor is asked to join before reporting ----------
  await clearModal(); await p.goto(url+'#account'); await p.waitForTimeout(300); await p.click('#signOutBtn'); await p.waitForTimeout(400);
  await p.goto(url+'#jobs'); await p.waitForTimeout(800);
  ok(await p.locator('#jobList .real-job').count()===2,'a visitor can browse jobs without an account');
  await p.locator('#jobList .real-job').first().click(); await p.waitForTimeout(400); await p.click('#reportJob'); await p.waitForTimeout(400);
  ok((await p.textContent('#modalRoot')).includes('Google') || (await p.textContent('#modalRoot')).includes('Create'),'a visitor who wants to report is asked to join first');
  // ---------- the admin queue ----------
  await signin('admin@test.com');
  await p.goto(url+'#admin'); await p.waitForTimeout(500); await p.click('.admin-tab[data-atab="jobs"]'); await p.waitForTimeout(800);
  let body=await p.textContent('#adminBody');
  ok(body.includes('Posting rules') && body.includes('waiting for review'),'the admin has a Job review tab with the rules and the queue');
  ok(body.includes('Easy work') && body.includes('pay_to_work') && body.includes('external_channel'),'the hidden scam post is in the queue with the reasons spelled out');
  ok(body.includes('travel series') && body.includes('scam — Eva') && body.includes('Asks to move to Telegram'),'the reported job is there with the report and who sent it');
  ok(body.includes('Colour grading') && body.includes('bit.ly'),'the shortened link is listed');
  ok(body.includes('Other jobs by this client'),'the client\'s posting history is shown next to each');
  const qrow=(txt)=>p.locator('[data-ajob]').filter({has:p.locator('.admin-main > div:first-child strong',{hasText:txt})});
  await qrow('Easy work').locator('[data-aj="remove"]').click(); await p.waitForTimeout(300);
  await p.fill('#ajReason','Asks freelancers to pay a fee'); await p.click('#ajGo'); await p.waitForTimeout(700);
  j=await jobs(); ok(j.find(x=>x.title.startsWith('Easy work')).status==='removed' && await p.evaluate(()=>window.__mockdb.moderation_actions.some(m=>m.action==='remove' && m.reason.includes('fee'))),'Remove: the job is gone and the action is in the log with the reason');
  await qrow('travel series').locator('[data-aj="false_positive"]').click(); await p.waitForTimeout(700);
  ok(await p.evaluate(()=>window.__mockdb.job_flags.filter(f=>f.job_id===window.__mockdb.jobs.find(x=>x.title.includes('travel')).id).every(f=>f.status==='resolved')),'False positive closes the flags');
  ok(await qrow('travel series').count()===0,'…and the job leaves the queue');
  await qrow('Colour grading').locator('[data-aj="warn"]').click(); await p.waitForTimeout(300);
  await p.fill('#ajReason','Please link the brief directly, not through a shortener'); await p.click('#ajGo'); await p.waitForTimeout(700);
  ok(await p.evaluate(()=>window.__mockdb.messages.some(m=>m.body.startsWith('About your job') && m.body.includes('shortener'))),'Warn: a message lands in the client\'s inbox');
  await qrow('Colour grading').locator('[data-aj="verify"]').click(); await p.waitForTimeout(300);
  await p.fill('#ajNote','Video call, passport shown'); await p.click('#ajGo'); await p.waitForTimeout(700);
  ok(await p.evaluate(()=>window.__mockdb.identity_verifications.some(v=>v.status==='verified') && window.__mockdb.moderation_actions.some(m=>m.action==='identity_verified')),'the admin can mark a client verified after seeing proof, and it is logged');
  // rules: shorten the expiry, the owner's panel follows
  await p.fill('[data-rule="expiry_days"]','10'); await p.click('#saveRules'); await p.waitForTimeout(700);
  ok(await p.evaluate(()=>window.__jobsMock.SETTINGS.posting_rules.expiry_days===10 && window.__jobsMock.SETTINGS.posting_rules.daily_limit_new===3),'posting rules are saved without touching the others');
  // the client now shows as verified on the card
  await signin('eva@test.com'); await p.goto(url+'#jobs'); await p.waitForTimeout(800);
  ok((await p.locator('#jobList .real-job').first().textContent()).includes('Identity verified'),'the card now says Identity verified');
  await p.check('#jtVerified'); await p.waitForTimeout(300);
  ok(await p.locator('#jobList .real-job:not(.hidden)').count()===2,'"Identity verified only" keeps them');
  // the removed job: the owner sees why and can appeal
  await signin('cleo@test.com'); await p.goto(url+'#jobs'); await p.waitForTimeout(800);
  const mine=await p.textContent('#myJobsPanel');
  ok(mine.includes('Removed') && mine.includes('Removed by Cuvori: Asks freelancers to pay a fee'),'the owner sees that the job was removed and the reason');
  await p.locator('#myJobsPanel .mj-row').filter({hasText:'Easy work'}).locator('[data-jt="appeal"]').click(); await p.waitForTimeout(400);
  ok((await p.textContent('#modalRoot')).includes('Report') && (await p.inputValue('#rpBody')).includes('Please review my job'),'Ask for a review opens the report form, prefilled');
  await clearModal();
  ok((await p.textContent('#myJobsPanel')).includes('expires in 10 days') || (await p.textContent('#myJobsPanel')).includes('expire after 10 days'),'the shorter expiry from the rules shows up for the owner');
  // ---------- languages ----------
  for(const [code,word] of [['de','Heute eingestellt'],['lt','Paskelbta šiandien'],['ru','Опубликовано сегодня'],['es','Publicado hoy'],['pl','Dodano dzisiaj'],['uk','Опубліковано сьогодні']]){
    await p.click('#langBtn'); await p.click('#langPop [data-lang="'+code+'"]'); await p.waitForTimeout(400);
    ok((await p.textContent('#page-jobs')).includes(word),'jobs page translated: '+code);
  }
  await p.click('#langBtn'); await p.click('#langPop [data-lang="en"]');
  } catch(e){ log.push('EXCEPTION '+e.message.split('\n')[0]); await p.screenshot({path:'shots/jobs-fail.png'}); }
  await b.close(); console.log(log.join('\n')); console.log(errs.length?('ERRORS:\n'+errs.join('\n')):'no page errors');
})();
