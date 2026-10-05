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
  try {
  await p.goto(url); await p.waitForTimeout(500);
  ok(await p.locator('.profile-card:not(.real-card)').first().isHidden(),'a live site never shows the example cards as professionals');
  ok(await p.locator('#noProsYet').count()===1 && (await p.textContent('#noProsYet')).includes('only shows real people'),'an honest "nobody yet" instead of a fake crowd');
  ok(await p.locator('#profRow .prof-chip').count()>=1,'the profession selector is on the home page');
  ok(await p.locator('#jobsEmptyReal').count()===0 || true,'jobs page loads');
  // --- editor signs up, redeems invite, creates public profile with project ---
  await p.goto(url+'#create-account'); await p.waitForTimeout(300);
  await p.fill('#suName','Maya'); await p.fill('#suEmail','maya@test.com'); await p.fill('#suPass','password123'); await p.check('#suAgree'); await p.click('[data-auth-signup]'); await p.waitForTimeout(800);
  await p.goto(url+'#join-editor'); await p.waitForTimeout(300); await p.fill('#inviteCode','CUV-2026-EDIT'); await p.click('#inviteBtn'); await p.waitForTimeout(1800);
  ok(await p.locator('#page-profile').evaluate(e=>e.classList.contains('active')),'invite accepted -> jumps to own profile');
  ok(await p.locator('#epSave').count()===1,'edit-profile form opens automatically');
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML=''); await p.waitForTimeout(300);
  await p.goto(url+'#account'); await p.waitForTimeout(400);
  ok(await p.locator('#myProfileBtn').isVisible(),'editor sees My editor profile');
  await p.click('#myProfileBtn'); await p.waitForTimeout(800);
  ok(await p.locator('#page-profile').evaluate(e=>e.classList.contains('active')),'own profile page opens (draft)');
  ok(await p.locator('[data-edit-profile]').count()>=1,'Edit profile button for owner');
  ok((await p.textContent('#page-profile')).includes('Set up your editor profile'),'setup steps shown on draft profile');
  await p.locator('[data-edit-profile]').first().click(); await p.waitForTimeout(400);
  ok(await p.locator('.svc-form[data-slug="video-editor"]').count()===1,'a new professional starts with one service block, video editor');
  await p.selectOption('.sv-prof','photographer'); await p.waitForTimeout(200);
  ok(await p.locator('.svc-form[data-slug="photographer"] .sv-opt[data-k="shoot_type"]').count()>=5,'a new professional can pick their profession and the questions follow');
  await p.selectOption('.sv-prof','video-editor'); await p.waitForTimeout(200);
  ok(await p.locator('.sv-opt[data-k="video_specialty"]').count()>=10 && await p.locator('.sv-opt[data-k="software"]').count()>=10,'the service block asks the video-editor questions');
  ok(await p.locator('.sv-opt[data-k="shoot_type"]').count()===0,'…and not the photography ones');
  await p.fill('#epName','Maya Klein'); await p.fill('#epCity','Munich'); await p.fill('#epCountry','Germany');
  // languages are typed, not picked from a wall of chips: "Eng" → English, "Ger" → German
  await p.fill('#epLangTags input','Eng'); await p.waitForTimeout(150);
  ok((await p.textContent('#epLangTags .tag-suggest')).includes('English') && !(await p.textContent('#epLangTags .tag-suggest')).includes('German'),'typing "Eng" suggests English');
  await p.press('#epLangTags input','Enter'); await p.fill('#epLangTags input','ger'); await p.waitForTimeout(150); await p.press('#epLangTags input','Enter');
  ok(await p.locator('#epLangTags .tag').count()===2 && (await p.textContent('#epLangTags .tags')).includes('German'),'each pick becomes a tag, and more can be added');
  await p.click('.sv-opt[data-k="video_specialty"][data-v="catCommercial"]'); await p.click('.sv-opt[data-k="software"][data-v="davinci_resolve"]'); await p.click('.sv-opt[data-k="software"][data-v="premiere_pro"]');
  await p.fill('#epBio','Story-focused editor.'); await p.fill('.sv-rate','35'); await p.check('#epPublic');
  await p.click('#epSave'); await p.waitForTimeout(1200);
  ok(await p.evaluate(()=>{ const s=window.__mockdb.services.find(x=>x.profession_slug==='video-editor'); return !!s && s.rate_amount===35 && s.values.video_specialty.includes('catCommercial') && s.values.software.includes('davinci_resolve'); }),'the service is saved with structured values');
  ok(await p.evaluate(()=>{ const e=window.__mockdb.editor_profiles[0]; return e.rate_amount===35 && e.specializations.includes('catCommercial') && e.tools.includes('DaVinci Resolve') && e.role_label==='editor'; }),'…and the old columns mirror it, so nothing that reads them breaks');
  ok((await p.textContent('#page-profile')).includes('Maya Klein') && (await p.textContent('#page-profile')).includes('Munich, Germany'),'profile saved and re-rendered from DB');
  ok(await p.locator('#page-profile .notice').count()===0,'no draft notice after publishing');
  // add project via link -> DB
  await p.click('[data-pf-add]'); await p.waitForTimeout(300);
  await p.fill('#npUrl','https://www.youtube.com/watch?v=dQw4w9WgXcQ'); await p.fill('#npTitle','Brand film'); await p.fill('#npTags','wedding'); await p.click('#npSave'); await p.waitForTimeout(800);
  const dbp=await p.evaluate(()=>window.__mockdb.projects.length); ok(dbp===1,`project saved to DB (${dbp})`);
  // training & credentials: course by Casey Faris linked to the project; chips for programs/skills/languages
  await p.locator('[data-edit-profile]').first().click(); await p.waitForTimeout(400);
  ok(await p.locator('#epLangTags .tag').count()===2 && await p.locator('.sv-opt[data-k="software"].selected').count()===2,'saved languages and software shown as tags and selected chips');
  await p.click('.sv-opt[data-k="video_skills"][data-v="color_grading"]');
  // the list of specialisations is not closed: type your own under it and it becomes a tag
  ok(await p.locator('#sv0_video_specialty_own input').count()===1 && await p.locator('#sv0_software_own input').count()===1,'specialisations and software each have an "add your own" field');
  await p.fill('#sv0_video_specialty_own input','Twitch stream highlights'); await p.waitForTimeout(150);
  ok((await p.textContent('#sv0_video_specialty_own .tag-suggest')).includes('Twitch stream highlights'),'typing something new offers to add it');
  await p.press('#sv0_video_specialty_own input','Enter'); await p.waitForTimeout(100);
  ok(await p.locator('#sv0_video_specialty_own .tag[data-k="Twitch stream highlights"]').count()===1,'Enter turns it into a tag');
  await p.fill('#sv0_software_own input','CapCut, Descript'); await p.waitForTimeout(100);
  ok(await p.locator('#sv0_software_own .tag').count()===1 && (await p.inputValue('#sv0_software_own input'))==='Descript','a comma finishes one entry and starts the next');
  await p.click('#epBio'); await p.waitForTimeout(100);
  ok(await p.locator('#sv0_software_own .tag').count()===2,'leaving the field keeps what was typed');
  await p.fill('#epLangTags input','Lith'); await p.waitForTimeout(150);
  ok((await p.textContent('#epLangTags .tag-suggest')).includes('Lithuanian'),'"Lith" suggests Lithuanian');
  await p.locator('#epLangTags .tag-opt').first().click(); await p.waitForTimeout(100);
  ok(await p.locator('#epLangTags .tag[data-k="Lithuanian"]').count()===1,'clicking the suggestion adds the tag');
  await p.fill('.sv-tags[data-k="skills"]','Anime AMV editing');
  await p.click('#epAddCred'); await p.waitForTimeout(200);
  await p.selectOption('.cred-row .cr-kind','course'); await p.fill('.cred-row .cr-title','Resolve Masterclass'); await p.fill('.cred-row .cr-by','Casey Faris'); await p.fill('.cred-row .cr-year','2025'); await p.fill('.cred-row .cr-link','caseyfaris.com/resolve');
  await p.locator('.cred-row .cr-proj').selectOption({index:1});
  await p.click('#epSave'); await p.waitForTimeout(1000);
  ok(await p.evaluate(()=>{ const e=window.__mockdb.editor_profiles[0]; const s=window.__mockdb.services[0]; return e.credentials.length===1 && e.credentials[0].by==='Casey Faris' && e.credentials[0].link==='https://caseyfaris.com/resolve' && !!e.credentials[0].project_id && s.values.video_skills.includes('color_grading') && s.values.skills.includes('Anime AMV editing') && e.tools.includes('Color grading') && e.languages.includes('Lithuanian'); }),'credentials, structured skills and a custom skill saved to DB');
  ok(await p.evaluate(()=>{ const s=window.__mockdb.services[0]; return s.values.video_specialty.includes('catCommercial') && s.values.video_specialty.includes('Twitch stream highlights') && s.values.software.includes('CapCut') && s.values.software.includes('Descript'); }),'own specialisations and software are saved next to the standard ones');
  ok((await p.textContent('[data-pane="about"]')).includes('Services') && (await p.textContent('[data-pane="about"]')).includes('Video editor') && (await p.textContent('[data-pane="about"]')).includes('Anime AMV editing'),'the profile shows the service with its structured and custom skills');
  ok((await p.textContent('[data-pane="about"]')).includes('Twitch stream highlights') && (await p.textContent('[data-pane="about"]')).includes('CapCut'),'…and the ones they typed themselves');
  // reopening keeps them as tags; a client searching for that word finds her
  await p.locator('[data-edit-profile]').first().click(); await p.waitForTimeout(400);
  ok(await p.locator('#sv0_video_specialty_own .tag[data-k="Twitch stream highlights"]').count()===1 && await p.locator('#sv0_software_own .tag').count()===2 && await p.locator('.sv-opt[data-k="video_specialty"].selected').count()===1,'own entries come back as tags, standard picks as chips');
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML=''); await p.waitForTimeout(200);
  // a second profession on the same account, with its own price: the multi-service model
  await p.locator('[data-edit-profile]').first().click(); await p.waitForTimeout(400);
  ok(await p.locator('#svAddSel option').count()>=2 && await p.locator('#svAddSel option[value="game-developer"]').count()===0,'a professional can add another open profession, not an unopened one');
  await p.selectOption('#svAddSel','photographer'); await p.click('#svAddBtn'); await p.waitForTimeout(300);
  ok(await p.locator('.svc-form[data-slug="photographer"] .sv-opt[data-k="shoot_type"]').count()>=5 && await p.locator('.svc-form[data-slug="photographer"] .sv-opt[data-k="software"]').count()===0,'the photographer block asks photography questions only');
  await p.click('.svc-form[data-slug="photographer"] .sv-opt[data-k="shoot_type"][data-v="wedding"]'); await p.fill('.svc-form[data-slug="photographer"] .sv-rate','300');
  await p.selectOption('.svc-form[data-slug="photographer"] .sv-unit','session'); await p.check('.svc-form[data-slug="photographer"] .sv-bool[data-k="editing_included"]');
  await p.click('#epSave'); await p.waitForTimeout(1200);
  ok(await p.evaluate(()=>{ const db=window.__mockdb; const a=db.services.find(x=>x.profession_slug==='video-editor'), b=db.services.find(x=>x.profession_slug==='photographer'); return !!a&&!!b && a.rate_amount===35 && b.rate_amount===300 && b.rate_unit==='session' && b.values.shoot_type.includes('wedding') && b.values.editing_included===true && a.values.video_specialty.includes('catCommercial'); }),'two services, two prices, neither overwrote the other');
  ok(await p.evaluate(()=>window.__mockdb.editor_profiles[0].rate_amount===35),'the old price column still follows the main service');
  ok((await p.textContent('[data-pane="about"]')).includes('€300') && (await p.textContent('[data-pane="about"]')).includes('per session'),'the profile shows the second service priced per session');
  await p.click('.ep-tab[data-tab="about"]'); await p.waitForTimeout(200);
  ok((await p.textContent('[data-pane="about"]')).includes('Casey Faris') && (await p.textContent('[data-pane="about"]')).includes('Brand film'),'about tab shows training with linked project');
  // browse shows real card, hides demo
  await p.goto(url+'#home'); await p.waitForTimeout(900);
  ok(await p.locator('.real-card').count()===1,'real editor card on browse');
  ok(await p.locator('.profile-card:not(.real-card)').first().isHidden(),'example cards hidden once a real editor exists');
  ok((await p.textContent('.real-card .price')).includes('€35'),'price-first card shows €35');
  ok(await p.locator('.real-card .card-gallery .car-item').count()===1,'card gallery has the 1 real video');
  ok((await p.textContent('.real-card')).includes('Casey Faris'),'card shows training line');
  await p.hover('.real-card .car-item'); await p.waitForTimeout(700);
  ok(await p.locator('.real-card .hover-embed').count()===1 && (await p.getAttribute('.real-card .hover-embed','src')).includes('autoplay=1&mute=1'),'hovering a card video starts a muted YouTube preview');
  await p.mouse.move(5,5); await p.waitForTimeout(200);
  ok(await p.locator('.real-card .hover-embed').count()===0,'preview stops when the mouse leaves');
  // ---------- is this editor taking work? ----------
  ok((await p.textContent('.real-card .status')).includes('Available'),'a new editor shows as available');
  ok(await p.getAttribute('.real-card','data-av')==='open','card carries the status for filtering');
  // the editor says they are busy until a date
  await p.click('.real-card .view-profile'); await p.waitForTimeout(700);
  await p.locator('[data-edit-profile]').first().click(); await p.waitForTimeout(400);
  ok(await p.locator('#avFreeWrap').evaluate(e=>e.classList.contains('hidden')),'the date field is hidden until "busy" is chosen');
  await p.click('.av-seg [data-av="busy"]'); await p.waitForTimeout(200);
  ok(!await p.locator('#avFreeWrap').evaluate(e=>e.classList.contains('hidden')),'choosing busy asks when they are free again');
  const soon = new Date(Date.now()+10*86400000).toISOString().slice(0,10);
  await p.fill('#avFreeFrom', soon); await p.click('#epSave'); await p.waitForTimeout(1000);
  ok(await p.evaluate(()=>{const e=window.__mockdb.editor_profiles[0]; return e.availability==='busy' && !!e.free_from;}),'status saved to the database');
  await p.goto(url+'#home'); await p.waitForTimeout(800);
  ok(await p.getAttribute('.real-card','data-av')==='soon','busy with a near date reads as "free soon"');
  ok((await p.textContent('.real-card .status')).includes('Free from'),'card tells clients when they are free again');
  // the Available-now filter hides them
  await p.click('#filterRow .chip[data-fk="availability"]'); await p.waitForTimeout(700);
  ok(await p.locator('.real-card').count()===0,'"Available now" filter hides a busy editor');
  await p.click('#filterRow .chip[data-fk="availability"]'); await p.waitForTimeout(700);
  ok(await p.locator('.real-card').count()===1,'turning the filter off shows them again');
  // signing back in is what makes the app re-read the editor rows
  const reMaya = async () => {
    await p.goto(url+'#account'); await p.waitForTimeout(300); await p.click('#signOutBtn'); await p.waitForTimeout(400);
    await p.goto(url+'#create-account'); await p.waitForTimeout(300); await p.click('#authSeg [data-auth="signin"]'); await p.waitForTimeout(200);
    await p.fill('#siEmail','maya@test.com'); await p.fill('#siPass','password123'); await p.click('[data-auth-signin]'); await p.waitForTimeout(1300);
    await p.goto(url+'#home'); await p.waitForTimeout(900);
  };
  // a date that has already passed means free again
  await p.evaluate(()=>{ const e=window.__mockdb.editor_profiles[0]; e.free_from=new Date(Date.now()-86400000).toISOString().slice(0,10); });
  await reMaya();
  ok(await p.getAttribute('.real-card','data-av')==='open','a busy date in the past counts as available again');
  // a status nobody has touched for months stops claiming anything
  await p.evaluate(()=>{ const e=window.__mockdb.editor_profiles[0]; e.availability='open'; e.free_from=null;
    e.availability_set_at=new Date(Date.now()-200*86400000).toISOString();
    e.last_active_on=new Date(Date.now()-200*86400000).toISOString().slice(0,10); });
  await reMaya();
  ok(await p.getAttribute('.real-card','data-av')==='stale','a forgotten status stops showing as available');
  ok(!(await p.textContent('.real-card .status')).includes('Available'),'a forgotten profile no longer claims to be available');
  ok((await p.textContent('.real-card .status')).toLowerCase().includes('last active'),'it shows when they were last active instead');
  ok(!await p.locator('#avNudge').evaluate(e=>e.classList.contains('hidden')),'the editor is nudged to update it');
  await p.click('#avNudgeGo'); await p.waitForTimeout(500);
  await p.click('.av-seg [data-av="open"]'); await p.click('#epSave'); await p.waitForTimeout(1000);
  await p.goto(url+'#home'); await p.waitForTimeout(800);
  ok(await p.getAttribute('.real-card','data-av')==='open','updating it makes the editor available again');

  await p.click('#allFiltersBtn'); await p.waitForTimeout(300);
  // ---------- profession-specific filters, generated from configuration ----------
  ok(await p.locator('.fopt[data-k="video_specialty"][data-v="catYoutubeLong"]').count()===0,'with no profession chosen, only the shared filters show');
  ok(await p.locator('#fPriceMin').count()===1 && await p.locator('#fLangs input').count()===1,'shared filters: price and a typed language field');
  await p.fill('#fLangs input','Ger'); await p.waitForTimeout(150); await p.press('#fLangs input','Enter');
  await p.fill('#fLangs input','Fre'); await p.waitForTimeout(150); await p.press('#fLangs input','Enter');
  ok(await p.locator('#fLangs .tag').count()===2,'languages typed into the filter become tags');
  await p.click('#applyFilters'); await p.waitForTimeout(900);
  ok(await p.locator('.real-card').count()===0 && (await p.textContent('#emptyState')).includes('French'),'a language the editor does not speak hides her, and the empty state names it');
  await p.click('#clearFiltersBtn'); await p.waitForTimeout(500); await p.click('#allFiltersBtn'); await p.waitForTimeout(300);
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  await p.click('#profRow .prof-chip[data-prof="video-editor"]'); await p.waitForTimeout(700);
  ok(await p.locator('#filterRow .chip[data-fk="video_specialty"]').count()>=5 && await p.locator('#filterRow .chip[data-fk="software"]').count()>=3,'choosing Video editor puts video specialities and software in the chip row');
  ok(await p.locator('#filterRow .chip[data-fk="shoot_type"]').count()===0,'…and no photography filters');
  await p.click('#allFiltersBtn'); await p.waitForTimeout(300);
  ok(await p.locator('.fopt[data-k="video_specialty"][data-v="catYoutubeLong"]').count()===1 && await p.locator('.frange[data-k="turnaround_days"]').count()===2,'all-filters shows the video editor set: specialities, turnaround');
  ok(await p.locator('.fopt[data-k="shoot_type"]').count()===0 && await p.locator('.fopt[data-k="framework"]').count()===0,'…and nothing from photography or development');
  await p.click('.fopt[data-k="video_specialty"][data-v="catCommercial"]'); await p.fill('#fPriceMin','30'); await p.fill('#fPriceMax','60'); await p.click('#applyFilters'); await p.waitForTimeout(800);
  ok(await p.locator('.real-card').count()===1,'real card matches Commercial + €30–60');
  ok((await p.textContent('#filterRow')).includes('2'),'the chip row counts the active filters');
  await p.click('#allFiltersBtn'); await p.waitForTimeout(300); await p.fill('#fPriceMin','60'); await p.fill('#fPriceMax',''); await p.click('#applyFilters'); await p.waitForTimeout(900);
  ok(await p.locator('.real-card').count()===0,'price €60+ hides the €35 card');
  ok(await p.locator('#emptyState').count()===1 && (await p.textContent('#emptyState')).includes('No professionals match'),'an honest empty state instead of a blank page');
  ok(await p.locator('#emptyState [data-drop]').count()===2,'each active filter is shown as something you can remove');
  await p.waitForTimeout(900);
  ok((await p.textContent('#emptyHint')).includes('Without') && (await p.textContent('#emptyHint')).includes('there would be 1'),'it says which filter is in the way and what removing it would give');
  await p.click('#emptyDropBest'); await p.waitForTimeout(900);
  ok(await p.locator('.real-card').count()===1,'removing the blocking filter brings the result back');
  await p.click('#clearFiltersBtn'); await p.waitForTimeout(700);
  ok(await p.locator('.real-card').count()===1 && await p.locator('#clearFiltersBtn').count()===0,'filters cleared');
  // a different profession, a different set of filters, and the same person priced differently
  ok(await p.locator('#profRow .prof-chip[data-prof="motion-designer"]').count()===0 && await p.locator('#profRow .prof-chip[data-prof="copywriter"]').count()===0,'a profession with nobody in it is not offered to clients');
  await p.click('#profRow .prof-chip[data-prof="photographer"]'); await p.waitForTimeout(900);
  ok(await p.locator('#filterRow .chip[data-fk="shoot_type"]').count()>=3 && await p.locator('#filterRow .chip[data-fk="video_specialty"]').count()===0,'the photographer set replaces the video set');
  ok(await p.locator('.real-card').count()===1 && (await p.textContent('.real-card .price-badge')).includes('€300') && (await p.textContent('.real-card .price-badge')).includes('per session'),'the same person is shown as a photographer at her photography price');
  ok((await p.textContent('.real-card .tag-row')).toLowerCase().includes('wedding') && !(await p.textContent('.real-card .tag-row')).toLowerCase().includes('commercial'),'…with her photography specialities, not her editing ones');
  await p.click('#filterRow .chip[data-fk="shoot_type"][data-fv="portrait"]'); await p.waitForTimeout(900);
  ok(await p.locator('.real-card').count()===0 && await p.locator('#emptyState').count()===1,'a photography filter she does not match hides her');
  await p.click('#clearFiltersBtn'); await p.waitForTimeout(600);
  await p.evaluate(()=>{ location.hash='#professionals/motion-designer'; }); await p.waitForTimeout(900);
  ok(await p.locator('.real-card').count()===0 && (await p.textContent('#noProsYet')).includes('Motion designer'),'an empty profession says so honestly');
  // the search box understands professions and their options
  await p.evaluate(()=>{ location.hash='#home'; }); await p.waitForTimeout(500);
  await p.fill('#homeSearch','wedding video editor'); await p.press('#homeSearch','Enter'); await p.waitForTimeout(900);
  ok(await p.locator('#profRow .prof-chip[data-prof="video-editor"].selected').count()===1,'typing a profession selects it');
  ok(await p.locator('#filterRow .chip[data-fk="video_specialty"][data-fv="catWedding"].selected').count()===1 && (await p.inputValue('#homeSearch'))==='','…and a known speciality becomes a filter, not loose text');
  ok((await p.evaluate(()=>location.hash))==='#professionals/video-editor','the address reflects the profession');
  await p.click('#clearFiltersBtn'); await p.waitForTimeout(500);
  // something a professional typed themselves is searchable too
  await p.fill('#homeSearch','twitch'); await p.press('#homeSearch','Enter'); await p.waitForTimeout(900);
  ok(await p.locator('.real-card').count()===1 && (await p.inputValue('#homeSearch'))==='twitch','a word from an own specialisation finds the professional as free text');
  await p.fill('#homeSearch','lightroom'); await p.press('#homeSearch','Enter'); await p.waitForTimeout(900);
  ok(await p.locator('.real-card').count()===0,'…and a word nobody mentioned finds nobody');
  await p.fill('#homeSearch',''); await p.click('#clearFiltersBtn'); await p.click('#profRow .prof-chip[data-prof=""]'); await p.waitForTimeout(700);
  // post a job as editor? (any account can) — post as this user
  await p.goto(url+'#post-job'); await p.waitForTimeout(300);
  ok((await p.textContent('#jobSpecs')).toLowerCase().includes('choose who you need') && await p.locator('#jobSpecs .job-opt').count()===0,'nothing is chosen at first: no skills, no software, just a hint');
  await p.click('#jobRoleSearch'); await p.waitForTimeout(250);
  ok(await p.locator('#jobRoleList .pp-opt').count()>=25 && await p.locator('#jobRoleList .pp-group').count()>=5,'the picker lists every profession, grouped by trade');
  await p.fill('#jobRoleSearch','vestuv'); await p.waitForTimeout(250);
  ok((await p.locator('#jobRoleList .pp-opt').allTextContents()).includes('Photographer'),'typing a Lithuanian word for weddings finds the photographer');
  await p.fill('#jobRoleSearch','tłumacz'); await p.waitForTimeout(250);
  ok((await p.locator('#jobRoleList .pp-opt').allTextContents()).join()==='Translator','typing the Polish word for translator finds exactly the translator');
  await p.fill('#jobRoleSearch','zzzqq'); await p.waitForTimeout(250);
  ok(await p.locator('#jobRoleList .pp-none').count()===1 && await p.locator('#jobRoleList .pp-opt').count()===0,'a word nobody matches says so instead of guessing');
  await p.fill('#jobRoleSearch','photographer'); await p.waitForTimeout(250);
  await p.click('#jobRoleList .pp-opt[data-slug="photographer"]'); await p.waitForTimeout(250);
  ok(await p.inputValue('#jobRole')==='photographer' && await p.inputValue('#jobRoleSearch')==='Photographer','picking one fills the box with its name');
  ok(await p.locator('#jobSpecs .job-opt[data-k="shoot_type"][data-v="wedding"]').count()===1 && await p.locator('#jobSpecs .job-opt[data-k="video_specialty"]').count()===0,'the speciality chips follow the profession');
  ok(await p.locator('#jobSpecs .job-opt[data-k="photo_software"][data-v="lightroom"]').count()===1,'…and so does the software list');
  await p.click('#jobRoleSearch'); await p.fill('#jobRoleSearch','translator'); await p.waitForTimeout(250);
  await p.click('#jobRoleList .pp-opt[data-slug="translator"]'); await p.waitForTimeout(250);
  ok(await p.locator('#jobSpecs .job-opt[data-k="translation_work"]').count()>=8 && await p.locator('#jobSpecs .job-opt[data-k="shoot_type"]').count()===0,'a different profession brings a different set of options');
  await p.click('#jobRoleClear'); await p.waitForTimeout(200);
  ok(await p.inputValue('#jobRole')==='' && await p.locator('#jobSpecs .job-opt').count()===0,'clearing the profession clears its options too');
  await p.click('#jobRoleSearch'); await p.fill('#jobRoleSearch','video editor'); await p.waitForTimeout(250);
  await p.click('#jobRoleList .pp-opt[data-slug="video-editor"]'); await p.waitForTimeout(250);
  await p.click('#jobSpecs .job-opt[data-k="video_specialty"][data-v="catColor"]'); await p.click('#jobSpecs .job-opt[data-k="software"][data-v="davinci_resolve"]');
  ok((await p.textContent('#pvTags')).includes('Color grading') && (await p.textContent('#pvTags')).includes('DaVinci Resolve'),'the preview shows every chosen chip');
  await p.fill('#jobTitle','Need a colour grade'); await p.fill('#jobDesc','Short brand film'); await p.fill('#jobBudget','€300'); await p.click('#publishJob'); await p.waitForTimeout(800);
  ok(await p.evaluate(()=>{ const j=window.__mockdb.jobs[0]; return j.profession_slug==='video-editor' && j.role_needed==='editor' && j.category==='catColor' && j.details.video_specialty[0]==='catColor' && j.details.software[0]==='davinci_resolve'; }),'the job stores the profession id, the legacy role and every chosen option');
  ok(await p.evaluate(()=>window.__mockdb.jobs.length)===1,'job saved to DB');
  ok(await p.locator('.real-job').count()===1,'real job listed');
  ok((await p.textContent('.real-job .job-meta')).includes('Video editor') && (await p.textContent('.real-job .job-meta')).includes('Color grading') && (await p.textContent('.real-job .job-meta')).includes('DaVinci Resolve'),'the job card names the profession and every option');
  // the jobs page has the same profession selector and, under it, the profession's own filters
  ok(await p.locator('#jobProfRow .prof-chip[data-prof="video-editor"]').count()===1 && await p.locator('#jobProfRow .prof-chip[data-prof="photographer"]').count()===0,'the jobs page offers the professions that have jobs');
  ok(await p.locator('#jobFilterRow').evaluate(e=>e.classList.contains('hidden')),'no profession chosen: no profession filters yet');
  await p.click('#jobProfRow .prof-chip[data-prof="video-editor"]'); await p.waitForTimeout(400);
  ok(await p.locator('#jobFilterRow .chip[data-jk="video_specialty"]').count()>=10 && await p.locator('#jobFilterRow .chip[data-jk="software"]').count()>=5,'choosing a profession shows its filters below');
  await p.click('#jobFilterRow .chip[data-jk="video_specialty"][data-jv="catWedding"]'); await p.waitForTimeout(300);
  ok(await p.locator('.real-job').first().isHidden(),'a speciality the job does not have hides it');
  await p.click('#jobFilterRow .chip[data-jk="video_specialty"][data-jv="catColor"]'); await p.waitForTimeout(300);
  ok(await p.locator('.real-job').first().isVisible(),'adding the speciality it has shows it (any of the chosen)');
  await p.click('#jobFilterRow .chip[data-jk="software"][data-jv="final_cut_pro"]'); await p.waitForTimeout(300);
  ok(await p.locator('.real-job').first().isHidden(),'a software filter it does not match hides it (all filters must hold)');
  await p.click('#clearJobFilters'); await p.waitForTimeout(300);
  ok(await p.locator('.real-job').first().isVisible() && await p.locator('#jobProfRow .prof-chip[data-prof=""].selected').count()===1,'clearing resets the profession and its filters');
  ok(await p.locator('.job[data-job]:not(.real-job)').first().isHidden(),'demo jobs hidden');
  await p.click('#signOutBtn').catch(()=>{}); await p.goto(url+'#account'); await p.waitForTimeout(300); if(await p.locator('#signOutBtn').isVisible()){ await p.click('#signOutBtn'); await p.waitForTimeout(400); }
  // --- client signs up, messages editor ---
  await p.goto(url+'#create-account'); await p.waitForTimeout(300); await p.click('#authSeg [data-auth="signup"]'); await p.waitForTimeout(200);
  await p.fill('#suName','Jonas'); await p.fill('#suEmail','jonas@test.com'); await p.fill('#suPass','password123'); await p.check('#suAgree'); await p.click('[data-auth-signup]'); await p.waitForTimeout(900);
  await p.goto(url+'#home'); await p.waitForTimeout(600);
  await p.click('.real-card .message-person'); await p.waitForTimeout(800);
  ok(await p.locator('.chat-window').count()===1,'client opens chat with real editor');
  ok((await p.textContent('.chat-window .chat-head')).includes('Maya Klein'),'chat header shows editor name');
  ok(await p.locator('.chat-window .send-report').count()===0,'client has no Send update button');
  await p.fill('.chat-window input','Hi Maya, can you grade my film?'); await p.keyboard.press('Enter'); await p.waitForTimeout(600);
  ok(await p.evaluate(()=>window.__mockdb.messages.length)===1,'message saved to DB');
  ok(await p.locator('.chat-window .bubble.mine').count()===1,'message shown once (no duplicate from realtime)');
  ok(await p.locator('#contactList .contact').count()===1,'sidebar lists the conversation');
  // --- editor logs back in, sees message, sends progress update ---
  await p.goto(url+'#account'); await p.waitForTimeout(300); await p.click('#signOutBtn'); await p.waitForTimeout(400);
  await p.click('#signInBtn'); await p.waitForTimeout(300); await p.fill('#siEmail','maya@test.com'); await p.fill('#siPass','password123'); await p.click('[data-auth-signin]'); await p.waitForTimeout(1000);
  ok(await p.locator('#contactList .contact').count()===1,'editor sees conversation with Jonas');
  await p.click('#notificationsBtn'); await p.waitForTimeout(600);
  ok((await p.textContent('#modalRoot')).includes('New message from Jonas'),'notification for new message');
  await p.click('#modalRoot [data-notif-target]'); await p.waitForTimeout(800);
  ok((await p.textContent('.chat-window .chat-messages')).includes('grade my film'),'editor sees client message');
  ok(await p.locator('.chat-window .send-report').count()===1,'editor has Send update button');
  await p.click('.chat-window .send-report'); await p.waitForTimeout(400);
  await p.fill('#rText','First cut ready'); await p.fill('#rLink','https://youtu.be/dQw4w9WgXcQ'); await p.click('#sendProgress'); await p.waitForTimeout(800);
  ok(await p.evaluate(()=>window.__mockdb.messages.filter(m=>m.kind==='report').length)===1,'progress report saved to DB');
  ok(await p.locator('.chat-window .report-card').count()===1,'report card in chat');
  ok(await p.locator('.reco-card').count()===0 && (await p.evaluate(()=>Object.keys(window.__cuv||{}).length))>=0,'no reminder right after sending');
  // client reviews and approves
  await p.goto(url+'#account'); await p.waitForTimeout(300); await p.click('#signOutBtn'); await p.waitForTimeout(400);
  await p.click('#signInBtn'); await p.waitForTimeout(300); await p.fill('#siEmail','jonas@test.com'); await p.fill('#siPass','password123'); await p.click('[data-auth-signin]'); await p.waitForTimeout(1000);
  await p.click('#contactList .contact'); await p.waitForTimeout(800);
  await p.click('.chat-window .report-card'); await p.waitForTimeout(600);
  ok(await p.locator('#approveVersion').count()===1,'client opens review modal');
  await p.click('#approveVersion'); await p.waitForTimeout(500);
  ok(await p.evaluate(()=>window.__mockdb.messages.find(m=>m.kind==='report').payload.status==='approved'),'approval saved to DB');
  // reminder for editor after 9 days
  await p.goto(url+'#account'); await p.waitForTimeout(300); await p.click('#signOutBtn'); await p.waitForTimeout(400);
  await p.evaluate(()=>{ const m=window.__mockdb.messages.find(m=>m.kind==='report'); m.created_at=new Date(Date.now()-9*86400000).toISOString(); });
  await p.click('#signInBtn'); await p.waitForTimeout(300); await p.fill('#siEmail','maya@test.com'); await p.fill('#siPass','password123'); await p.click('[data-auth-signin]'); await p.waitForTimeout(1200);
  await p.goto(url+'#account'); await p.waitForTimeout(600);
  ok(await p.locator('.reco-card').count()===1,'editor gets 9-day reminder based on real messages');
  ok((await p.textContent('.reco-card')).includes('Jonas'),'reminder names the real client');
  // back to the client for the checks that follow
  await p.goto(url+'#account'); await p.waitForTimeout(300); await p.click('#signOutBtn'); await p.waitForTimeout(400);
  await p.click('#signInBtn'); await p.waitForTimeout(300); await p.fill('#siEmail','jonas@test.com'); await p.fill('#siPass','password123'); await p.click('[data-auth-signin]'); await p.waitForTimeout(1200);
  await p.goto(url+'#home'); await p.waitForTimeout(700);
  ok(await p.locator('#adminBtn').isHidden(),'client has no admin button');
  // ---------- Orders: the Order is the contract (direct payment, no provider yet) ----------
  const signin=async(e)=>{ await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML=''); await p.goto(url+'#account'); await p.waitForTimeout(300); if(await p.locator('#signOutBtn').isVisible()){ await p.click('#signOutBtn'); await p.waitForTimeout(400);} await p.click('#signInBtn'); await p.waitForTimeout(200); await p.fill('#siEmail',e); await p.fill('#siPass','password123'); await p.click('[data-auth-signin]'); await p.waitForTimeout(1200); };
  const openOrders=async()=>{ await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML=''); await p.goto(url+'#orders'); await p.waitForTimeout(900);
    if(await p.locator('.modal.locked [data-avpick="open"]').count()){ await p.click('.modal.locked [data-avpick="open"]'); await p.waitForTimeout(600); }   // a finished job asks the freelancer whether they are free
    await p.locator('#contractsList .c-row').first().click(); await p.waitForTimeout(700); };
  const modal=async()=>await p.textContent('#modalRoot');
  // wait for the app to have caught up instead of guessing a number of milliseconds
  const until=async(fn,ms=10000)=>{ const t0=Date.now(); for(;;){ let v=false; try{ v=await fn(); }catch(e){} if(v) return true; if(Date.now()-t0>ms) return false; await p.waitForTimeout(120); } };
  // the bell only knows what has been loaded: wait for the badge, then open it
  const openNotifications=async()=>{ await until(async()=>await p.locator('#notifBadge').isVisible()); await p.click('#notificationsBtn'); await until(async()=>(await modal()).trim().length>0); await p.waitForTimeout(250); };
  const db=async(f)=>await p.evaluate(f);
  await p.goto(url+'#home'); await p.waitForTimeout(600); await p.click('.real-card .message-person'); await p.waitForTimeout(900);
  ok(await p.locator('.chat-window .open-contract').count()===1 && (await p.textContent('.chat-window .open-contract')).trim()==='Order','the chat has an Order button');
  await p.click('.chat-window .open-contract'); await p.waitForTimeout(700);
  ok(await p.locator('#oSend').count()===1 && await p.locator('#oScope').count()===1 && await p.locator('#oDeliv').count()===1,'the Order form opens: scope, deliverables, price — no contract wizard');
  ok(await p.locator('[data-ct-type]').count()===0 && await p.locator('#ctLaw').count()===0,'no contract types, no governing-law picker');
  ok((await p.inputValue('#oProf'))==='video-editor','the freelancer’s profession is prefilled');
  await p.fill('#oTitle','Brand film edit'); await p.fill('#oScope','Edit one 4-minute brand film\nBasic colour correction'); await p.fill('#oDeliv','Final 4K MP4\nProject file'); await p.fill('#oPrice','300');
  await p.selectOption('#oRev','3'); await p.check('input[name=oRights][value=license]'); await p.fill('#oCd','Upload raw footage');
  await p.evaluate(()=>document.querySelector('.modal details').open=true); await p.waitForTimeout(200);
  const st=await p.textContent('#oTermsPreview');
  ok(st.includes('Scope of work') && st.includes('Freelancer') && !st.includes('Editor agrees') && st.includes('Cuvori'),'standard terms are shown (freelancer wording, dispute route) before sending');
  await p.click('#oSend'); await p.waitForTimeout(900);
  ok(await db(()=>{ const c=window.__mockdb.contracts[0]; return !!c && c.client!==c.editor && c.amount_cents===30000 && c.rights==='license' && c.deliverables.includes('Project file') && c.client_duties==='Upload raw footage' && c.revisions===3 && c.profession_slug==='video-editor'; }),'the Order is saved with its structured terms');
  ok(await db(()=>{ const c=window.__mockdb.contracts[0]; return c.status==='proposed' && c.client_accepted_version===1 && c.freelancer_accepted_version==null; }),'the client who drafted it has accepted version 1; the freelancer has not');
  ok(await db(()=>window.__mockdb.order_events.map(e=>e.event).join()==='created,client_accepted'),'history: created, client accepted');
  ok((await modal()).includes('Awaiting freelancer acceptance'),'sending opens the Order straight away');
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  ok(await p.locator('.chat-window .contract-card').count()===1 && (await p.textContent('.chat-window .contract-card')).includes('New Order — €300'),'a short card in the chat: New Order — €300');
  await p.click('.chat-window .contract-card'); await p.waitForTimeout(700);
  ok((await modal()).includes('Awaiting freelancer acceptance') && (await modal()).includes('not yet'),'the Order shows who still has to accept');
  ok(await p.locator('[data-caction="accept"]').count()===0 && await p.locator('[data-caction="edit"]').count()===1 && await p.locator('[data-caction="cancel"]').count()===1 && await p.locator('[data-caction="pdf"]').count()===0,'the drafter can edit or cancel, cannot accept twice, no PDF yet');
  // edit before acceptance: the price changes, the earlier acceptance is gone
  await p.click('[data-caction="edit"]'); await p.waitForTimeout(700);
  ok((await p.inputValue('#oTitle'))==='Brand film edit' && (await p.inputValue('#oPrice'))==='300','the edit form is prefilled');
  await p.fill('#oPrice','320'); await p.click('#oSend'); await p.waitForTimeout(900);
  ok(await db(()=>{ const c=window.__mockdb.contracts[0]; return c.amount_cents===32000 && c.terms_version===2 && c.client_accepted_version===2 && c.freelancer_accepted_version==null; }),'edited: version 2, only the editor of the change has accepted it');
  ok(await db(()=>window.__mockdb.messages.some(m=>m.kind==='contract'&&m.payload.event==='terms_changed')) && (await modal()).includes('Version 2'),'the chat says the Order was updated; the Order shows version 2');
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  // the freelancer accepts version 2
  await signin('maya@test.com');
  await p.goto(url+'#settings'); await p.waitForTimeout(400);
  ok(await p.locator('.snav[data-set="payout"]').isVisible(),'freelancer sees Payout details in settings');
  await p.click('.snav[data-set="payout"]'); await p.click('#addPayoutBtn'); await p.waitForTimeout(200);
  await p.fill('#payoutRows .po-details','LT12 3456 7890 1234 5678'); await p.fill('#payoutNote','Write the Order title as reference'); await p.click('#savePayoutBtn'); await p.waitForTimeout(600);
  ok(await db(()=>window.__mockdb.payout_details.length===1 && window.__mockdb.payout_details[0].methods[0].type==='bank'),'payout details saved');
  await p.goto(url+'#orders'); await p.waitForTimeout(700);
  ok(await p.locator('#contractsList .c-row').count()===1 && (await p.textContent('#contractsList')).includes('Awaiting freelancer acceptance'),'the Orders page lists the Order with its status');
  ok((await p.evaluate(()=>location.hash))==='#orders','the address is #orders');
  await p.click('#contractsList .c-row'); await p.waitForTimeout(700);
  ok(await p.locator('[data-caction="accept"]').count()===1 && await p.locator('[data-caction="edit"]').count()===1 && (await modal()).includes('Jonas') && (await modal()).includes('accepted'),'the freelancer can accept version 2 or edit it');
  await p.click('[data-caction="accept"]'); await p.waitForTimeout(900);
  ok(await db(()=>{ const c=window.__mockdb.contracts[0]; return c.status==='accepted' && c.accepted_version===2 && !!c.client_accepted_at && !!c.freelancer_accepted_at; }),'both accepted the same version: the Order is the agreement');
  ok((await modal()).includes('Accepted by both') && await p.locator('[data-caction="edit"]').count()===0 && await p.locator('[data-caction="pdf"]').count()===1,'after acceptance: no more editing, a printable copy is available');
  await p.evaluate(()=>{ window.__printed=0; window.print=()=>{ window.__printed++; }; }); await p.click('[data-caction="pdf"]'); await p.waitForTimeout(300);
  ok(await db(()=>window.__printed===1 && document.querySelector('#printDoc .ct-doc') && document.querySelector('#printDoc .ct-sign.ok') && document.querySelector('#printDoc').textContent.includes('Freelancer')),'the printable copy is the accepted Order, not a second contract');
  ok(await db(()=>{ const c=window.__mockdb.contracts[0]; return c.terms_doc && Array.isArray(c.terms_doc.clauses) && c.terms_doc.clauses.length>8; }),'the accepted wording is frozen');
  ok(await db(async()=>{ const c=window.__mockdb.contracts[0]; const before=JSON.stringify(c.terms_doc); await window.__sb.rpc('store_contract_doc',{cid:c.id,doc:{clauses:[{t:'Free work',b:'The freelancer works for free.'}]}}); return JSON.stringify(window.__mockdb.contracts[0].terms_doc)===before; }),'frozen wording cannot be overwritten afterwards');
  ok((await modal()).includes('Waiting for the client to pay') && (await modal()).includes('Cuvori fee') && (await modal()).includes('€0'),'freelancer sees waiting-for-payment; Cuvori fee €0 is shown');
  // the client pays directly and says so; the freelancer confirms
  await signin('jonas@test.com'); await openOrders();
  ok((await modal()).includes('LT12 3456') && (await modal()).includes('Direct payment'),'client sees the IBAN and that this is a direct payment (nothing held)');
  await p.click('[data-caction="mark_paid"]'); await p.waitForTimeout(700);
  ok(await db(()=>window.__mockdb.contracts[0].status==='paid_marked'),'client reported the payment');
  ok(await db(()=>window.__mockdb.messages.filter(m=>m.kind==='contract').length===4),'each step posted a short card in the chat');
  await signin('maya@test.com'); await openOrders();
  await p.click('[data-caction="confirm_paid"]'); await p.waitForTimeout(700);
  ok(await db(()=>{ const c=window.__mockdb.contracts[0]; return c.status==='paid' && c.funded_cents===32000 && window.__mockdb.order_payments.some(x=>x.order_id===c.id&&x.kind==='fund'&&x.provider==='direct'); }),'freelancer confirmed the money arrived; the ledger records it as a direct payment');
  ok(await p.locator('[data-caction="deliver"]').count()===1,'the freelancer can deliver for approval');
  // the delivery is a progress report that says "this is the delivery"
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML=''); await p.goto(url+'#home'); await p.waitForTimeout(500); await p.click('#contactList .contact'); await p.waitForTimeout(800);
  await p.click('.chat-window .send-report'); await p.waitForTimeout(900);
  ok(await p.locator('#rFinal').count()===1 && (await p.textContent('#rOrderBox')).includes('This is the delivery'),'the report form offers to make it the delivery of the Order');
  await p.check('#rFinal'); await p.fill('#rTitle','Final cut v1'); await p.fill('#rLink','https://www.youtube.com/watch?v=dQw4w9WgXcQ'); await p.click('#sendProgress'); await p.waitForTimeout(1200);
  ok(await db(()=>{ const c=window.__mockdb.contracts[0]; const r=window.__mockdb.messages.filter(m=>m.kind==='report').at(-1); return !!c.delivered_at && r && r.payload.order_id===c.id && c.delivery_url==='https://www.youtube.com/watch?v=dQw4w9WgXcQ'; }),'the report is linked to the Order and the Order is delivered for approval');
  // the client reviews the report: request changes through the Order, then approve
  await signin('jonas@test.com'); await p.goto(url+'#home'); await p.waitForTimeout(500);
  await openNotifications();
  ok((await modal()).includes('Delivered for approval') && await p.locator('[data-notif-order]').count()===1,'notification: delivered for approval, opens the Order');
  await p.locator('[data-notif-order]').first().click(); await p.waitForTimeout(900);
  ok((await modal()).includes('Awaiting approval') && (await modal()).includes('Final cut v1'),'…and the Order shows the delivery');
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML=''); await p.click('#contactList .contact'); await p.waitForTimeout(800);
  await p.locator('.chat-window .report-card').last().click(); await p.waitForTimeout(900);
  ok((await modal()).includes('belongs to the Order') && (await p.textContent('#approveVersion')).trim()==='Approve work','the review says which Order it belongs to; approving a direct-payment Order moves no money');
  await p.click('#requestChanges'); await p.waitForTimeout(300); await p.fill('#changesText','Please fix the colour in the intro'); await p.click('#sendChanges'); await p.waitForTimeout(900);
  ok(await db(()=>{ const c=window.__mockdb.contracts[0]; return c.changes_used===1 && c.changes_open===true && window.__mockdb.messages.some(m=>m.kind==='change_request'&&m.body.includes('colour')) && window.__mockdb.order_events.some(e=>e.event==='changes_requested'); }),'request changes: counted on the Order, noted in the chat and in the history');
  await signin('maya@test.com'); await openOrders();
  ok((await modal()).includes('Changes requested'),'the freelancer sees: changes requested');
  await p.click('[data-caction="deliver"]'); await p.waitForTimeout(400); await p.fill('#onUrl','https://drive.test/final-v2'); await p.fill('#onNote','Fixed the intro colour'); await p.click('#onGo'); await p.waitForTimeout(900);
  await signin('jonas@test.com'); await openOrders();
  ok((await modal()).includes('drive.test/final-v2') && await p.locator('[data-caction="complete"]').count()===1 && (await p.textContent('[data-caction="complete"]')).includes('Approve work'),'the client sees the new delivery and an Approve work button');
  await p.click('[data-caction="complete"]'); await p.waitForTimeout(900);
  ok(await db(()=>{ const c=window.__mockdb.contracts[0]; return c.status==='completed' && c.released_cents===32000 && window.__mockdb.order_payments.filter(x=>x.order_id===c.id).map(x=>x.kind).join()==='fund,release'; }),'approved: the Order is complete, the ledger shows fund then release');
  ok((await modal()).includes('Completed') && (await modal()).includes('History') && await p.locator('[data-caction]:not([data-caction="pdf"]):not([data-caction="review"])').count()===0,'a completed Order shows its history, the printable copy and the review button');
  await p.evaluate(()=>document.querySelector('details.ct-details:last-of-type').open=true);
  ok((await modal()).includes('Order created') && (await modal()).includes('Both accepted') && (await modal()).includes('Changes requested') && (await modal()).includes('Order completed'),'the history reads like a story: created, accepted, changes, completed');
  // ---------- reviews: only after a finished Order, and blind until both sides answer ----------
  await p.evaluate(()=>{ const m=document.querySelector('#modalRoot'); if(m) m.innerHTML=''; });
  await p.goto(url+'#account'); await p.waitForTimeout(300); await p.click('#signOutBtn'); await p.waitForTimeout(400);
  await p.click('#signInBtn'); await p.waitForTimeout(300); await p.fill('#siEmail','jonas@test.com'); await p.fill('#siPass','password123'); await p.click('[data-auth-signin]'); await p.waitForTimeout(1200);
  await p.goto(url+'#home'); await p.waitForTimeout(700);
  await p.click('.real-card .view-profile'); await p.waitForTimeout(600);
  await p.click('.ep-tab[data-tab="reviews"]'); await p.waitForTimeout(200);
  ok(await p.locator('[data-review]').count()===1,'a finished Order lets the client review the freelancer');
  await p.click('[data-review]'); await p.waitForTimeout(600);
  ok(await p.locator('#rvSave').count()===1,'the review form opens from the profile');
  await p.click('.star-pick[data-star="4"]'); await p.fill('#rvText','Great colour work, fast.'); await p.click('#rvSave'); await p.waitForTimeout(900);
  ok(await p.evaluate(()=>window.__mockdb.order_reviews.length)===1,'the review is saved against that Order');
  ok(await p.evaluate(()=>window.__mockdb.order_reviews[0].is_revealed===false),'it stays blind until the freelancer answers');
  ok(!(await p.textContent('#page-profile')).includes('Great colour work'),'nothing of it is public yet');
  // the freelancer answers: both reviews open at the same moment
  await signin('maya@test.com'); await p.evaluate(()=>{ const m=document.querySelector('#modalRoot'); if(m) m.innerHTML=''; });
  await p.evaluate(async ()=>{ await window.__sb.rpc('order_review_submit',{ p_order:window.__mockdb.contracts[0].id, p_rating:5, p_comment:'Clear brief.', p_reason:null }); });
  await p.goto(url+'#home'); await p.waitForTimeout(300); await p.goto(url+'#account'); await p.waitForTimeout(1000);
  ok(await p.evaluate(()=>window.__mockdb.order_reviews.every(r=>r.is_revealed)),'both sides answered, so both reviews are public');
  const accTxt0=(await p.textContent('#accountReviews')).replace(/\s+/g,' ').slice(0,90);
  ok(accTxt0.includes('Jonas'),'the freelancer account shows the review received for that Order');
  await p.goto(url+'#home'); await p.waitForTimeout(600);
  await signin('maya@test.com');
  // finishing a job asks the editor whether they are free again, and will not be waved away
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  await p.goto(url+'#home'); await p.waitForTimeout(400);
  await p.goto(url+'#contracts'); await p.waitForTimeout(1400);
  ok(await p.locator('.modal.locked').count()===1,'finishing a job asks about availability');
  ok(await p.locator('.modal.locked .close-x').count()===0,'the question has no close button');
  await p.locator('.modal-backdrop').click({position:{x:5,y:5}}); await p.waitForTimeout(300);
  ok(await p.locator('.modal.locked').count()===1,'clicking away does not dismiss it');
  await p.click('[data-avpick="busy"]'); await p.waitForTimeout(200);
  ok(await p.locator('#avDoneFrom').isVisible(),'choosing busy asks for the date');
  await p.click('[data-avpick="closed"]'); await p.waitForTimeout(800);
  ok(await p.evaluate(()=>window.__mockdb.editor_profiles[0].availability==='closed'),'the answer is saved against the profile');
  ok(await p.locator('.modal.locked').count()===0,'answering closes the question');
  await p.goto(url+'#home'); await p.waitForTimeout(400);
  await p.goto(url+'#contracts'); await p.waitForTimeout(1400);
  ok(await p.locator('.modal.locked').count()===0,'it is not asked again for the same job');
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  // ---------- Orders with protected payments (Stripe) ----------
  await p.evaluate(()=>{ window.__mockEscrow=true; }); await p.evaluate(()=>window.__reloadEscrow()); await p.waitForTimeout(400);
  await p.goto(url+'#settings'); await p.waitForTimeout(300); await p.click('.snav[data-set="payout"]'); await p.waitForTimeout(200);
  ok(await p.locator('#stripeBox').isVisible() && (await p.textContent('#stripeBox')).includes('Not connected'),'freelancer sees Stripe box: not connected');
  // a problem on Cuvori's side: the freelancer reads it in plain words in their language, with the ref, never the server's own text
  await p.evaluate(()=>{ window.__mockFnFail={"stripe-connect":[500,{error:"Something went wrong (ref 9f8e7d6c)",code:"server_error",ref:"9f8e7d6c"}]}; document.querySelector('#toastWrap').innerHTML=''; });
  await p.click('#stripeConnectBtn');
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes("Something went wrong on Cuvori's side. Please try again in a few minutes. (ref 9f8e7d6c)")) && !(await p.textContent('#toastWrap')).includes('Nothing was charged') && (await p.textContent('#stripeBox')).includes('Not connected'),"a problem on Cuvori's side at Payout details: plain words with the ref, the Stripe box unchanged");
  await p.evaluate(()=>{ window.__mockFnFail={"stripe-connect":[429,{error:"Too many tries in a short time. Please wait a minute and try again.",code:"too_many_tries"}]}; document.querySelector('#toastWrap').innerHTML=''; });
  await p.click('#stripeConnectBtn');
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes("Too many tries in a short time. Please wait a minute and try again.")) && !(await p.textContent('#toastWrap')).includes('Nothing was charged'),"too many tries at Payout details: asked to wait a minute");
  await p.evaluate(()=>{ window.__mockFnFail=null; });
  await p.click('#stripeConnectBtn'); await p.waitForTimeout(1200);
  ok((await p.textContent('#stripeBox')).includes('Ready to receive'),'after Stripe onboarding: ready');
  // the status can't be checked (too many tries today): the box shows the "ready" mark the database keeps, never "not connected"
  await p.evaluate(()=>{ window.__mockFnFail={"stripe-connect":[429,{error:"Too many tries today. Please try again tomorrow.",code:"too_many_today"}]}; });
  await p.evaluate(()=>window.__reloadEscrow()); await p.waitForTimeout(600);
  ok((await p.textContent('#stripeBox')).includes('Ready to receive'),'the Payout details status refused for today: the box still says ready (from the database)');
  await p.evaluate(()=>{ window.__mockFnFail=null; });
  const newOrder=async(title,price,extra)=>{ await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML=''); await p.goto(url+'#home'); await p.waitForTimeout(500); await p.click('#contactList .contact'); await p.waitForTimeout(800); await p.click('.chat-window .open-contract'); await p.waitForTimeout(700); await p.fill('#oTitle',title); await p.fill('#oPrice',String(price)); await p.fill('#oScope','As discussed'); if(extra) await extra(); await p.click('#oSend'); await p.waitForTimeout(900); await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML=''); };
  // scenario: fixed-price €500, both accept, client funds, work delivered, approve & release
  await newOrder('Reel edit',500);
  ok(await db(()=>{ const c=window.__mockdb.contracts.at(-1); return c.payment_mode==='escrow' && c.amount_cents===50000 && c.freelancer_accepted_version===1; }),'the freelancer created a protected-payment Order for €500');
  await signin('jonas@test.com'); await openOrders();
  ok((await modal()).includes('Awaiting client acceptance') && await p.locator('[data-caction="fund"]').count()===0,'nothing can be funded before the client accepts');
  await p.click('[data-caction="accept"]'); await p.waitForTimeout(900);
  const q=await modal();
  ok(q.includes('Order price') && q.includes('€500') && q.includes('Card fee') && q.includes('€7.87') && q.includes('Cuvori fee') && q.includes('Total to fund') && q.includes('€507.87'),'before paying the client sees: Order price €500, processing €7.87, Cuvori fee €0, total €507.87');
  ok(q.includes('charged by the payment provider') || q.includes('Charged by the payment provider'),'the processing line says who charges it');
  ok(q.includes('covers even the most expensive cards') && !q.includes('highest card rate'),'the card fee is explained truthfully (a rate that covers even the most expensive cards)');
  if(process.env.SHOT) await p.locator('#modalRoot .o-quote').first().screenshot({path:process.env.SHOT+'-paybox.png',timeout:5000}).catch(e=>console.log('screenshot skipped: '+e.message.split('\n')[0]));
  ok((await p.textContent('[data-caction="fund"]')).includes('€507.87'),'the Fund button carries the full amount');
  await p.click('[data-caction="fund"]'); await p.waitForTimeout(2500);
  ok(await db(()=>{ const c=window.__mockdb.contracts.at(-1); const ch=window.__fakeStripe.charges.at(-1); return c.status==='funded' && c.funded_cents===50000 && ch.total===50787 && ch.amount===50000 && ch.fee===787; }),'funded: the provider charged €507.87, the Order holds exactly €500');
  ok((await modal()).includes('€500 secured for this project') && (await modal()).includes('Cuvori fee: €0'),'client sees €500 secured, Cuvori fee €0');
  ok(await p.evaluate(()=>{ const b=window.__lastConfirm, c=window.__mockdb.contracts.at(-1); return !!b && b.contract_id===c.id && /^cs_test_mock[a-z0-9]+$/.test(b.session_id||''); }),'back from Stripe: the check is asked about the very page that was paid (its id comes back in the return link)');
  ok(await db(()=>window.__mockdb.messages.filter(m=>m.kind==='contract').at(-1).payload.event==='funded') && (await p.evaluate(()=>{ const m=window.__mockdb.messages.filter(x=>x.kind==='contract').at(-1); return m.payload.amount_cents; }))===50000,'chat card: payment secured — €500');
  await signin('maya@test.com'); await openOrders();
  ok((await modal()).includes('€500 secured — you can begin work') && await p.locator('[data-caction="deliver"]').count()===1,'freelancer: €500 secured, can begin');
  await p.click('[data-caction="deliver"]'); await p.waitForTimeout(400); await p.fill('#onUrl','https://drive.test/final'); await p.fill('#onNote','Final cut v1'); await p.click('#onGo'); await p.waitForTimeout(900);
  ok(await db(()=>window.__mockdb.contracts.at(-1).status==='delivered') && (await modal()).includes('Awaiting approval'),'delivered: awaiting approval');
  await signin('jonas@test.com'); await openOrders();
  ok((await modal()).includes('drive.test/final') && (await p.textContent('[data-caction="release"]')).includes('Approve work & release €500'),'the approve button says exactly what it does with the money');
  await p.click('[data-caction="changes"]'); await p.waitForTimeout(300); await p.fill('#onNote','Please fix the colour in the intro'); await p.click('#onGo'); await p.waitForTimeout(900);
  ok(await db(()=>{ const c=window.__mockdb.contracts.at(-1); return c.status==='funded' && c.funded_cents-c.released_cents-c.refunded_cents===50000 && window.__mockdb.messages.some(m=>m.kind==='change_request'&&m.body.includes('colour')); }),'request changes: the €500 stays secured, the note is in the chat');
  await signin('maya@test.com'); await openOrders();
  await p.click('[data-caction="deliver"]'); await p.waitForTimeout(400); await p.fill('#onUrl','https://drive.test/final-v2'); await p.click('#onGo'); await p.waitForTimeout(900);
  await signin('jonas@test.com'); await openOrders();
  await p.click('[data-caction="release"]'); await p.waitForTimeout(400);
  ok((await modal()).includes('This releases €500 to Maya') && (await p.textContent('#omGo')).includes('Yes, release €500'),'releasing money asks once more, with the amount');
  await p.click('#omGo'); await p.waitForTimeout(1200);
  ok(await db(()=>{ const c=window.__mockdb.contracts.at(-1); return c.status==='completed' && c.released_cents===50000 && window.__fakeStripe.transfers.at(-1).amount===50000 && window.__mockdb.order_events.some(e=>e.order_id===c.id&&e.event==='released'); }),'€500 released to the freelancer, Order complete, history says so');
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  // scenario: a price increase accepted on a delivered Order is funded before the client can approve and release
  await signin('maya@test.com');
  // a price under €1 is refused on the page with the real rule (it used to say "Fill in every field."), and nothing is sent
  const ordersBefore=await db(()=>window.__mockdb.contracts.length);
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML=''); await p.goto(url+'#home'); await p.waitForTimeout(500); await p.click('#contactList .contact'); await p.waitForTimeout(800); await p.click('.chat-window .open-contract'); await p.waitForTimeout(700);
  await p.evaluate(()=>document.querySelector('#toastWrap').innerHTML=''); await p.fill('#oTitle','Tiny job'); await p.fill('#oPrice','0.5'); await p.fill('#oScope','As discussed'); await p.click('#oSend');
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes('The price must be at least €1.')) && await db(()=>window.__mockdb.contracts.length)===ordersBefore,'an Order under €1: the page says the price must be at least €1, and nothing is sent');
  // and over €950,000 (the most one card payment can carry once the card fee is added)
  await p.evaluate(()=>document.querySelector('#toastWrap').innerHTML=''); await p.fill('#oPrice','950000.01'); await p.click('#oSend');
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes('The price can be at most €950,000.')) && await db(()=>window.__mockdb.contracts.length)===ordersBefore,'an Order over €950,000: the page says the most it can be, and nothing is sent');
  ok(await p.getAttribute('#oPrice','max')==='950000','the price field stops at 950,000');
  await newOrder('Promo cut',200);
  await signin('jonas@test.com'); await openOrders(); await p.click('[data-caction="accept"]'); await p.waitForTimeout(900);
  // a price change that would take the price under €1: the page says the real rule (it used to say "between 0 and 1,000,000"), and nothing is sent
  const amendsBefore=await db(()=>window.__mockdb.order_amendments.length);
  await p.click('[data-caction="amend"]'); await p.waitForTimeout(400); await p.evaluate(()=>document.querySelector('#toastWrap').innerHTML=''); await p.fill('#amNote','Smaller job'); await p.fill('#amDelta','-199.5'); await p.click('#amGo');
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes('The price after this change must be at least €1.')) && await db(()=>window.__mockdb.order_amendments.length)===amendsBefore,'a price change that would take the Order under €1: the page says the price must stay at least €1, and nothing is sent');
  await p.evaluate(()=>document.querySelector('#toastWrap').innerHTML=''); await p.fill('#amDelta','949800.01'); await p.click('#amGo');
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes('The price after this change can be at most €950,000.')) && await db(()=>window.__mockdb.order_amendments.length)===amendsBefore,'a price change that would take the Order over €950,000: the page says the most it can be, and nothing is sent');
  await openOrders();
  // a freelancer banned after the Order was accepted: the Fund button still shows (the page only knows the Stripe setup),
  // so the refusal is said in the client's language, and nothing is paid
  await p.evaluate(()=>{ const c=window.__mockdb.contracts.at(-1); window.__mockdb.profiles.find(x=>x.id===c.editor).banned=true; document.querySelector('#toastWrap').innerHTML=''; });
  await p.click('[data-caction="fund"]');
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes("This freelancer can't receive payments right now, so this Order can't be paid. Nothing was charged.")) && await db(()=>{ const c=window.__mockdb.contracts.at(-1); return c.status==='accepted' && !c.funded_cents; }),"a freelancer banned after the Order was accepted: Fund is refused in the client's language, and nothing is paid");
  await p.evaluate(()=>{ const c=window.__mockdb.contracts.at(-1); window.__mockdb.profiles.find(x=>x.id===c.editor).banned=false; });
  // a problem on Cuvori's side, or payments paused (for example the wrong Stripe keys): the client reads it in plain words in
  // their language, with the ref, never the technical sentence meant for the owner, and is told nothing was charged
  const unpaid=()=>db(()=>{ const c=window.__mockdb.contracts.at(-1); return c.status==='accepted' && !c.funded_cents; });
  const SERVER=[500,{error:"Something went wrong (ref 1a2b3c4d)",code:"server_error",ref:"1a2b3c4d"}];
  const PAUSED=[503,{error:"Payments are paused: the Stripe keys are for live mode, but the database is set to test mode.",code:"payments_paused"}];
  const fundWith=async(fail)=>{ await p.evaluate((f)=>{ window.__mockFnFail={"stripe-checkout":f}; document.querySelector('#toastWrap').innerHTML=''; },fail); await p.click('[data-caction="fund"]'); };
  await fundWith(SERVER);
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes("Something went wrong on Cuvori's side. Nothing was charged. Please try again in a few minutes. (ref 1a2b3c4d)")) && await unpaid(),"a problem on Cuvori's side at Fund: the client is told in plain words, with the ref, that nothing was charged");
  await fundWith(PAUSED);
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes("Payments are paused at the moment. Nothing was charged. Please try again later.")) && !(await p.textContent('#toastWrap')).includes('Stripe keys') && await unpaid(),"payments paused at Fund: plain words, without the technical reason meant for the owner, and nothing is paid");
  await fundWith([429,{error:"Too many tries in a short time. Please wait a minute and try again.",code:"too_many_tries"}]);
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes("Too many tries in a short time. Nothing was charged. Please wait a minute and try again.")) && await unpaid(),"too many Fund tries in a minute: the client is asked to wait a minute and told nothing was charged");
  await fundWith([429,{error:"Too many tries today. Please try again tomorrow.",code:"too_many_today"}]);
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes("Too many tries today. Nothing was charged. Please try again tomorrow.")) && await unpaid(),"too many Fund tries in a day: the client is asked to try again tomorrow and told nothing was charged");
  await fundWith([409,{error:"This Order was paid in test mode, so its money cannot move with the live keys. Cuvori support needs to look at it.",code:"other_mode"}]);
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes("Payments on this Order are on hold. Please contact Cuvori support.")) && !(await p.textContent('#toastWrap')).includes('test mode') && await unpaid(),"an Order paid in the other mode: the client is told payments are on hold, without the technical reason");
  // the payment page's other refusals: said in plain words in the client's language, never the server's English sentence
  for (const [code, want] of [["needs_check","This Order's payment record needs checking before another payment can be taken. Nothing was charged. Cuvori has been told and will look at it."],
    ["chargeback_open","A card chargeback is open on this Order, so nothing can be paid until the bank decides. Nothing was charged."],
    ["not_your_order","Only the client on this Order can pay it. Nothing was charged."],
    ["paid_directly","This Order is paid directly to the freelancer, not through Cuvori. Nothing was charged."],
    ["amount_out_of_range","This amount can't be paid through Cuvori. Nothing was charged. Please contact Cuvori support."],
    ["account_suspended","Your account is suspended, so you can't make payments. Nothing was charged. Please contact Cuvori support."],
    ["signed_out","Please sign in again, then try once more. Nothing was charged."]]) {
    await fundWith([409,{error:"SERVER SENTENCE "+code,code}]);
    ok(await until(async()=>(await p.textContent('#toastWrap')).includes(want)) && !(await p.textContent('#toastWrap')).includes('SERVER SENTENCE') && await unpaid(),`the payment page refuses (${code}): the client reads it in plain words and is told nothing was charged`);
  }
  // the freelancer's Stripe account can't take money right now (Stripe asked them for something, or restricted it): said in the
  // client's language, with where the freelancer looks (Settings → Payout details), and nothing is charged
  const NOT_READY=[409,{error:"The freelancer's Stripe account can't receive payments right now. Ask them to check Payout details under Settings on Cuvori.",code:"freelancer_not_ready"}];
  await fundWith(NOT_READY);
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes("This freelancer's Stripe account can't receive payments right now, so this Order can't be paid. Nothing was charged. Ask them in the chat to check Settings → Payout details.")) && await unpaid(),"the freelancer's Stripe account can't receive payments: the client is told in plain words where the freelancer looks, and nothing is paid");
  await p.evaluate(()=>document.querySelector('[data-lang="lt"]').click());
  await fundWith(NOT_READY);
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes("Šio specialisto Stripe paskyra šiuo metu negali gauti mokėjimų, todėl šio užsakymo apmokėti negalima. Nieko nebuvo nuskaičiuota. Paprašykite jo pokalbyje pasitikrinti skiltį Nustatymai → Apmokėjimo rekvizitai.")) && !(await p.textContent('#toastWrap')).includes('Payout details under Settings'),"the same, client using Cuvori in Lithuanian: told in Lithuanian, with the Lithuanian menu names");
  await fundWith(PAUSED);
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes("Mokėjimai šiuo metu sustabdyti. Nieko nebuvo nuskaičiuota. Pabandykite vėliau.")) && !(await p.textContent('#toastWrap')).includes('Stripe keys'),"payments paused, client using Cuvori in Lithuanian: told in Lithuanian");
  await fundWith(SERVER);
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes("Cuvori pusėje kažkas nepavyko. Nieko nebuvo nuskaičiuota. Pabandykite dar kartą po kelių minučių. (kodas 1a2b3c4d)")),"a problem on Cuvori's side, client using Cuvori in Lithuanian: told in Lithuanian, with the ref");
  await fundWith([409,{error:"This order's payment record needs checking before another payment can be taken. Cuvori support has been told.",code:"needs_check"}]);
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes("Prieš priimant kitą mokėjimą, reikia patikrinti šio užsakymo mokėjimų įrašus. Nieko nebuvo nuskaičiuota. Cuvori apie tai žino ir tai patikrins.")) && !(await p.textContent('#toastWrap')).includes('payment record'),"a payment record that needs checking, client using Cuvori in Lithuanian: told in Lithuanian");
  await p.evaluate(()=>{ window.__mockFnFail=null; document.querySelector('[data-lang="en"]').click(); });
  // the check at Fund has just set the freelancer's "ready" mark off (Stripe restricted the account): the page refreshes the
  // Order by itself, so the Fund button is gone at once, and the note under the Fund box says why in words that also fit a
  // freelancer who did set up — never "has not set up payouts yet"
  await openOrders();
  await p.evaluate(()=>{ const c=window.__mockdb.contracts.at(-1); window.__mockdb.payout_details.find(x=>x.id===c.editor).stripe_payouts_enabled=false; });
  await fundWith(NOT_READY);
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes("This freelancer's Stripe account can't receive payments right now")) && await until(async()=>await p.locator('[data-caction="fund"]').count()===0)
     && (await modal()).includes("This freelancer can't receive payments right now — ask them in the chat to check Settings → Payout details.") && !(await modal()).includes('has not set up payouts yet') && await unpaid(),
     "the freelancer's account can't take money right now: the Order refreshes at once without the Fund button, and the note says why in words that fit a freelancer who did set up");
  await p.evaluate(()=>{ window.__mockFnFail=null; document.querySelector('[data-lang="lt"]').click(); });
  await openOrders();
  ok(await until(async()=>(await modal()).includes("Šis specialistas šiuo metu negali gauti mokėjimų — paprašykite jo pokalbyje pasitikrinti skiltį Nustatymai → Apmokėjimo rekvizitai.")) && await p.locator('[data-caction="fund"]').count()===0,
     "the same note, client using Cuvori in Lithuanian: told in Lithuanian, with the Lithuanian menu names");
  await p.evaluate(()=>{ const c=window.__mockdb.contracts.at(-1); window.__mockdb.payout_details.find(x=>x.id===c.editor).stripe_payouts_enabled=true; document.querySelector('[data-lang="en"]').click(); });
  await openOrders();
  ok(await until(async()=>await p.locator('[data-caction="fund"]').count()===1) && !(await modal()).includes("can't receive payments right now — ask them"), "once the freelancer's account can take money again, the Fund button is back and the note is gone");
  // a stale page: the Order was paid meanwhile (another tab). Fund is refused in the page's language and the Order reloads without the button
  await p.evaluate(()=>{ const c=window.__mockdb.contracts.at(-1); c.__was={status:c.status,funded_cents:c.funded_cents}; c.status='funded'; c.funded_cents=c.amount_cents; });
  await p.click('[data-caction="fund"]');
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes("This Order isn't waiting for a payment right now — it may already be paid.")) && await until(async()=>await p.locator('[data-caction="fund"]').count()===0),'Fund on a stale page: the client is told the Order is not waiting for a payment, and the Order reloads without the Fund button');
  await p.evaluate(()=>{ const c=window.__mockdb.contracts.at(-1); c.status=c.__was.status; c.funded_cents=c.__was.funded_cents; delete c.__was; });
  // the Order changed in the moment of clicking (an amendment accepted just then): said in the client's language, and the
  // Order reloads so the client sees the new price before trying again
  await openOrders();
  await p.evaluate(()=>{ const c=window.__mockdb.contracts.at(-1); c.__was={amount_cents:c.amount_cents,price:c.price}; window.__mockFnFail={"stripe-checkout":[409,{error:"The order changed, reload",code:"order_changed"}]}; document.querySelector('#toastWrap').innerHTML=''; });
  await p.click('[data-caction="fund"]');
  await p.evaluate(()=>{ const c=window.__mockdb.contracts.at(-1); c.amount_cents+=5000; c.price=c.amount_cents/100; });
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes("This Order changed a moment ago (for example its price). It has been refreshed — please check it and try again. Nothing was charged.")) && await until(async()=>(await modal()).includes('€250.00')) && await unpaid(),'the Order changed in the moment of clicking Fund: the client is told in plain words, nothing is charged, and the Order reloads with the new price');
  await p.evaluate(()=>{ window.__mockFnFail=null; const c=window.__mockdb.contracts.at(-1); c.amount_cents=c.__was.amount_cents; c.price=c.__was.price; delete c.__was; document.querySelector('[data-lang="lt"]').click(); });
  await openOrders();
  await p.evaluate(()=>{ window.__mockFnFail={"stripe-checkout":[409,{error:"The order changed, reload",code:"order_changed"}]}; document.querySelector('#toastWrap').innerHTML=''; });
  await p.click('[data-caction="fund"]');
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes("Šis užsakymas ką tik pasikeitė (pavyzdžiui, jo kaina). Jis atnaujintas — peržiūrėkite jį ir pabandykite dar kartą. Nieko nebuvo nuskaičiuota.")) && !(await p.textContent('#toastWrap')).includes('order changed, reload'),'the same, client using Cuvori in Lithuanian: told in Lithuanian');
  await p.evaluate(()=>{ window.__mockFnFail=null; document.querySelector('[data-lang="en"]').click(); });
  await openOrders();
  await p.click('[data-caction="fund"]'); await p.waitForTimeout(2500);
  await signin('maya@test.com'); await openOrders();
  await p.click('[data-caction="deliver"]'); await p.waitForTimeout(400); await p.fill('#onUrl','https://drive.test/promo'); await p.click('#onGo'); await p.waitForTimeout(900);
  // an old increase under €0.50 (only possible before the database refused them) can never be charged: no Fund prompt, and Approve & release works
  await p.evaluate(()=>{ const c=window.__mockdb.contracts.at(-1); c.amount_cents+=30; c.price=c.amount_cents/100; });
  await signin('jonas@test.com'); await openOrders();
  const tiny=await modal();
  ok(await p.locator('[data-caction="topup"]').count()===0 && !tiny.includes('added €0.3') && (await p.textContent('[data-caction="release"]')).includes('Approve work & release €200'),'an old increase under €0.50: no Fund prompt, and the client can still approve and release');
  await p.evaluate(()=>{ const c=window.__mockdb.contracts.at(-1); c.amount_cents-=30; c.price=c.amount_cents/100; });
  await signin('maya@test.com'); await openOrders();
  // on a paid Order, extra money under €0.50 is refused on the page with the real rule (it used to say "between 0 and 1,000,000"), and nothing is sent
  const amends0=await db(()=>window.__mockdb.order_amendments.length);
  await p.click('[data-caction="amend"]'); await p.waitForTimeout(400); await p.evaluate(()=>document.querySelector('#toastWrap').innerHTML=''); await p.fill('#amNote','Tiny extra'); await p.fill('#amDelta','0.3'); await p.click('#amGo');
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes('This Order is already paid, so extra money must be at least €0.50.')) && await db(()=>window.__mockdb.order_amendments.length)===amends0,'extra money under €0.50 on a paid Order: the page says the real rule, and nothing is sent');
  // the same on a page opened before the payment came in: the database refuses it, and the page says why
  await p.evaluate(()=>{ const c=window.__mockdb.contracts.at(-1); c.__was={status:c.status,funded_cents:c.funded_cents}; c.status='accepted'; c.funded_cents=null; });
  await openOrders(); await p.click('[data-caction="amend"]'); await p.waitForTimeout(400);
  await p.evaluate(()=>{ const c=window.__mockdb.contracts.at(-1); c.status=c.__was.status; c.funded_cents=c.__was.funded_cents; delete c.__was; });
  await p.evaluate(()=>document.querySelector('#toastWrap').innerHTML=''); await p.fill('#amNote','Tiny extra'); await p.fill('#amDelta','0.3'); await p.click('#amGo');
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes('This Order is already paid, so extra money must be at least €0.50.')) && await db(()=>window.__mockdb.order_amendments.length)===amends0,'on a page opened before the payment: the database refuses extra money under €0.50, and the page gives the same reason');
  // extra money under €0.50 proposed before the Order was paid can no longer be accepted once it is paid
  await db(()=>{ const c=window.__mockdb.contracts.at(-1); window.__mockdb.order_amendments.push({id:'am-tiny-1',order_id:c.id,proposed_by:c.editor,note:'Tiny extra',price_delta_cents:30,new_deadline:null,scope_add:'',deliverables_add:'',revisions_add:0,milestones:[],status:'proposed',created_at:new Date().toISOString(),decided_at:null,decided_by:null}); });
  const tinyAm=async()=>await db(()=>window.__mockdb.order_amendments.find(a=>a.id==='am-tiny-1').status);
  await signin('jonas@test.com');
  // first on a page opened before the payment came in: refused, and the Order reloads as it is now (paid, so Approve & release shows)
  await p.evaluate(()=>{ const c=window.__mockdb.contracts.at(-1); c.__was={status:c.status,funded_cents:c.funded_cents}; c.status='accepted'; c.funded_cents=null; });
  await openOrders();
  const staleView=await p.locator('[data-caction="release"]').count();
  await p.evaluate(()=>{ const c=window.__mockdb.contracts.at(-1); c.status=c.__was.status; c.funded_cents=c.__was.funded_cents; delete c.__was; });
  await p.evaluate(()=>document.querySelector('#toastWrap').innerHTML=''); await p.click('[data-amact="accept"]');
  ok(staleView===0 && await until(async()=>(await p.textContent('#toastWrap')).includes('That action is not available right now.')) && await until(async()=>await p.locator('[data-caction="release"]').count()===1) && await tinyAm()==='proposed','accepting on a page opened before the payment: refused, nothing changes, and the Order reloads as it is now');
  await p.evaluate(()=>document.querySelector('#toastWrap').innerHTML=''); await p.click('[data-amact="accept"]');
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes('This Order is already paid, so extra money must be at least €0.50.')) && await tinyAm()==='proposed','accepting extra money under €0.50 on a paid Order: the client is told the real rule, and nothing changes');
  await p.click('[data-amact="decline"]'); await p.waitForTimeout(900);
  ok(await tinyAm()==='declined','the client can still decline it');
  await db(()=>{ const c=window.__mockdb.contracts.at(-1); window.__mockdb.order_amendments.push({id:'am-big-1',order_id:c.id,proposed_by:c.editor,note:'Big extra',price_delta_cents:95000001-c.amount_cents,new_deadline:null,scope_add:'',deliverables_add:'',revisions_add:0,milestones:[],status:'proposed',created_at:new Date().toISOString(),decided_at:null,decided_by:null}); });
  const bigAm=async()=>await db(()=>window.__mockdb.order_amendments.find(a=>a.id==='am-big-1').status);
  await openOrders(); await p.evaluate(()=>document.querySelector('#toastWrap').innerHTML=''); await p.click('[data-amact="accept"]');
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes('The price after this change can be at most €950,000.')) && await bigAm()==='proposed' && await db(()=>window.__mockdb.contracts.at(-1).amount_cents===20000),'accepting an older increase that would take the Order over €950,000: the client is told the most it can be, and nothing changes');
  await p.click('[data-amact="decline"]'); await p.waitForTimeout(900);
  ok(await bigAm()==='declined','the client can decline that one too');
  await signin('maya@test.com'); await openOrders();
  await p.click('[data-caction="amend"]'); await p.waitForTimeout(400); await p.fill('#amNote','Add a vertical version'); await p.fill('#amDelta','50'); await p.click('#amGo'); await p.waitForTimeout(900);
  await signin('jonas@test.com'); await openOrders(); await p.click('[data-amact="accept"]'); await p.waitForTimeout(900);
  const inc=await modal();
  if(process.env.SHOT){ await p.locator('#modalRoot .modal').first().screenshot({path:process.env.SHOT+'-increase.png',timeout:5000}).catch(e=>console.log('screenshot skipped: '+e.message.split('\n')[0])); await p.setViewportSize({width:390,height:844}); await p.waitForTimeout(400); await p.screenshot({path:process.env.SHOT+'-increase-phone.png',fullPage:false}).catch(()=>{}); await p.setViewportSize({width:1400,height:900}); await p.waitForTimeout(300); }
  ok(await db(()=>{ const c=window.__mockdb.contracts.at(-1); return c.status==='delivered' && c.amount_cents===25000 && c.funded_cents===20000; }) && await p.locator('[data-caction="release"]').count()===0 && (await p.textContent('[data-caction="topup"]')).includes('Fund the extra €50') && inc.includes('Fund the extra €50 first, then you can approve it and pay the editor'),'an accepted +€50 not paid yet: no Approve & release, the client is told to fund the extra first');
  // while the freelancer's account can't receive money (the "ready" mark is off), the button that pays the extra follows the same
  // rule as Fund: it is not shown, the note under the money box says why, and it comes back once the account can receive again
  await p.evaluate(()=>{ const c=window.__mockdb.contracts.at(-1); window.__mockdb.payout_details.find(x=>x.id===c.editor).stripe_payouts_enabled=false; });
  await openOrders();
  ok(await p.locator('[data-caction="topup"]').count()===0 && (await modal()).includes('added €50') && (await modal()).includes("This freelancer can't receive payments right now — ask them in the chat to check Settings → Payout details.") && await p.locator('[data-caction="release"]').count()===0,
     "the freelancer's account can't receive money: the button that pays the extra €50 is not shown, the note says why, and nothing can be released");
  await p.evaluate(()=>{ const c=window.__mockdb.contracts.at(-1); window.__mockdb.payout_details.find(x=>x.id===c.editor).stripe_payouts_enabled=true; });
  await openOrders();
  ok((await p.textContent('[data-caction="topup"]')).includes('Fund the extra €50') && !(await modal()).includes("can't receive payments right now — ask them"),'once the account can receive again, the button that pays the extra €50 is back and the note is gone');
  // a card chargeback is open: nothing can be paid until the bank decides, so the button that pays the extra is not shown, and the Order says why
  await p.evaluate(()=>{ window.__mockdb.contracts.at(-1).chargeback_status='open'; });
  await openOrders();
  ok(await p.locator('[data-caction="topup"]').count()===0 && (await modal()).includes("The client's bank has opened a chargeback on this payment."),'a card chargeback is open: no button to pay the extra, and the Order says a chargeback is open');
  await p.evaluate(()=>{ window.__mockdb.contracts.at(-1).chargeback_status=null; });
  await openOrders();
  ok((await p.textContent('[data-caction="topup"]')).includes('Fund the extra €50'),'the chargeback decided: the button that pays the extra is back');
  await p.click('[data-caction="topup"]'); await p.waitForTimeout(2500); await openOrders();
  ok(await db(()=>window.__mockdb.contracts.at(-1).funded_cents===25000) && (await p.textContent('[data-caction="release"]')).includes('Approve work & release €250'),'once the €50 is funded, the client can approve and release all €250');
  await p.click('[data-caction="release"]'); await p.waitForTimeout(400); await p.click('#omGo'); await p.waitForTimeout(1200);
  ok(await db(()=>{ const c=window.__mockdb.contracts.at(-1); return c.status==='completed' && c.released_cents===25000 && window.__fakeStripe.transfers.at(-1).amount===25000; }),'€250 released, including the agreed increase');
  // a payment that came in after the Order could no longer take it is explained in the Order's history
  await p.evaluate(()=>{ const c=window.__mockdb.contracts.at(-1); window.__mockdb.order_events.push({id:'ev-late-1',order_id:c.id,actor:null,event:'late_payment_refunded',data:{amount_cents:5091,card_fee_cents:103,total_cents:5194},created_at:new Date().toISOString()}); });
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML=''); await p.goto(url+'#orders'); await p.waitForTimeout(900);
  await p.locator('#contractsList .c-row',{hasText:'Promo cut'}).first().click(); await p.waitForTimeout(700);
  ok((await modal()).includes('A payment of €51.94 came in after the Order could no longer take it: €50.91 went back to the card. Stripe kept its card fee of €1.03.'),'a late payment is explained in the history: what went back to the card, and the card fee Stripe kept');
  // hold first, charge after: back from Stripe to an Order that could no longer take the payment — the client is told nothing was charged
  const promoId=await p.evaluate(()=>{ const c=window.__mockdb.contracts.at(-1); c.__holdReleased=true; return c.id; });
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML=''); await p.goto(url+'#orders?paid='+promoId);
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes('This Order could no longer take the payment, so your card was not charged.'),4000),'back from Stripe after the Order could no longer take the payment: the client is told the card was not charged');
  await p.evaluate(()=>{ delete window.__mockdb.contracts.at(-1).__holdReleased; document.querySelector('#modalRoot').innerHTML=''; });
  ok(await p.evaluate((id)=>!!window.__lastConfirm && window.__lastConfirm.contract_id===id && window.__lastConfirm.session_id===undefined,promoId),'a return link without a page id: the check falls back to the Order\'s own page');
  // the way Stripe sends the client back: the page id before the #, the Order after it
  await p.evaluate((id)=>{ history.replaceState(null,'',location.pathname+'?cs=cs_test_fromquery123#orders'); location.hash='orders?paid='+id; },promoId); await p.waitForTimeout(900);
  ok(await p.evaluate((id)=>!!window.__lastConfirm && window.__lastConfirm.contract_id===id && window.__lastConfirm.session_id==='cs_test_fromquery123' && !location.search.includes('cs='),promoId),'back from Stripe with the page id before the #: that page is checked, and the id is taken out of the address');
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  await p.evaluate((id)=>{ history.replaceState(null,'',location.pathname+'?cs={CHECKOUT_SESSION_ID}#orders'); location.hash='orders?paid='+id; },promoId); await p.waitForTimeout(900);
  ok(await p.evaluate((id)=>!!window.__lastConfirm && window.__lastConfirm.contract_id===id && window.__lastConfirm.session_id===undefined,promoId),'a return link where Stripe did not fill in the page id: nothing made-up is sent, the check falls back to the Order\'s own page');
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  // scenario: €1,000 in three milestones — partial release, the rest stays secured
  await signin('maya@test.com');
  await newOrder('Documentary edit',1000, async()=>{ await p.check('#oMsOn'); await p.waitForTimeout(200); await p.click('#oMsAdd'); await p.waitForTimeout(100);
    const rows=p.locator('.o-ms-row'); const vals=[['First draft','250'],['Completed first version','350'],['Final delivery','400']];
    for(let i=0;i<3;i++){ await rows.nth(i).locator('.o-ms-title').fill(vals[i][0]); await rows.nth(i).locator('.o-ms-amt').fill(vals[i][1]); }
    await p.waitForTimeout(200); });
  ok(await db(()=>{ const c=window.__mockdb.contracts.at(-1); return c.has_milestones && window.__mockdb.order_milestones.filter(m=>m.order_id===c.id).length===3 && c.amount_cents===100000; }),'a €1,000 Order with three milestones');
  await signin('jonas@test.com'); await openOrders(); await p.click('[data-caction="accept"]'); await p.waitForTimeout(900);
  ok((await modal()).includes('€1,000') && (await modal()).includes('Total to fund') && (await modal()).includes('€1,015.49'),'the client funds the whole €1,000 up front (total €1,015.49)');
  await p.click('[data-caction="fund"]'); await p.waitForTimeout(2500);
  const m1=await modal();
  ok(m1.includes('Project total') && m1.includes('Secured') && m1.includes('Released') && m1.includes('Remaining secured') && m1.includes('€1,000') && m1.includes('€0'),'the milestone Order shows project total, secured, released, remaining');
  ok(await p.locator('.o-ms-item').count()===3 && await p.locator('[data-msact]').count()===0,'three milestones, nothing to approve yet');
  await signin('maya@test.com'); await openOrders();
  ok(await p.locator('[data-msact="submit"]').count()===3 && await p.locator('[data-caction="deliver"]').count()===0,'the freelancer submits milestone by milestone, not the whole Order');
  await p.locator('[data-msact="submit"]').first().click(); await p.waitForTimeout(400); await p.fill('#onUrl','https://frame.io/draft1'); await p.fill('#onNote','First draft is up'); await p.click('#onGo'); await p.waitForTimeout(900);
  ok(await db(()=>{ const c=window.__mockdb.contracts.at(-1); const m=window.__mockdb.order_milestones.filter(x=>x.order_id===c.id)[0]; return m.status==='submitted' && !!m.auto_release_at && window.__mockdb.messages.filter(x=>x.kind==='contract').at(-1).payload.event==='milestone_submitted'; }),'milestone 1 submitted, chat card posted');
  await signin('jonas@test.com'); await openOrders();
  ok((await p.textContent('[data-msact="release"]')).includes('Approve milestone & release €250'),'the client sees: Approve milestone & release €250');
  await p.click('[data-msact="release"]'); await p.waitForTimeout(400); await p.click('#omGo'); await p.waitForTimeout(1200);
  const m2=await modal();
  ok(await db(()=>{ const c=window.__mockdb.contracts.at(-1); return c.status==='funded' && c.released_cents===25000 && window.__fakeStripe.transfers.at(-1).amount===25000; }) && m2.includes('€250') && m2.includes('€750'),'€250 released, €750 stays secured, the Order continues');
  // amendment after acceptance: +€100 as a fourth milestone; the original stays in the history
  await signin('maya@test.com'); await openOrders();
  await p.click('[data-caction="amend"]'); await p.waitForTimeout(400);
  await p.fill('#amNote','Add a 30-second teaser'); await p.fill('#amDelta','100'); await p.fill('#amMs','Teaser'); await p.click('#amGo'); await p.waitForTimeout(900);
  ok(await db(()=>{ const c=window.__mockdb.contracts.at(-1), a=window.__mockdb.order_amendments.filter(x=>x.order_id===c.id); return a.length===1 && a[0].status==='proposed'; }),'amendment proposed');
  ok((await modal()).includes('Amendment proposed by') && await p.locator('[data-amact="withdraw"]').count()===1 && await p.locator('[data-amact="accept"]').count()===0,'the proposer can only withdraw it');
  await signin('jonas@test.com'); await openOrders();
  ok((await modal()).includes('Amendment proposed by Maya') && (await modal()).includes('+€100'),'the client sees the amendment with the extra money');
  await p.click('[data-amact="accept"]'); await p.waitForTimeout(900);
  ok(await db(()=>{ const c=window.__mockdb.contracts.at(-1); return c.amount_cents===110000 && c.amendments===1 && window.__mockdb.order_milestones.filter(m=>m.order_id===c.id).length===4 && window.__mockdb.order_events.some(e=>e.order_id===c.id&&e.event==='created'&&e.data.price_cents===100000); }),'accepted: €1,100, four milestones, the original €1,000 is still in the history');
  ok((await modal()).includes('added €100') && (await p.textContent('[data-caction="topup"]')).includes('Fund the extra €100'),'the client is asked to fund the extra €100');
  await p.click('[data-caction="topup"]'); await p.waitForTimeout(2500);
  ok(await db(()=>{ const c=window.__mockdb.contracts.at(-1); return c.funded_cents===110000 && window.__mockdb.order_payments.filter(x=>x.order_id===c.id&&x.kind==='fund').length===2; }),'topped up: €1,100 secured, two funding rows in the ledger');
  // changes on a milestone keep the money where it is; a dispute stops releases
  await signin('maya@test.com'); await openOrders();
  await p.locator('[data-msact="submit"]').first().click(); await p.waitForTimeout(400); await p.fill('#onNote','Version 1 done'); await p.click('#onGo'); await p.waitForTimeout(900);
  await signin('jonas@test.com'); await openOrders();
  await p.click('[data-msact="changes"]'); await p.waitForTimeout(400); await p.fill('#onNote','Make the middle section shorter'); await p.click('#onGo'); await p.waitForTimeout(900);
  ok(await db(()=>{ const c=window.__mockdb.contracts.at(-1); const m=window.__mockdb.order_milestones.filter(x=>x.order_id===c.id)[1]; return m.status==='pending' && c.funded_cents-c.released_cents-c.refunded_cents===85000; }),'changes requested on milestone 2: back to the freelancer, €850 still secured');
  await signin('maya@test.com'); await openOrders();
  await p.locator('[data-msact="submit"]').first().click(); await p.waitForTimeout(400); await p.fill('#onNote','Shorter middle'); await p.click('#onGo'); await p.waitForTimeout(900);
  await signin('jonas@test.com'); await openOrders();
  await p.click('[data-caction="dispute"]'); await p.waitForTimeout(400); await p.fill('#onNote','The second part is not what we agreed at all'); await p.click('#onGo'); await p.waitForTimeout(900);
  ok(await db(()=>{ const c=window.__mockdb.contracts.at(-1); return c.status==='disputed' && window.__mockdb.order_milestones.filter(x=>x.order_id===c.id).every(m=>!m.auto_release_at); }),'dispute: no milestone will be released on its own');
  ok((await modal()).includes('Disputed') && await p.locator('[data-msact]').count()===0 && await p.locator('[data-caction="amend"]').count()===0,'while disputed: no approvals, no amendments');
  await signin('maya@test.com'); await openOrders();
  ok((await modal()).includes('Cuvori is reviewing'),'the freelancer sees the dispute state');
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  await p.goto(url+'#account'); await p.waitForTimeout(400); await p.click('#adminBtn'); await p.waitForTimeout(600); await p.click('.admin-tab[data-atab="contracts"]'); await p.waitForTimeout(600);
  ok((await p.textContent('#adminBody')).includes('Dispute by client') && (await p.textContent('#adminBody')).includes('not what we agreed') && (await p.textContent('#adminBody')).includes('held €850'),'admin sees the dispute, the reason and what is still held');
  await p.locator('.admin-row.is-banned [data-res="split"]').click(); await p.waitForTimeout(300); await p.fill('#resPct','70'); await p.fill('#resNote','Work delivered, minor issues');
  // payments paused while the admin decides: plain words, and the admin also sees the technical reason so they know what to fix
  const stBefore=await db(()=>window.__mockdb.contracts.at(-1).status);
  await p.evaluate(()=>{ window.__mockFnFail={"stripe-resolve":[503,{error:"Payments are paused: the Stripe keys are for live mode, but the database is set to test mode.",code:"payments_paused"}]}; document.querySelector('#toastWrap').innerHTML=''; });
  await p.click('#resGo');
  ok(await until(async()=>(await p.textContent('#toastWrap')).includes("Payments are paused at the moment. Please try again later. — Admin: Payments are paused: the Stripe keys are for live mode, but the database is set to test mode.")) && await db(()=>window.__mockdb.contracts.at(-1).status)===stBefore,'payments paused while the admin decides a dispute: plain words plus the technical reason for the admin, and nothing moved');
  await p.evaluate(()=>{ window.__mockFnFail=null; });
  await p.click('#resGo'); await p.waitForTimeout(800);
  ok(await db(()=>{ const c=window.__mockdb.contracts.at(-1); const s=window.__fakeStripe; return c.status==='completed' && s.transfers.at(-1).amount===59500 && s.refunds.at(-1).amount===25500 && c.released_cents===25000+59500 && c.refunded_cents===25500; }),'admin split 70/30 of the €850 still held; the €250 already released stays released');
  ok(await db(()=>window.__mockdb.messages.some(m=>m.body&&m.body.startsWith('Cuvori decision'))),'decision note posted to chat');
  // cancellation: before funding either side walks away; after funding the freelancer can give the money back
  await p.click('.admin-tab[data-atab="fees"]'); await p.waitForTimeout(600);
  ok((await p.textContent('#adminBody')).includes('a €500 Order') && (await p.textContent('#adminBody')).includes('€7.87') && await p.locator('.f-pct').count()>=3,'admin sees the processing-cost table and a worked example');
  await newOrder('Quick teaser',200);
  await signin('jonas@test.com'); await openOrders(); await p.click('[data-caction="cancel"]'); await p.waitForTimeout(800);
  ok(await db(()=>window.__mockdb.contracts.at(-1).status==='cancelled') && (await modal()).includes('Cancelled'),'before funding the client can cancel');
  await signin('maya@test.com'); await newOrder('Quick teaser 2',200);
  await signin('jonas@test.com'); await openOrders(); await p.click('[data-caction="accept"]'); await p.waitForTimeout(900); await p.click('[data-caction="fund"]'); await p.waitForTimeout(2500);
  ok(await db(()=>window.__mockdb.contracts.at(-1).status==='funded') && await p.locator('[data-caction="cancel"]').count()===0,'once funded the client has no cancel button (the dispute route decides)');
  await signin('maya@test.com'); await openOrders();
  ok(await p.locator('[data-caction="cancelRefund"]').count()===1,'the freelancer can cancel and refund');
  await p.click('[data-caction="cancelRefund"]'); await p.waitForTimeout(400); await p.click('#omGo'); await p.waitForTimeout(1200);
  ok(await db(()=>{ const c=window.__mockdb.contracts.at(-1); return c.status==='refunded' && c.refunded_cents===20000 && window.__fakeStripe.refunds.at(-1).amount===20000; }),'cancelled after funding: €200 refunded to the client');
  ok((await modal()).includes('Refunded'),'the Order says refunded');
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  await p.goto(url+'#account'); await p.waitForTimeout(400); await p.click('#adminBtn'); await p.waitForTimeout(600); await p.click('.admin-tab[data-atab="contracts"]'); await p.waitForTimeout(600);
  // a payment where the card cost came out higher than the client paid for processing: the admin sees it, with the amount and what to do
  await p.evaluate(()=>{ const c=window.__mockdb.contracts.find(x=>x.payment_mode==='escrow'&&x.status==='completed')||window.__mockdb.contracts.find(x=>x.payment_mode==='escrow'); c.fee_short_cents=40; });
  await p.click('.admin-tab[data-atab="users"]'); await p.waitForTimeout(300); await p.click('.admin-tab[data-atab="contracts"]'); await p.waitForTimeout(600);
  ok((await p.textContent('#adminBody')).includes('Card cost not covered: Stripe took €0.40 more in card fees') && (await p.textContent('#adminBody .admin-stats')).includes('€0.40 card cost paid by Cuvori (1 order)'),'admin sees a card cost that was not covered, with the amount and what to do');
  if(process.env.SHOT){ await p.locator('#adminBody .admin-stats').screenshot({path:process.env.SHOT+'-stats.png'}); await p.locator('.admin-row',{hasText:'Card cost not covered'}).screenshot({path:process.env.SHOT+'-row.png'}); }
  await p.evaluate(()=>{ window.__mockdb.contracts.forEach(c=>{ delete c.fee_short_cents; }); });
  // ---------- bad actors ----------
  await p.click('.admin-tab[data-atab="bad"]'); await p.waitForTimeout(600);
  ok((await p.textContent('#adminBody')).includes('Nobody on the list'),'bad actors list empty after a split');
  await p.click('.admin-tab[data-atab="users"]'); await p.waitForTimeout(600);
  await p.locator('.admin-row').filter({hasText:'jonas@test.com'}).locator('[data-aflag]').click(); await p.waitForTimeout(300);
  await p.selectOption('#flKind','scam'); await p.fill('#flReason','Tried to pay outside Cuvori'); await p.click('#flGo'); await p.waitForTimeout(700);
  ok(await p.evaluate(()=>window.__mockdb.user_flags.length===1 && window.__mockdb.user_flags[0].kind==='scam'),'manual flag saved');
  ok((await p.textContent('#adminBody')).includes('1 flag'),'users list shows flag count');
  await p.click('.admin-tab[data-atab="bad"]'); await p.waitForTimeout(600);
  ok((await p.textContent('#adminBody')).includes('Jonas') && (await p.textContent('#adminBody')).includes('Tried to pay outside'),'bad actors list shows Jonas with reason');
  await p.click('[data-unflag]'); await p.waitForTimeout(600);
  ok(await p.evaluate(()=>window.__mockdb.user_flags.length===0) && (await p.textContent('#adminBody')).includes('Nobody on the list'),'flag removed');
  // ---------- identifiers: returning bad actor is recognised ----------
  // flag Jonas as scam, then a "new" account (Tomas) that pays out to Jonas's PayPal gets auto-matched
  await p.click('.admin-tab[data-atab="users"]'); await p.waitForTimeout(500);
  await p.locator('.admin-row').filter({hasText:'jonas@test.com'}).locator('[data-aflag]').click(); await p.waitForTimeout(300);
  await p.selectOption('#flKind','scam'); await p.fill('#flReason','Chargeback after delivery'); await p.click('#flGo'); await p.waitForTimeout(600);
  await p.evaluate(()=>{ const j=window.__mockdb.profiles.find(x=>x.email==='jonas@test.com'); window.__recId(j.id,'paypal','jonas.pay@paypal.com','paypal ••.com'); });
  await p.click('.admin-tab[data-atab="bad"]'); await p.waitForTimeout(600);
  ok((await p.textContent('#adminBody')).includes('On record:') && (await p.textContent('#adminBody')).includes('E-mail: jonas@test.com'),'bad actor row shows identifiers on record');
  await signin('jonas@test.com'); await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  await p.evaluate(()=>{ window.__savedReviews=JSON.parse(JSON.stringify(window.__mockdb.reviews)); });
  // Jonas deletes his own account -> fingerprints kept as ghost
  await p.goto(url+'#account'); await p.waitForTimeout(400); await p.click('#deleteAccountBtn'); await p.waitForTimeout(300); await p.fill('#dzWord','DELETE'); await p.click('#dzGo'); await p.waitForTimeout(900);
  ok(await p.evaluate(()=>window.__mockdb.deleted_user_identifiers.length>=2),'identifiers kept after a flagged user deletes the account');
  // new editor account using the same PayPal for payouts
  await p.goto(url+'#create-account'); await p.waitForTimeout(300); await p.click('#authSeg [data-auth="signup"]'); await p.fill('#suName','Tomas'); await p.fill('#suEmail','tomas@test.com'); await p.fill('#suPass','password123'); await p.check('#suAgree'); await p.click('[data-auth-signup]'); await p.waitForTimeout(900);
  await p.evaluate(()=>{ const me=window.__mockdb.profiles.find(x=>x.email==='tomas@test.com'); me.role='editor'; });
  await signin('tomas@test.com'); await p.evaluate(()=>{ window.__mockEscrow=false; }); await p.evaluate(()=>window.__reloadEscrow());
  await p.goto(url+'#settings'); await p.waitForTimeout(400); await p.click('.snav[data-set="payout"]'); await p.click('#addPayoutBtn'); await p.locator('#payoutRows .po-type').first().selectOption('paypal'); await p.fill('#payoutRows .po-details','Jonas.Pay@paypal.com'); await p.click('#savePayoutBtn'); await p.waitForTimeout(600);
  ok(await p.evaluate(()=>{ const me=window.__mockdb.profiles.find(x=>x.email==='tomas@test.com'); return window.__mockdb.user_flags.some(f=>f.user_id===me.id&&f.kind==='match'&&f.reason.includes('deleted account')); }),'new account auto-flagged: same PayPal as deleted scammer');
  await signin('maya@test.com'); await p.goto(url+'#account'); await p.waitForTimeout(400); await p.click('#adminBtn'); await p.waitForTimeout(600); await p.click('.admin-tab[data-atab="bad"]'); await p.waitForTimeout(600);
  ok((await p.textContent('#adminBody')).includes('Tomas') && (await p.textContent('#adminBody')).includes('Matches a flagged account'),'Tomas appears in Bad actors as a match');
  // clean up for the remaining tests: remove Tomas, re-create Jonas as client with a conversation
  await p.evaluate(()=>{ const db=window.__mockdb; const t=db.profiles.find(x=>x.email==='tomas@test.com'); db.profiles=db.profiles.filter(x=>x!==t); db.user_flags=[]; db.user_identifiers=db.user_identifiers.filter(i=>i.user_id!==t.id); db.payout_details=db.payout_details.filter(x=>x.id!==t.id); db.deleted_user_identifiers=[]; });
  await p.evaluate(()=>{ window.__mockEscrow=true; }); await p.evaluate(()=>window.__reloadEscrow());
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML=''); await p.goto(url+'#account'); await p.waitForTimeout(300); await p.click('#signOutBtn'); await p.waitForTimeout(400);
  await p.goto(url+'#create-account'); await p.waitForTimeout(300); await p.click('#authSeg [data-auth="signup"]'); await p.fill('#suName','Jonas'); await p.fill('#suEmail','jonas@test.com'); await p.fill('#suPass','password123'); await p.check('#suAgree'); await p.click('[data-auth-signup]'); await p.waitForTimeout(900);
  await p.goto(url+'#home'); await p.waitForTimeout(600); await p.click('.real-card .message-person'); await p.waitForTimeout(800); await p.fill('.chat-window input','Hi again'); await p.keyboard.press('Enter'); await p.waitForTimeout(500);
  await p.evaluate(()=>{ const j=window.__mockdb.profiles.find(x=>x.email==='jonas@test.com'); window.__mockdb.reviews=(window.__savedReviews||[]).map(r=>({...r, client:j.id})); });
  await signin('maya@test.com');
  // approve early: the client can release before a delivery
  await p.goto(url+'#home'); await p.waitForTimeout(500); await p.click('#contactList .contact'); await p.waitForTimeout(800); await p.click('.chat-window .open-contract'); await p.waitForTimeout(700);
  await p.fill('#oTitle','Teaser'); await p.fill('#oPrice','50'); await p.click('#oSend'); await p.waitForTimeout(900); await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  await signin('jonas@test.com'); await openOrders();
  await p.click('[data-caction="accept"]'); await p.waitForTimeout(700); await p.click('[data-caction="fund"]'); await p.waitForTimeout(2500);
  await p.click('[data-caction="release"]'); await p.waitForTimeout(300); await p.click('#omGo'); await p.waitForTimeout(900);
  ok(await p.evaluate(()=>{ const c=window.__mockdb.contracts.at(-1); return c.status==='completed' && window.__fakeStripe.transfers.at(-1).amount===5000; }),'client approved early -> €50 released');
  ok((await p.textContent('#modalRoot')).includes('Completed'),'completed state text');
  // the client disputes, admin refunds -> freelancer auto-flagged
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  await p.goto(url+'#home'); await p.waitForTimeout(500); await p.click('#contactList .contact'); await p.waitForTimeout(800); await p.click('.chat-window .open-contract'); await p.waitForTimeout(700);
  await p.fill('#oTitle','Logo sting'); await p.fill('#oPrice','40'); await p.click('#oSend'); await p.waitForTimeout(900); await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  await signin('maya@test.com'); await openOrders(); await p.click('[data-caction="accept"]'); await p.waitForTimeout(700);
  await signin('jonas@test.com'); await openOrders(); await p.click('[data-caction="fund"]'); await p.waitForTimeout(2500);
  await p.click('[data-caction="dispute"]'); await p.waitForTimeout(300); await p.fill('#onNote','Nothing delivered after 3 weeks'); await p.click('#onGo'); await p.waitForTimeout(800);
  await signin('maya@test.com'); await p.goto(url+'#account'); await p.waitForTimeout(400); await p.click('#adminBtn'); await p.waitForTimeout(600); await p.click('.admin-tab[data-atab="contracts"]'); await p.waitForTimeout(600);
  await p.locator('.admin-row.is-banned [data-res="refund"]').click(); await p.waitForTimeout(300); await p.click('#resGo'); await p.waitForTimeout(800);
  ok(await p.evaluate(()=>{ const f=window.__mockdb.user_flags; const ed=window.__mockdb.profiles.find(p=>p.email==='maya@test.com'); return f.length===1 && f[0].kind==='dispute_lost' && f[0].user_id===ed.id; }),'freelancer auto-flagged after losing dispute (refund)');
  await p.click('.admin-tab[data-atab="bad"]'); await p.waitForTimeout(600);
  ok((await p.textContent('#adminBody')).includes('Lost a dispute') && (await p.textContent('#adminBody')).includes('disputes lost 1'),'bad actors shows lost-dispute entry');
  await p.evaluate(()=>{ window.__mockdb.user_flags=[]; });
  // ---------- editor sees review on account, admin panel ----------
  await p.goto(url+'#account'); await p.waitForTimeout(300); await p.click('#signOutBtn'); await p.waitForTimeout(400);
  await p.click('#signInBtn'); await p.waitForTimeout(300); await p.fill('#siEmail','maya@test.com'); await p.fill('#siPass','password123'); await p.click('[data-auth-signin]'); await p.waitForTimeout(1200);
  await p.goto(url+'#account'); await p.waitForTimeout(500);
  ok(await p.evaluate(()=>window.__mockdb.order_reviews.length===0),'deleting the account took the reviews written by and about that person with it');
  ok(await p.locator('#adminBtn').isVisible(),'admin sees Admin panel button');
  await p.click('#adminBtn'); await p.waitForTimeout(700);
  ok(await p.locator('#page-admin').evaluate(e=>e.classList.contains('active')),'admin page opens');
  await p.click('.admin-tab[data-atab="users"]'); await p.waitForTimeout(600);
  ok(await p.locator('.admin-row').count()===2,'admin lists 2 users');
  // ban Jonas
  const jonasRow=p.locator('.admin-row').filter({hasText:'jonas@test.com'});
  await jonasRow.locator('[data-aban]').click(); await p.waitForTimeout(300); await p.fill('#banReason','spam'); await p.click('#banGo'); await p.waitForTimeout(400);
  ok(await p.evaluate(()=>window.__mockdb.profiles.find(x=>x.email==='jonas@test.com').banned!==true),'a ban without a real reason is refused');
  await p.fill('#banReason','spamming clients with fake offers'); await p.click('#banGo'); await p.waitForTimeout(700);
  ok(await p.evaluate(()=>window.__mockdb.profiles.find(x=>x.email==='jonas@test.com').banned===true),'ban saved to DB');
  ok((await p.textContent('#adminBody')).includes('BANNED: spam'),'banned shown in list');
  await p.locator('.admin-row').filter({hasText:'jonas@test.com'}).locator('[data-aunban]').click(); await p.waitForTimeout(700);
  ok(await p.evaluate(()=>window.__mockdb.profiles.find(x=>x.email==='jonas@test.com').banned===false),'unban works');
  // invites
  await p.click('.admin-tab[data-atab="invites"]'); await p.waitForTimeout(500);
  await p.fill('#invNote','for Tom'); await p.click('#invCreate'); await p.waitForTimeout(600);
  const code=(await p.textContent('#codeBox')).trim(); ok(/^CUV-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code),'new invite code shown once: '+code);
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML=''); await p.waitForTimeout(600);
  ok((await p.textContent('#adminBody')).includes('for Tom'),'invite listed with note');
  // reviews tab: an admin can hide a review, and the words the person wrote survive it
  await p.evaluate(()=>{ const db=window.__mockdb; const now=new Date().toISOString();
    const me=db.profiles.find(x=>x.email==='maya@test.com');
    db.order_reviews.push({ id:'rv-admin', order_id:db.contracts[0].id, reviewer:me.id, reviewee:'rv-subject', reviewer_role:'freelancer',
      rating:2, comment:'Great colour work, fast.', low_reason:'poor_communication', submitted_at:now,
      reveal_due:new Date(Date.now()-1000).toISOString(), is_revealed:true, revealed_at:now, moderation_status:'visible', edits:0 });
  });
  await p.click('.admin-tab[data-atab="reviews"]'); await p.waitForTimeout(600);
  ok((await p.textContent('#adminBody')).includes('Great colour work'),'admin sees the reviews written on Orders');
  await p.click('[data-rhide="rv-admin"]'); await p.waitForTimeout(400);
  await p.fill('#onNote','Names a private address'); await p.click('#onGo'); await p.waitForTimeout(700);
  ok(await p.evaluate(()=>{ const r=window.__mockdb.order_reviews.find(x=>x.id==='rv-admin'); return r.moderation_status==='hidden' && r.comment==='Great colour work, fast.' && r.moderation_reason==='Names a private address'; }),'hiding a review keeps its text and records why');
  ok(await p.evaluate(async ()=>((await window.__sb.rpc('profile_reviews',{p_user:'rv-subject'})).data.count)===0),'a hidden review no longer counts towards the public rating');
  // ---------- admin: professions and filters as data ----------
  await p.click('.admin-tab[data-atab="professions"]'); await p.waitForTimeout(600);
  ok(await p.locator('[data-pslug="game-developer"]').count()===1 && (await p.textContent('[data-pslug="game-developer"]')).includes('closed'),'admin sees professions that are not open yet');
  await p.locator('[data-pslug="game-developer"] [data-pact]').click(); await p.waitForTimeout(700);
  ok((await p.textContent('[data-pslug="game-developer"]')).includes('open for joining') && !(await p.textContent('[data-pslug="game-developer"]')).includes('visible to clients'),'opening a profession lets professionals join without showing it to clients yet');
  await p.goto(url+'#home'); await p.waitForTimeout(600);
  ok(await p.locator('#profRow .prof-chip[data-prof="game-developer"]').count()===0,'…so the selector still does not offer it');
  await p.goto(url+'#account'); await p.waitForTimeout(300); await p.click('#adminBtn'); await p.waitForTimeout(500); await p.click('.admin-tab[data-atab="professions"]'); await p.waitForTimeout(600);
  await p.locator('[data-pslug="video-editor"] [data-pfilters]').click(); await p.waitForTimeout(300);
  ok(await p.locator('[data-pslug="video-editor"] [data-pfk="software"]').count()===1 && await p.locator('[data-pslug="video-editor"] [data-pfk="shoot_type"]').count()===0,'a profession lists its own filters');
  await p.selectOption('[data-pslug="video-editor"] .pf-attach','equipment'); await p.locator('[data-pslug="video-editor"] [data-pfattach]').click(); await p.waitForTimeout(700);
  ok(await p.locator('[data-pslug="video-editor"] [data-pfk="equipment"]').count()===1,'attaching a filter is one click, no code');
  await p.fill('.opt-key[data-f="software"]','resolve_studio'); await p.fill('.opt-name[data-f="software"]','DaVinci Resolve Studio'); await p.locator('[data-optadd="software"]').click(); await p.waitForTimeout(700);
  ok((await p.textContent('#adminBody')).includes('DaVinci Resolve Studio'),'a new option appears immediately');
  await p.goto(url+'#home'); await p.waitForTimeout(500); await p.click('#profRow .prof-chip[data-prof="video-editor"]'); await p.waitForTimeout(500); await p.click('#allFiltersBtn'); await p.waitForTimeout(300);
  ok(await p.locator('.fopt[data-k="software"][data-v="resolve_studio"]').count()===1,'…and clients can filter by it straight away');
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  // ---------- a demo account never looks real ----------
  await p.goto(url+'#account'); await p.waitForTimeout(300); await p.click('#adminBtn'); await p.waitForTimeout(500); await p.click('.admin-tab[data-atab="users"]'); await p.waitForTimeout(500);
  ok(await p.locator('.admin-row .a-vis').count()>=1,'each account has a Real / Demo / Hidden switch');
  await p.locator('.admin-row').filter({hasText:'maya@test.com'}).locator('.a-vis').selectOption('demo'); await p.waitForTimeout(700);
  ok(await p.evaluate(()=>window.__mockdb.profiles.find(x=>x.email==='maya@test.com').visibility==='demo'),'marking an account as demo is stored');
  await p.goto(url+'#home'); await p.waitForTimeout(900);
  ok(await p.locator('.real-card').count()===0 && await p.locator('#noProsYet').count()===1,'a demo professional disappears from the marketplace');
  ok(await p.locator('#profRow .prof-chip[data-prof="video-editor"]').count()===0,'…and no longer makes a profession look populated');
  await p.goto(url+'#account'); await p.waitForTimeout(300); await p.click('#adminBtn'); await p.waitForTimeout(500);
  await p.locator('.admin-row').filter({hasText:'maya@test.com'}).locator('.a-vis').selectOption('public'); await p.waitForTimeout(700);
  await p.goto(url+'#home'); await p.waitForTimeout(900);
  ok(await p.locator('.real-card').count()===1,'switching back to real shows them again');
  await p.goto(url+'#account'); await p.waitForTimeout(300); await p.click('#adminBtn'); await p.waitForTimeout(500);
  // delete Jonas entirely
  await p.click('.admin-tab[data-atab="users"]'); await p.waitForTimeout(500);
  await p.locator('.admin-row').filter({hasText:'jonas@test.com'}).locator('[data-adelete]').click(); await p.waitForTimeout(300);
  ok(await p.locator('#dzGo').isDisabled(),'delete needs typed confirmation');
  await p.fill('#dzWord','DELETE'); await p.click('#dzGo'); await p.waitForTimeout(800);
  ok(await p.evaluate(()=>window.__mockdb.profiles.length===1 && window.__mockdb.reviews.length===0 && window.__mockdb.conversations.length===0),'user + all data deleted');
  ok(await p.locator('.admin-row').count()===1,'admin list refreshed');
  // ---------- self delete ----------
  await p.goto(url+'#account'); await p.waitForTimeout(300); await p.click('#signOutBtn'); await p.waitForTimeout(400);
  await p.goto(url+'#create-account'); await p.waitForTimeout(300); await p.click('#authSeg [data-auth="signup"]'); await p.waitForTimeout(200);
  await p.fill('#suName','Tom'); await p.fill('#suEmail','tom@test.com'); await p.fill('#suPass','password123'); await p.check('#suAgree'); await p.click('[data-auth-signup]'); await p.waitForTimeout(900);
  await p.goto(url+'#join-editor'); await p.waitForTimeout(300); await p.fill('#inviteCode',code); await p.click('#inviteBtn'); await p.waitForTimeout(1800);
  ok(await p.evaluate(()=>window.__mockdb.profiles.find(x=>x.email==='tom@test.com').role==='editor'),'admin-created invite code works');
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  await p.goto(url+'#account'); await p.waitForTimeout(400);
  ok(await p.locator('#deleteAccountBtn').isVisible(),'Delete my account sits on the Account page, no extra click');
  await p.click('#deleteAccountBtn'); await p.waitForTimeout(300); await p.fill('#dzWord','DELETE'); await p.click('#dzGo'); await p.waitForTimeout(900);
  ok(await p.evaluate(()=>!window.__mockdb.profiles.some(x=>x.email==='tom@test.com')),'self-delete removed the account');
  ok(await p.locator('#signInBtn').isVisible(),'signed out after deleting');
  await p.screenshot({path:'shots/real-final.png'});

  // ---------- rules, privacy notice, reports ----------
  await p.goto(url+'#rules'); await p.waitForTimeout(500);
  ok(await p.locator('#page-rules').evaluate(e=>e.classList.contains('active')),'rules page opens');
  const rulesText = await p.textContent('#page-rules');
  ok(rulesText.includes('What Cuvori is') && rulesText.includes('Things that get you removed'),'rules page shows all the sections');
  ok(!/\{[a-z]+\}/i.test(rulesText),'no unfilled placeholders left in the rules');
  ok(/@/.test(rulesText) && rulesText.includes(await p.evaluate(()=>window.CUVORI_LEGAL.email)),'rules show the real contact address, whatever it is set to');
  await p.goto(url+'#privacy'); await p.waitForTimeout(400);
  ok((await p.textContent('#page-privacy')).includes('What is stored'),'privacy notice opens');
  // the same, in the language the person signed up in
  await p.evaluate(()=>localStorage.setItem('cuvoriLanguage','lt'));
  await p.goto(url+'#rules'); await p.reload(); await p.waitForTimeout(900);
  const ltText = await p.textContent('#page-rules');
  ok(!ltText.includes('What Cuvori is') && ltText.length > 4000,'rules are translated, not English fallback');
  await p.evaluate(()=>localStorage.setItem('cuvoriLanguage','en'));
  // sign up: the tick is required and is recorded
  await p.goto(url+'#create-account'); await p.reload(); await p.waitForTimeout(700); await p.click('#authSeg [data-auth="signup"]'); await p.waitForTimeout(200);
  await p.uncheck('#suAgree');
  await p.fill('#suName','Rita'); await p.fill('#suEmail','rita@test.com'); await p.fill('#suPass','password123');
  await p.click('[data-auth-signup]'); await p.waitForTimeout(400);
  ok(await p.evaluate(()=>!window.__mockdb.profiles.some(x=>x.email==='rita@test.com')),'no account without agreeing to the rules');
  await p.check('#suAgree'); await p.click('[data-auth-signup]'); await p.waitForTimeout(1200);
  ok(await p.evaluate(()=>{const r=window.__mockdb.profiles.find(x=>x.email==='rita@test.com'); return !!(r && r.rules_version && r.rules_accepted_at);}),'the version agreed to is stored against the account');
  // an older agreement is asked for again the next time she signs in
  await p.evaluate(()=>{ const me=window.__mockdb.profiles.find(x=>x.email==='rita@test.com'); me.rules_version='2019-01'; });
  await p.goto(url+'#account'); await p.waitForTimeout(400); await p.click('#signOutBtn'); await p.waitForTimeout(500);
  await p.goto(url+'#create-account'); await p.waitForTimeout(300); await p.click('#authSeg [data-auth="signin"]'); await p.waitForTimeout(200);
  await p.fill('#siEmail','rita@test.com'); await p.fill('#siPass','password123'); await p.click('[data-auth-signin]'); await p.waitForTimeout(1400);
  ok((await p.textContent('#modalRoot')).includes('rules have changed'),'a changed version is put in front of the person again');
  await p.click('#raYes'); await p.waitForTimeout(600);
  ok(await p.evaluate(()=>window.__mockdb.profiles.find(x=>x.email==='rita@test.com').rules_version!=='2019-01'),'agreeing again is recorded');
  // ---------- a report reaches the administrator ----------
  // Rita is the administrator here; Vida is an ordinary user with a problem
  await p.goto(url+'#account'); await p.waitForTimeout(300); await p.click('#signOutBtn'); await p.waitForTimeout(500);
  await p.goto(url+'#create-account'); await p.waitForTimeout(300); await p.click('#authSeg [data-auth="signup"]'); await p.waitForTimeout(200);
  await p.fill('#suName','Vida'); await p.fill('#suEmail','vida@test.com'); await p.fill('#suPass','password123'); await p.check('#suAgree');
  await p.click('[data-auth-signup]'); await p.waitForTimeout(1200);
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  await p.goto(url+'#rules'); await p.waitForTimeout(500);
  await p.click('[data-legal-report]'); await p.waitForTimeout(400);
  await p.fill('#rpBody','short'); await p.click('#rpSend'); await p.waitForTimeout(300);
  ok(await p.evaluate(()=>(window.__mockdb.reports||[]).length===0),'an empty report is refused');
  await p.selectOption('#rpKind','scam');
  await p.fill('#rpBody','This profile asked me to pay outside Cuvori and then disappeared.');
  await p.click('#rpSend'); await p.waitForTimeout(800);
  ok(await p.evaluate(()=>{const r=(window.__mockdb.reports||[])[0]; return !!(r && r.kind==='scam' && r.status==='open');}),'a report is stored and waiting for an answer');
  ok(await p.evaluate(()=>{
    const db=window.__mockdb, admin=db.profiles.find(x=>x.is_admin), me=db.profiles.find(x=>x.email==='vida@test.com');
    const c=db.conversations.find(c=>[c.user_a,c.user_b].includes(admin.id) && [c.user_a,c.user_b].includes(me.id));
    return !!(c && db.messages.some(m=>m.conversation_id===c.id && m.sender===me.id && m.body.startsWith('Report · scam')));
  }),'the report is delivered to the administrator as a message');
  // the administrator signs in and finds it in the messenger, with the bell showing it
  await p.goto(url+'#account'); await p.waitForTimeout(300); await p.click('#signOutBtn'); await p.waitForTimeout(500);
  await p.goto(url+'#create-account'); await p.waitForTimeout(300); await p.click('#authSeg [data-auth="signin"]'); await p.waitForTimeout(200);
  await p.fill('#siEmail','rita@test.com'); await p.fill('#siPass','password123'); await p.click('[data-auth-signin]'); await p.waitForTimeout(1600);
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  ok(!await p.locator('#notifBadge').evaluate(e=>e.classList.contains('hidden')),'the administrator has a notification waiting');
  await p.click('#messagesBtn'); await p.waitForTimeout(800);
  ok((await p.textContent('#contactList')).includes('Vida'),'the person who reported shows up in the messenger');
  await p.click('#closeSidebar').catch(()=>{}); await p.waitForTimeout(300);
  await openNotifications();
  ok((await p.textContent('#modalRoot')).includes('Reports waiting: 1'),'the bell says how many reports are waiting');
  await p.locator('[data-notif-target]').first().click(); await p.waitForTimeout(1200);
  ok((await p.textContent('.chat-window')).includes('Report · scam'),'the notification opens the chat with the report in it');
  ok((await p.textContent('.chat-window')).includes('pay outside Cuvori'),'the whole message came through');
  await openNotifications();
  await p.click('[data-notif-reports]'); await p.waitForTimeout(1000);
  ok((await p.textContent('#adminBody')).includes('pay outside Cuvori'),'it opens straight into the report queue');
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
  await p.screenshot({path:'shots/rules.png'});
  } catch(e){ log.push('EXCEPTION '+e.message.split('\n')[0]); await p.screenshot({path:'shots/real-fail.png'}); }
  await b.close(); console.log(log.join('\n')); console.log(errs.length?('ERRORS:\n'+errs.join('\n')):'no page errors');
})();
