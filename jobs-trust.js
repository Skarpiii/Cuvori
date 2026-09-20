  // =====================================================================
  // Jobs a freelancer can trust (schema v20).
  // Every card answers: when was this posted, is it still active, who is the client
  // (verified? hires? new?), is the payment secured. Owners manage states in "My jobs";
  // anyone signed in can report a job; the admin has a review queue with an audit trail.
  // Scores stay internal: the public sees facts, never a number.
  // =====================================================================
  state.jt = { sort:"newest", verified:false, secured:false, within:"", myJobs:[], rules:null };
  function jtRules(){ return state.jt.rules || { expiry_days:30 }; }
  async function jtLoadRules(){ if(!REAL) return; try{ const { data } = await sb.rpc("setting",{ p_key:"posting_rules" }); if(data && typeof data==="object") state.jt.rules=data; }catch(e){} }
  function jtDays(ts){ return Math.floor((Date.now()-new Date(ts).getTime())/86400000); }
  function jtAgo(ts){
    const d=jtDays(ts);
    if(d<1) return t("jt_today"); if(d===1) return t("jt_yesterday"); if(d<7) return fill(t("jt_days"),{n:d});
    if(d<60) return fill(t("jt_weeks"),{n:Math.floor(d/7)}); return fill(t("jt_on"),{d:fmtDate(ts)});
  }
  function jtExact(ts){ try{ return new Date(ts).toLocaleString(); }catch(e){ return ""; } }
  function jtMonth(ym){ try{ return new Date(ym+"-01T00:00:00").toLocaleDateString(undefined,{month:"short",year:"numeric"}); }catch(e){ return ym||""; } }
  // the trust line: facts about the client and the job, never a score
  function jtTrustHtml(j, long){
    const c=j.client||{}; const out=[];
    if(c.identity==="verified") out.push(`<span class="trust ok">✓ ${escapeHtml(t("jt_verified"))}</span>`);
    if(j.payment_secured) out.push(`<span class="trust ok">✓ ${escapeHtml(t("jt_secured"))}</span>`);
    if(c.is_new) out.push(`<span class="trust">${escapeHtml(t("jt_newClient"))}</span>`);
    else{
      const h=Number(c.hires||0); out.push(`<span class="trust">${escapeHtml(h===1?t("jt_hireOne"):h?fill(t("jt_hires"),{n:h}):t("jt_noHires"))}</span>`);
      if(c.hire_rate!=null) out.push(`<span class="trust">${escapeHtml(fill(t("jt_hireRate"),{p:c.hire_rate}))}</span>`);
    }
    if(long){
      const n=Number(c.jobs_posted||0); out.push(`<span class="trust">${escapeHtml(n===1?t("jt_jobPosted"):fill(t("jt_jobsPosted"),{n}))}</span>`);
      if(c.member_since) out.push(`<span class="trust">${escapeHtml(fill(t("jt_memberSince"),{d:jtMonth(c.member_since)}))}</span>`);
    }
    return `<div class="job-trust">${out.join("")}</div>`;
  }
  function jtStatus(j){ if(j.status==="open" && j.expires_at && new Date(j.expires_at)<new Date()) return "expired"; return j.status; }
  function jtStatusPill(st){ const cls={open:"ok",filled:"",closed:"",expired:"warn",hidden:"warn",removed:"danger"}[st]||""; return `<span class="status-pill ${cls}">${escapeHtml(t("jt_st_"+st)||st)}</span>`; }
  function jtErr(error, data){
    const code=String((data && data!=="ok") ? data : ((error && (error.message||error.hint||error.details)) || ""));
    const map={ identity_required:"jt_err_identity", job_daily_limit:"jt_err_daily", job_active_limit:"jt_err_active", job_plan_limit:"jt_err_plan", duplicate_cooldown:"jt_err_dup", too_many_renewals:"jt_err_renewals", under_review:"jt_err_review" };
    for(const k of Object.keys(map)) if(code.includes(k)) return t(map[k]);
    return errText(error, data);
  }

  // ----- My jobs: the owner's list, every state, with the reason when Cuvori stepped in -----
  async function loadMyJobs(){
    if(!REAL || !signedIn()){ state.jt.myJobs=[]; renderMyJobs(); return; }
    const { data } = await sb.rpc("my_jobs"); state.jt.myJobs=data||[]; renderMyJobs();
  }
  function renderMyJobs(){
    const host=$("#myJobsPanel"); if(!host) return;
    const rows=state.jt.myJobs; host.classList.toggle("hidden", !rows.length);
    if(!rows.length){ host.innerHTML=""; return; }
    const exp=jtRules().expiry_days||30;
    host.innerHTML=`<div class="panel" style="margin-bottom:14px"><div class="panel-head" style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><h3 style="margin:0">${escapeHtml(t("jt_myJobs"))}</h3><span class="muted small">${escapeHtml(fill(t("jt_myJobsHint"),{n:exp}))}</span></div>
      <div class="mj-table" style="margin-top:10px">${rows.map(j=>{
        const st=jtStatus(j); const left=j.expires_at?Math.ceil((new Date(j.expires_at)-Date.now())/86400000):null;
        const when=st==="open"&&left!=null?` · ${escapeHtml(left<=0?t("jt_expiresToday"):fill(t("jt_expiresIn"),{n:left}))}`:"";
        let why="";
        if(st==="hidden") why=j.hidden_reason==="auto_review"?t("jt_hiddenAuto"):j.hidden_reason==="account_suspended"?t("jt_hiddenSuspended"):fill(t("jt_hiddenBy"),{reason:j.hidden_reason||""});
        if(st==="removed") why=fill(t("jt_removedBy"),{reason:j.hidden_reason||""});
        const acts=[];
        if(st==="open"){ acts.push(`<button class="link-btn" data-jt="filled">${escapeHtml(t("jt_markFilled"))}</button>`, `<button class="link-btn" data-jt="closed">${escapeHtml(t("jt_closeJob"))}</button>`); if(left!=null && left<=7) acts.push(`<button class="link-btn" data-jt="renew">${escapeHtml(fill(t("jt_renew"),{n:exp}))}</button>`); }
        if(st==="filled"||st==="closed") acts.push(`<button class="link-btn" data-jt="open">${escapeHtml(t("jt_reopen"))}</button>`);
        if(st==="expired") acts.push(`<button class="link-btn" data-jt="renew">${escapeHtml(fill(t("jt_renew"),{n:exp}))}</button>`);
        if(st==="hidden"||st==="removed") acts.push(`<button class="link-btn" data-jt="appeal">${escapeHtml(t("jt_appeal"))}</button>`);
        return `<div class="mj-row" data-myjob="${j.id}"><div class="admin-main"><div><strong>${escapeHtml(j.title)}</strong> ${jtStatusPill(st)}${j.payment_secured?` <span class="trust ok">✓ ${escapeHtml(t("jt_secured"))}</span>`:""}</div>
          <div class="muted small" title="${escapeHtml(jtExact(j.created_at))}">${escapeHtml(jtAgo(j.created_at))}${when}${j.hires?` · ${escapeHtml(j.hires===1?t("jt_hireOne"):fill(t("jt_hires"),{n:j.hires}))}`:""}</div>
          ${why?`<div class="muted small" style="margin-top:4px">${escapeHtml(why)}</div>`:""}</div>
          <div class="admin-actions">${acts.join("")}</div></div>`; }).join("")}</div></div>`;
    $$("[data-myjob]",host).forEach(row=>{
      const id=row.dataset.myjob; const j=rows.find(x=>x.id===id);
      $$("[data-jt]",row).forEach(b=>b.addEventListener("click",async()=>{
        const a=b.dataset.jt;
        if(a==="appeal"){ reportModal("job", id); setTimeout(()=>{ const ta=$("#rpBody"); if(ta && !ta.value) ta.value=fill(t("jt_appealBody"),{title:j.title}); },0); return; }
        const { data, error } = a==="renew" ? await sb.rpc("renew_job",{ p_job:id }) : await sb.rpc("set_job_status",{ p_job:id, p_status:a });
        if(error || data!=="ok"){ toast(jtErr(error,data)); return; }
        toast(t(a==="renew"?"jt_renewed":"jt_updated")); loadJobs();
      }));
    });
  }

  // ----- Report job: one tap, a reason, a person reads it -----
  function jobReportModal(jobId){
    if(!signedIn()){ joinPrompt(null); return; }
    const reasons=["scam","fake","spam","duplicate","payment","inappropriate","other"];
    openModal(t("jt_reportTitle"), `<label>${escapeHtml(t("jt_reportWhy"))}</label>
      <div class="ct-toggle" style="display:flex;flex-direction:column;gap:6px;margin:6px 0 12px">${reasons.map((r,i)=>`<label class="check"><input type="radio" name="jrReason" value="${r}" ${i===0?"checked":""}> <span>${escapeHtml(t("jt_r_"+r))}</span></label>`).join("")}</div>
      <label>${escapeHtml(t("jt_reportNote"))}</label><textarea id="jrNote" rows="3" maxlength="1000"></textarea>
      <button class="primary" id="jrSend" style="margin-top:14px;width:100%">${escapeHtml(t("jt_reportSend"))}</button>
      <p class="muted small" style="margin-top:10px">${escapeHtml(t("jt_reportHint"))}</p>`, root=>{
        $("#jrSend",root).addEventListener("click",async()=>{
          const reason=($("input[name=jrReason]:checked",root)||{}).value||"other", note=$("#jrNote",root).value.trim();
          if(!REAL){ closeModal(); toast(t("jt_reportThanks")); return; }
          const { data, error } = await sb.rpc("report_job",{ p_job:jobId, p_reason:reason, p_note:note });
          if(error || data!=="ok"){ toast(jtErr(error,data)); return; }
          closeModal(); toast(t("jt_reportThanks"));
        });
      });
  }

  // ----- Admin: the review queue and the posting rules -----
  function renderAdminJobs(){
    const host=$("#adminBody"); const q=ADMIN.jobQueue||[]; const rules=ADMIN.rules||{};
    const num=(k,label)=>`<label style="display:flex;flex-direction:column;gap:3px;font-size:12px">${label}<input type="number" min="0" max="10000" data-rule="${k}" value="${escapeHtml(String(rules[k]??""))}" style="width:110px"></label>`;
    const flagText=f=>{ const d=f.detail||{}; if(f.kind==="reports") return `${d.reports||0} report(s)`; if(f.kind==="risk_text") return `text: ${d.hit||""}`; if(f.kind==="links") return `link: ${String(d.hit||"").replace(/^link:/,"")}`; if(f.kind==="duplicate") return `same text as "${d.title||""}" (${d.other_status||""}, ${fmtDate(d.at)})`; if(f.kind==="near_duplicate") return `${Math.round((d.similarity||0)*100)}% like "${d.title||""}" (${fmtDate(d.at)})`; if(f.kind==="repeat_no_hire") return `${d.jobs_posted} jobs posted, ${d.hires} hires, account ${d.account_days} days old`; return f.kind; };
    host.innerHTML=`<div class="panel" style="margin-bottom:14px"><h3 style="margin:0 0 8px">Posting rules</h3><p class="muted small" style="margin:0 0 10px">Limits protect the feed without punishing good clients. A "verified" client is one Stripe has checked (payouts or identity) or one you marked verified.</p>
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:flex-end">${num("expiry_days","Job expires after (days)")}${num("daily_limit_new","Posts per day — new client")}${num("daily_limit_verified","Posts per day — verified")}${num("active_limit_new","Active jobs — new client")}${num("active_limit_verified","Active jobs — verified")}${num("duplicate_cooldown_days","Same job again after (days)")}${num("auto_hide_score","Hide for review at risk score")}
      <label class="check" style="font-size:12px"><input type="checkbox" id="ruleIdentity" ${rules.require_identity?"checked":""}> Identity verification required to post</label>
      <button class="primary" id="saveRules">Save rules</button></div></div>
      <div class="admin-stats" style="margin-bottom:10px"><span><strong>${q.length}</strong> waiting for review</span></div>
      ${q.length?`<div class="admin-table">${q.map(e=>{ const j=e.job||{}; const c=e.client||{}; return `
        <div class="admin-row" data-ajob="${j.id}" style="align-items:flex-start">
          <div class="admin-main">
            <div><strong>${escapeHtml(j.title||"")}</strong> ${jtStatusPill(jtStatus(j))} <span class="muted small">score ${e.score}</span></div>
            <div class="muted small">${escapeHtml(e.owner_name||"")} <span class="muted">${escapeHtml(e.owner_email||"")}</span>${e.owner_banned?` · <span class="danger-text">BANNED</span>`:""} · ${c.jobs_posted||0} jobs · ${c.hires||0} hires · ${c.identity==="verified"?"identity verified":"not verified"} · member since ${escapeHtml(jtMonth(c.member_since))} · posted ${fmtDate(j.created_at)}${j.budget?` · ${escapeHtml(j.budget)}`:""}</div>
            <div class="muted small" style="margin-top:6px;white-space:pre-wrap">${escapeHtml(String(j.description||"").slice(0,600))}</div>
            <div style="margin-top:6px">${(e.flags||[]).map(f=>`<span class="pill" title="${escapeHtml(f.kind)}">${escapeHtml(f.kind)} +${f.score}: ${escapeHtml(flagText(f))}</span> `).join("")}</div>
            ${(e.reports||[]).length?`<div class="muted small" style="margin-top:6px">${e.reports.map(r=>`<div>⚑ ${escapeHtml(r.reason)} — ${escapeHtml(r.reporter||"")}${r.note?": "+escapeHtml(r.note):""} <span class="muted">${fmtDate(r.at)}</span></div>`).join("")}</div>`:""}
            ${(e.history||[]).length?`<div class="muted small" style="margin-top:6px">Other jobs by this client: ${e.history.map(h=>`${escapeHtml(h.title)} (${escapeHtml(h.status)}, ${fmtDate(h.at)})`).join(" · ")}</div>`:""}
            ${(e.actions||[]).length?`<div class="muted small" style="margin-top:6px">Previous actions: ${e.actions.map(a=>`${escapeHtml(a.action)}${a.reason?" — "+escapeHtml(a.reason):""} (${fmtDate(a.at)})`).join(" · ")}</div>`:""}
          </div>
          <div class="admin-actions" style="flex-direction:column;align-items:flex-start;gap:6px">
            <button class="link-btn" data-aj="approve">Approve (looks fine)</button>
            <button class="link-btn" data-aj="false_positive">False positive</button>
            ${jtStatus(j)==="hidden"?`<button class="link-btn" data-aj="unhide">Unhide</button>`:`<button class="link-btn" data-aj="hide">Hide…</button>`}
            <button class="link-btn" data-aj="warn">Warn the client…</button>
            <button class="link-btn danger-text" data-aj="remove">Remove…</button>
            <button class="link-btn danger-text" data-aj="suspend">Suspend account…</button>
            ${c.identity!=="verified"?`<button class="link-btn" data-aj="verify">Mark client verified…</button>`:""}
          </div>
        </div>`; }).join("")}</div>`:`<div class="muted">Nothing is waiting for review.</div>`}`;
    $("#saveRules").addEventListener("click",async()=>{
      const v={...rules}; $$("[data-rule]",host).forEach(i=>{ const n=Number(i.value); if(Number.isFinite(n)) v[i.dataset.rule]=n; }); v.require_identity=$("#ruleIdentity").checked;
      const { data, error } = await sb.rpc("admin_set_setting",{ p_key:"posting_rules", p_value:v }); if(error||data!=="ok"){ toast(errText(error,data)); return; } toast("Rules saved"); state.jt.rules=v; openAdmin();
    });
    $$("[data-ajob]",host).forEach(row=>{
      const id=row.dataset.ajob; const e=q.find(x=>(x.job||{}).id===id); const j=e.job||{};
      const act=async(action,reason)=>{ const { data, error } = await sb.rpc("admin_job_action",{ p_job:id, p_action:action, p_reason:reason||"" }); if(error||data!=="ok"){ toast(errText(error,data)); return; } toast("Done"); openAdmin(); };
      const ask=(title, hint, action, min)=>openModal(title, `<p class="muted" style="margin-bottom:10px">${hint}</p><label>Reason (the client can see it)</label><input id="ajReason" maxlength="1000"><button class="primary" id="ajGo" style="margin-top:14px">${title}</button>`, root=>{
        $("#ajGo",root).addEventListener("click",async()=>{ const r=$("#ajReason",root).value.trim(); if(r.length<(min||3)){ toast(t("a_fillAll")); return; } closeModal(); await act(action,r); }); });
      $$("[data-aj]",row).forEach(b=>b.addEventListener("click",async()=>{
        const a=b.dataset.aj;
        if(a==="approve"||a==="false_positive"||a==="unhide") return act(a, a==="false_positive"?"false positive":"");
        if(a==="hide") return ask("Hide job", "The job leaves the feed until you unhide it. The owner sees your reason under My jobs.", "hide");
        if(a==="remove") return ask("Remove job", "The job is removed for good (the row stays for the record). The owner sees your reason.", "remove");
        if(a==="warn") return ask("Warn the client", "Sends a message from you to the client's inbox about this job.", "warn");
        if(a==="suspend") return ask("Suspend account", "Bans the account and hides all their open jobs. Reversible from Users → Unban.", "suspend", 5);
        if(a==="verify") return openModal("Mark client verified", `<p class="muted" style="margin-bottom:10px">Only do this when you saw real proof (a provider check, a video call with an ID). The note stays in the moderation log.</p><label>What did you see?</label><input id="ajNote" maxlength="500"><button class="primary" id="ajGo" style="margin-top:14px">Mark verified</button>`, root=>{
          $("#ajGo",root).addEventListener("click",async()=>{ const n=$("#ajNote",root).value.trim(); if(n.length<5){ toast(t("a_fillAll")); return; } const { data, error } = await sb.rpc("admin_set_identity",{ p_user:j.owner, p_status:"verified", p_note:n }); closeModal(); if(error||data!=="ok"){ toast(errText(error,data)); return; } toast("Marked verified"); openAdmin(); }); });
      }));
    });
  }
