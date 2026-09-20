const { chromium } = require('playwright');
const log=[]; const ok=(c,m)=>log.push((c?'PASS ':'FAIL ')+m);
(async () => {
  const b = await chromium.launch(); const p = await (await b.newContext({viewport:{width:1400,height:900}})).newPage();
  const errs=[]; p.on('pageerror',e=>errs.push(e.message));
  // Mock supabase-js before the page scripts run
  // one real, public professional so the sign-in gate on Message has something to click
  await p.addInitScript(()=>{ window.__MOCK_SEED={ profiles:[{id:'11111111-1111-4111-8111-111111111111',email:'pro@test.com',first_name:'Pro',role:'editor',is_admin:false,banned:false,visibility:'public',created_at:new Date().toISOString()}],
    editor_profiles:[{id:'11111111-1111-4111-8111-111111111111',display_name:'Pro Editor',role_label:'editor',city:'Vilnius',country:'Lithuania',languages:['English'],specializations:['catShorts'],tools:[],bio:'',rate_amount:30,rate_unit:'hour',is_public:true,responds_hours:24,turnaround_days:5,revisions:2,availability:'open',availability_set_at:new Date().toISOString(),created_at:new Date().toISOString()}],
    services:[{id:'22222222-2222-4222-8222-222222222222',profile_id:'11111111-1111-4111-8111-111111111111',profession_slug:'video-editor',rate_amount:30,rate_unit:'hour',headline:'',values:{video_specialty:['catShorts']},is_public:true,sort_order:0,created_at:new Date().toISOString()}] }; });
  await p.addInitScript(require('fs').readFileSync(__dirname+'/mock-supabase.js','utf8'));
  // block the real CDN so the mock stays
  await p.route('**/supabase.min.js', r=>r.fulfill({status:200,body:'/* mocked */',contentType:'application/javascript'}));
  const url='file://'+process.cwd()+'/index.html';
  try {
  await p.goto(url); await p.waitForTimeout(500);
  ok(await p.locator('#demoBanner').isHidden(),'real mode: demo banner hidden');
  ok(await p.locator('#signInBtn').isVisible() && await p.locator('#createAccountBtn').isVisible(),'signed out: Sign in + Create account visible');
  ok(await p.locator('.account-btn').isHidden(),'signed out: Account button hidden');
  // gate: messaging requires sign in
  await p.waitForTimeout(700); await p.locator('.real-card .message-person').first().click(); await p.waitForTimeout(400);
  ok((await p.textContent('#modalRoot')).includes('Create a free account to message Pro Editor') && await p.locator('[data-jp-social="google"]').count()===1 && await p.locator('[data-jp-social="facebook"]').count()===0 && await p.locator('#jpEmail').count()===1,'Message while signed out -> pop-up: Google or e-mail (Facebook hidden until the Meta app is published)');
  ok(await p.locator('.chat-window').count()===0,'no chat opened while signed out');
  await p.click('[data-jp-social="google"]'); await p.waitForTimeout(400);
  ok((await p.locator('.toast').last().textContent()).includes('Google sign-in is not switched on yet'),'Google not switched on yet -> a clear message, nothing breaks');
  // once the provider is switched on: one click signs in and returns to the chat the visitor wanted
  await p.evaluate(()=>{ window.__mockOAuth=true; }); await p.click('[data-jp-social="google"]'); await p.waitForTimeout(1800);
  ok(await p.evaluate(()=>!!window.__mockdb.profiles.find(x=>x.email==='google-user@test.com')) && await p.locator('#signInBtn').isHidden(),'Google sign-in creates the account and signs in');
  ok(await p.locator('.chat-window').count()===1 && (await p.textContent('.chat-window')).includes('Pro Editor'),'…and the chat with Pro Editor opens by itself');
  ok((await p.textContent('#modalRoot')).includes('rules') || (await p.textContent('#modalRoot')).includes('Rules'),'a new Google account is asked to agree to the rules');
  await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML=''); await p.evaluate(()=>document.querySelectorAll('.chat-window').forEach(w=>w.remove()));
  await p.goto(url+'#account'); await p.waitForTimeout(300); await p.click('#signOutBtn'); await p.waitForTimeout(500);
  await p.goto(url+'#home'); await p.waitForTimeout(600); await p.locator('.real-card .message-person').first().click(); await p.waitForTimeout(400);
  await p.click('#jpEmail'); await p.waitForTimeout(400);
  ok(await p.locator('#page-create-account').evaluate(e=>e.classList.contains('active')) && await p.locator('[data-auth-pane="signup"]').isVisible(),'"Sign up with e-mail" opens the sign-up form');
  ok(await p.locator('[data-auth-social="google"]').count()===1 && await p.locator('[data-auth-social="facebook"]').isHidden(),'the sign-up page offers Google too; the Facebook button stays hidden while facebookLogin is off');
  // sign up
  await p.fill('#suName','Egis'); await p.fill('#suEmail','egis@example.com'); await p.fill('#suPass','short'); await p.click('[data-auth-signup]'); await p.waitForTimeout(200);
  ok((await p.locator('.toast').last().textContent()).includes('8 characters'),'short password rejected');
  await p.fill('#suPass','longpassword1'); await p.click('[data-auth-signup]'); await p.waitForTimeout(300);
  ok((await p.locator('.toast').last().textContent()).toLowerCase().includes('agree'),'sign up refused until the rules are agreed to');
  await p.check('#suAgree'); await p.click('[data-auth-signup]'); await p.waitForTimeout(800);
  ok(await p.locator('#page-account').evaluate(e=>e.classList.contains('active')),'sign up -> account page');
  ok((await p.textContent('#accountName')).trim()==='Egis','account shows real name');
  ok((await p.textContent('#accountRole')).trim()==='Client','new account is a client');
  ok(await p.locator('#signInBtn').isHidden() && await p.locator('.account-btn').isVisible(),'signed in: header switches');
  ok(await p.locator('#signOutBtn').isVisible(),'sign out button visible');
  ok(await p.locator('#myProfileBtn').isHidden(),'client: no editor profile button');
  ok(await p.locator('.reco-card').count()===0,'client: no progress reminder');
  // settings: role select disabled in real mode
  await p.goto(url+'#settings'); await p.waitForTimeout(400);
  ok(await p.locator('#accountTypeSelect').isDisabled(),'account type cannot be changed by hand');
  // invite -> editor
  await p.goto(url+'#join-editor'); await p.waitForTimeout(300);
  await p.fill('#inviteCode','CUV-AAAA-BBBB'); await p.click('#inviteBtn'); await p.waitForTimeout(300);
  ok((await p.textContent('#inviteResult')).includes('not valid'),'invalid invite rejected by server');
  await p.fill('#inviteCode','CUV-2026-EDIT'); await p.click('#inviteBtn'); await p.waitForTimeout(500);
  ok((await p.textContent('#inviteResult')).includes('Invite accepted'),'valid invite accepted by server');
  await p.goto(url+'#account'); await p.waitForTimeout(300);
  ok((await p.textContent('#accountRole')).trim()==='Editor','role is now Editor');
  ok(await p.locator('#myProfileBtn').isVisible(),'editor: My editor profile button');
  // sign out / sign in with wrong then right password
  await p.click('#signOutBtn'); await p.waitForTimeout(400);
  ok(await p.locator('#signInBtn').isVisible(),'signed out again');
  await p.click('#signInBtn'); await p.waitForTimeout(300);
  ok(await p.locator('[data-auth-pane="signin"]').isVisible(),'Sign in button opens sign-in pane');
  await p.fill('#siEmail','egis@example.com'); await p.fill('#siPass','wrong'); await p.click('[data-auth-signin]'); await p.waitForTimeout(300);
  ok((await p.locator('.toast').last().textContent()).includes('Wrong email'),'wrong password message');
  await p.fill('#siPass','longpassword1'); await p.click('[data-auth-signin]'); await p.waitForTimeout(600);
  ok(await p.locator('#page-account').evaluate(e=>e.classList.contains('active')),'sign in -> account page');
  ok((await p.textContent('#accountRole')).trim()==='Editor','role persisted from server');
  // duplicate sign up
  await p.click('#signOutBtn'); await p.waitForTimeout(300); await p.click('#createAccountBtn'); await p.waitForTimeout(300);
  await p.fill('#suName','X'); await p.fill('#suEmail','egis@example.com'); await p.fill('#suPass','longpassword1'); await p.check('#suAgree'); await p.click('[data-auth-signup]'); await p.waitForTimeout(300);
  ok((await p.locator('.toast').last().textContent()).includes('already exists'),'duplicate email message');
  await p.screenshot({path:'shots/auth.png'});
  } catch(e){ log.push('EXCEPTION '+e.message.split('\n')[0]); await p.screenshot({path:'shots/auth-fail.png'}); }
  await b.close(); console.log(log.join('\n')); console.log(errs.length?('ERRORS:\n'+errs.join('\n')):'no page errors');
})();
