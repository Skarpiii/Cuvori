// Coming back from Google/Facebook: Supabase sends the visitor to cuvori.io/#access_token=… — the site must read that as a sign-in,
// not as a page name. Also covers an error return and a password-reset link (same shape of address).
const { chromium } = require('playwright');
const log=[]; const ok=(c,m)=>log.push((c?'PASS ':'FAIL ')+m);
(async () => {
  const b = await chromium.launch(); const ctx=await b.newContext({viewport:{width:1400,height:900}});
  const url='file://'+require('path').resolve(__dirname,'..')+'/index.html';
  async function fresh(hash){
    const p=await ctx.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
    await p.addInitScript(require('fs').readFileSync(__dirname+'/../mock-supabase.js','utf8'));
    await p.route('**/supabase.min.js', r=>r.fulfill({status:200,body:'/* mocked */',contentType:'application/javascript'}));
    await p.goto(url+hash); await p.waitForTimeout(1500);
    return { p, errs };
  }
  try {
    // 1. the real return address after "Continue with Google"
    let { p, errs } = await fresh('#access_token=mock-google&refresh_token=r&expires_in=3600&token_type=bearer');
    ok(errs.length===0,'return from Google: no script error (was: invalid selector "#page-access_token=…" killed the start-up) '+errs.join(' | '));
    ok(await p.locator('#signInBtn').isHidden() && await p.locator('#createAccountBtn').isHidden(),'…the header switches to signed-in (Sign in / Create account gone)');
    ok(await p.locator('.account-btn').first().isVisible(),'…the Account button appears');
    ok(await p.locator('#page-account').evaluate(e=>e.classList.contains('active')) && await p.locator('#signOutBtn').isVisible(),'…lands on the Account page with a Sign out button');
    ok(await p.evaluate(()=>location.hash)==='#account','…and the tokens are gone from the address ('+await p.evaluate(()=>location.hash)+')');
    ok((await p.locator('.toast').allTextContents()).some(x=>/welcome/i.test(x)),'…with a welcome message');
    ok(await p.evaluate(()=>!!window.__mockdb.profiles.find(x=>x.email==='google-user@test.com')),'…the account exists');
    ok((await p.textContent('#modalRoot')).toLowerCase().includes('rules'),'…a new account is asked to agree to the rules');
    await p.evaluate(()=>document.querySelector('#modalRoot').innerHTML='');
    await p.click('.nav-btn[data-route="jobs"]'); await p.waitForTimeout(300);
    ok(await p.locator('#page-jobs').evaluate(e=>e.classList.contains('active')),'…and the rest of the site still works (Jobs opens)');
    await p.click('.account-btn >> visible=true'); await p.waitForTimeout(300); await p.click('#signOutBtn'); await p.waitForTimeout(500);
    ok(await p.locator('#signInBtn').isVisible(),'…sign out works after an OAuth sign-in');
    await p.close();

    // 2. the provider said no (e.g. Facebook account without a verified e-mail)
    ({ p, errs } = await fresh('#error=access_denied&error_code=provider_email_needs_verification&error_description=Unverified+email+with+facebook'));
    ok(errs.length===0,'error return: no script error');
    ok(await p.locator('#signInBtn').isVisible(),'…still signed out');
    ok((await p.locator('.toast').allTextContents()).some(x=>x.includes('Unverified email with facebook')),'…the provider\'s reason is shown');
    ok(await p.evaluate(()=>location.hash)==='#home','…address cleaned');
    await p.click('#createAccountBtn'); await p.waitForTimeout(300);
    ok(await p.locator('#page-create-account').evaluate(e=>e.classList.contains('active')),'…Create account still reacts');
    await p.close();

    // 3. a password-reset e-mail link has the same shape
    ({ p, errs } = await fresh('#access_token=mock-google&refresh_token=r&expires_in=3600&token_type=bearer&type=recovery'));
    ok(errs.length===0,'password-reset link: no script error');
    ok((await p.textContent('#modalRoot')).toLowerCase().includes('new password'),'…the "set a new password" box opens');
    ok(!(await p.locator('.toast').allTextContents()).some(x=>/welcome/i.test(x)),'…without a welcome toast');
    await p.close();

    // 4. a plain hash a stranger types must not break anything either
    ({ p, errs } = await fresh('#page-x=1&weird[]=2'));
    ok(errs.length===0 && await p.locator('#page-home').evaluate(e=>e.classList.contains('active')),'junk in the address -> home, no error');
    await p.close();

    // 5. the mock's redirect variant: Continue with Google leaves and comes back with tokens (end to end through socialSignIn)
    ({ p, errs } = await fresh('#home'));
    await p.evaluate(()=>{ window.__mockOAuth=true; window.__mockOAuthRedirect=true; });
    await p.click('#createAccountBtn'); await p.waitForTimeout(300); await p.click('[data-auth-social="google"]'); await p.waitForTimeout(2000);
    ok(errs.length===0 && await p.locator('#signInBtn').isHidden() && await p.evaluate(()=>location.hash)==='#account','sign-up page -> Continue with Google -> redirect -> signed in on Account');
    await p.close();
  } catch(e){ log.push('CRASH '+e.message); }
  await b.close();
  console.log(log.join('\n')); const f=log.filter(l=>!l.startsWith('PASS')).length; console.log(`\n${log.length-f}/${log.length} passed`); process.exit(f?1:0);
})();
