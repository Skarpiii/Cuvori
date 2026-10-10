// The browser itself must refuse injected scripts (defence in depth behind escaping).
const { chromium } = require('playwright'); const fs=require('fs');
(async () => {
  const b = await chromium.launch(); const ctx = await b.newContext();
  await ctx.addInitScript(fs.readFileSync(process.cwd()+'/mock-supabase.js','utf8'));
  await ctx.route('**/supabase.min.js', r=>r.fulfill({status:200,body:'/* mocked */',contentType:'application/javascript'}));
  const p = await ctx.newPage(); const errs=[]; const csp=[];
  p.on('pageerror', e=>errs.push(e.message));
  p.on('console', m=>{ if(/Content Security Policy/i.test(m.text())) csp.push(m.text().slice(0,120)); });
  await p.goto('file://'+process.cwd()+'/index.html'); await p.waitForTimeout(800);
  const appRuns = await p.evaluate(()=>document.querySelectorAll('#quickFlags button').length>0 && document.querySelectorAll('#mobileIconbar .mib').length>0);
  await p.evaluate(()=>{ window.__csp=0; const d=document.createElement('div'); d.innerHTML='<img src="x" onerror="window.__csp=1"><a id="jsl" href="javascript:window.__csp=2">x</a>'; document.body.append(d); });
  await p.waitForTimeout(400);
  await p.click('#jsl').catch(()=>{}); await p.waitForTimeout(300);
  await p.evaluate(()=>{ const s=document.createElement('script'); s.textContent='window.__csp=3'; document.body.append(s); });
  await p.waitForTimeout(200);
  const pwn = await p.evaluate(()=>window.__csp);
  console.log((appRuns?'PASS':'FAIL')+' app still runs under the policy');
  console.log((pwn===0?'PASS':'FAIL')+' injected handler / javascript: link / script tag blocked (flag='+pwn+')');
  console.log((csp.length?'PASS':'FAIL')+' browser reports blocked attempts ('+csp.length+')');
  console.log(errs.length?'page errors: '+errs.join(' | '):'no page errors');
  await b.close();
  // the test runner counts this check only through its exit code: any FAIL, or a page error, is a failure
  process.exit(appRuns && pwn===0 && csp.length && !errs.length ? 0 : 1);
})().catch(e => { console.log('FAIL the test crashed: '+String(e && e.message || e).split('\n')[0]); process.exit(1); });
