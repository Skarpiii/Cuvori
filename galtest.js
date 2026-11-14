const { chromium, devices } = require('playwright');
const url='file://'+(process.env.TARGET?require('path').resolve(process.env.TARGET):process.cwd())+'/index.html';   // the copy under test (TARGET), else the folder it is started in
const log=[]; const ok=(c,m)=>log.push((c?'PASS ':'FAIL ')+m);
async function arrows(p, sel){ return p.evaluate(s=>{const c=document.querySelector(s);return {prev:!c.querySelector('.car-prev').classList.contains('hidden'),next:!c.querySelector('.car-next').classList.contains('hidden')};},sel); }
(async () => {
  const b = await chromium.launch({args:['--touch-events=enabled']}); const errs=[];
  // ---------- desktop ----------
  let p = await (await b.newContext({viewport:{width:1400,height:900}})).newPage();
  p.on('pageerror',e=>errs.push('desktop '+e.message));
  await p.goto(url); await p.waitForTimeout(400);
  // set editor role so we can test owner tools & 2-video portfolio (Egidijus)
  await p.evaluate(()=>localStorage.setItem('cuvoriReco',JSON.stringify({role:'editor',reminderEnabled:true,snooze:{},lastUpdates:{}})));
  await p.reload(); await p.waitForTimeout(400);
  // Home cards: gallery per card, arrows only within card
  const cards=await p.locator('.profile-card').count();
  for(let i=0;i<cards;i++){
    const sel=`.profile-card:nth-child(${i+1}) .card-gallery`;
    const n=await p.locator(sel+' .car-item').count();
    let a=await arrows(p,sel); ok(a.prev===false && a.next===(n>1), `card ${i+1}: first video arrows prev=${a.prev} next=${a.next} (n=${n})`);
    for(let k=1;k<n;k++){ await p.click(sel+' .car-next'); await p.waitForTimeout(800); }
    a=await arrows(p,sel); ok(a.prev===(n>1) && a.next===false, `card ${i+1}: last video arrows prev=${a.prev} next=${a.next}`);
    const counter=await p.textContent(sel+' .media-counter'); ok(counter.trim()===`${n} / ${n}`, `card ${i+1}: counter ${counter.trim()}`);
    // extra next click must not loop
    ok(await p.locator(sel+' .car-next').isHidden(), `card ${i+1}: next hidden at end (no loop)`);
  }
  await p.screenshot({path:'shots/g-home.png'});
  // Card gallery click opens viewer for that editor only
  await p.click('.profile-card:nth-child(2) .card-gallery .car-item[data-i="0"]'); await p.waitForTimeout(400);
  const vn=await p.locator('#viewerCar .car-item').count();
  ok(vn===5, `viewer from Alex card has only Alex's 5 videos (got ${vn})`);
  ok((await p.textContent('#viewerCount')).includes('1 of 5'), 'viewer counter 1 of 5');
  let a=await arrows(p,'#viewerCar'); ok(!a.prev && a.next,'viewer first: prev hidden, next shown');
  await p.click('#viewerCar .car-next'); await p.waitForTimeout(800); a=await arrows(p,'#viewerCar'); ok(a.prev&&a.next,'viewer middle: both arrows');
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(800); await p.keyboard.press('ArrowRight'); await p.waitForTimeout(800); await p.keyboard.press('ArrowRight'); await p.waitForTimeout(800);
  a=await arrows(p,'#viewerCar'); ok(a.prev&&!a.next,'viewer last: next hidden');
  ok((await p.textContent('#viewerCount')).includes('5 of 5'),'viewer counter 5 of 5');
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(800); ok((await p.textContent('#viewerCount')).includes('5 of 5'),'ArrowRight at end does not loop');
  await p.screenshot({path:'shots/g-viewer.png'});
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  // Profile page (Maya, 6 videos)
  await p.click('.profile-card:nth-child(1) .view-profile'); await p.waitForTimeout(500);
  ok(await p.locator('#pfVideos .work').count()===6,'profile: 6 small work cards in row');
  a=await arrows(p,'#pfVideos'); ok(!a.prev && a.next,'profile row start: prev hidden, next shown');
  // thumbnails linked: 3 linked (even idx) + 1 standalone
  const thumbs=await p.locator('#pfThumbs .thumb').count(); ok(thumbs===4,`profile: ${thumbs} thumbnails (3 linked + 1 unlinked)`);
  ok(await p.locator('#pfThumbs .thumb.active[data-link="0"]').count()===1,'thumb linked to video 1 highlighted initially');
  // horizontal scroll without arrows (wheel/drag) -> index changes & thumb sync
  await p.hover('#pfVideos .car-track'); await p.mouse.wheel(600,0); await p.waitForTimeout(600);
  const sl=await p.evaluate(()=>document.querySelector('#pfVideos .car-track').scrollLeft); ok(sl>100,`profile row scrolled without arrows (scrollLeft=${sl})`);
  const activeLink=await p.evaluate(()=>{const t=document.querySelector('#pfThumbs .thumb.active');return t?t.dataset.link:null;}); ok(activeLink!=null && +activeLink>0, `thumb sync moved to video ${+activeLink+1}`);
  // mouse drag
  const box=await p.locator('#pfVideos .car-track').boundingBox();
  await p.mouse.move(box.x+600,box.y+80); await p.mouse.down(); await p.mouse.move(box.x+300,box.y+80,{steps:8}); await p.mouse.up(); await p.waitForTimeout(500);
  const sl2=await p.evaluate(()=>document.querySelector('#pfVideos .car-track').scrollLeft); ok(sl2>sl,`mouse drag scrolled further (${sl2})`);
  // hover preview
  await p.hover('#pfVideos .work[data-work="1"]'); await p.waitForTimeout(500);
  ok(await p.locator('#pfVideos .work[data-work="1"] video.hover-preview').count()===1,'hover starts preview video');
  const muted=await p.evaluate(()=>document.querySelector('.hover-preview').muted); ok(muted,'preview is muted');
  await p.mouse.move(10,400); await p.waitForTimeout(300); ok(await p.locator('video.hover-preview').count()===0,'preview stops on mouse leave');
  // click thumb linked to 4 -> row goes to video 4
  await p.click('#pfThumbs .thumb[data-link="4"]'); await p.waitForTimeout(600);
  ok(await p.locator('#pfThumbs .thumb.active[data-link="4"]').count()===1,'clicking linked thumb selects video 5');
  await p.screenshot({path:'shots/g-profile.png'});
  // click a work -> viewer opens at that index, only Maya's 6
  await p.click('#pfVideos .work[data-work="2"] .media'); await p.waitForTimeout(500);
  ok(await p.locator('#viewerCar .car-item').count()===6,'viewer from profile: 6 videos');
  ok((await p.textContent('#viewerCount')).includes('3 of 6'),'viewer opened at video 3');
  a=await arrows(p,'#viewerCar'); ok(a.prev&&a.next,'viewer middle from profile: both arrows');
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  // Owner tools not visible on Maya
  ok(await p.locator('.pf-ownerbar').count()===0,'no owner controls on someone else\'s profile');
  // Own profile (2 videos) with owner tools
  await p.goto(url+'#account'); await p.reload(); await p.waitForTimeout(400);
  await p.click('#myProfileBtn'); await p.waitForTimeout(500);
  ok(await p.locator('.pf-ownerbar').count()===1,'owner bar on own profile');
  ok(await p.locator('#pfVideos .work').count()===2,'own profile has 2 videos');
  a=await arrows(p,'#pfVideos'); ok(!a.prev && !a.next,'2 videos fit in view: no arrows needed');
  // reorder: move 2nd to first
  const t0=await p.textContent('#pfVideos .work[data-work="0"] .work-title');
  await p.click('#pfVideos .work[data-work="1"] [data-mv="first"]'); await p.waitForTimeout(300);
  const t1=await p.textContent('#pfVideos .work[data-work="0"] .work-title'); ok(t0!==t1,'reorder moved project to start');
  // delete with confirmation
  await p.click('#pfVideos .work[data-work="1"] [data-del]'); await p.waitForTimeout(300);
  ok(await p.locator('#confirmDel').count()===1,'delete asks for confirmation');
  await p.click('[data-close-modal]'); await p.waitForTimeout(200); ok(await p.locator('#pfVideos .work').count()===2,'cancel keeps project');
  await p.click('#pfVideos .work[data-work="1"] [data-del]'); await p.waitForTimeout(200); await p.click('#confirmDel'); await p.waitForTimeout(300);
  ok(await p.locator('#pfVideos .work').count()===1,'confirmed delete removes project (1-video portfolio)');
  // 1-video: viewer no arrows
  await p.click('#pfVideos .work[data-work="0"] .media'); await p.waitForTimeout(400);
  a=await arrows(p,'#viewerCar'); ok(!a.prev&&!a.next,'1-video viewer: no arrows');
  ok((await p.textContent('#viewerCount')).includes('1 of 1'),'1-video counter');
  await p.keyboard.press('Escape');
  // add project via link
  await p.click('[data-pf-add]'); await p.waitForTimeout(300);
  await p.fill('#npUrl','https://www.youtube.com/watch?v=dQw4w9WgXcQ'); await p.fill('#npTitle','Test YouTube'); await p.fill('#npTags','wedding, drone');
  await p.click('#npSave'); await p.waitForTimeout(400);
  ok(await p.locator('#pfVideos .work').count()===2,'add project via YouTube link');
  const bg=await p.evaluate(()=>document.querySelector('#pfVideos .work[data-work="1"] .media').style.backgroundImage); ok(bg.includes('img.youtube.com'),'YouTube preview thumbnail used when no custom thumb');
  await p.screenshot({path:'shots/g-owner.png'});
  // persisted after reload
  await p.reload(); await p.waitForTimeout(400); await p.goto(url+'#account'); await p.waitForTimeout(200); await p.click('#myProfileBtn'); await p.waitForTimeout(400);
  ok(await p.locator('#pfVideos .work').count()===2,'portfolio changes persist after reload');
  // ---------- mobile / touch ----------
  const ctx=await b.newContext({...devices['iPhone 13']}); const m=await ctx.newPage();
  m.on('pageerror',e=>errs.push('mobile '+e.message));
  await m.goto(url); await m.waitForTimeout(500);
  const sel='.profile-card:nth-child(1) .card-gallery';
  let ma=await arrows(m,sel); ok(!ma.prev&&ma.next,'mobile card: arrows present at first video');
  // swipe with touch
  await m.locator(sel+' .car-track').scrollIntoViewIfNeeded(); await m.waitForTimeout(200);
  const bb=await m.locator(sel+' .car-track').boundingBox();
  const cdp=await ctx.newCDPSession(m);
  const tx=bb.x+bb.width*0.85, ty=bb.y+bb.height/2;
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:tx,y:ty}]});
  for(let i=1;i<=12;i++){ await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:tx-i*22,y:ty}]}); await m.waitForTimeout(16); }
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await m.waitForTimeout(800);
  const mc=await m.textContent(sel+' .media-counter'); ok(mc.trim().startsWith('2 /'),`mobile swipe moved to next video (counter ${mc.trim()})`);
  ma=await arrows(m,sel); ok(ma.prev&&ma.next,'mobile middle: both arrows');
  await m.screenshot({path:'shots/g-mobile-home.png'});
  // mobile profile row + viewer
  await m.click('.profile-card:nth-child(1) .view-profile'); await m.waitForTimeout(500);
  ok(await m.locator('#pfVideos .work').count()===6,'mobile profile row renders');
  ok(await m.locator('video.hover-preview').count()===0,'mobile: no hover preview dependency');
  await m.click('#pfVideos .work[data-work="0"] .media'); await m.waitForTimeout(500);
  ma=await arrows(m,'#viewerCar'); ok(!ma.prev&&ma.next,'mobile viewer: arrows at first video');
  await m.screenshot({path:'shots/g-mobile-viewer.png'});
  await b.close();
  console.log(log.join('\n')); console.log(errs.length?('ERRORS:\n'+errs.join('\n')):'no page errors');
})();
