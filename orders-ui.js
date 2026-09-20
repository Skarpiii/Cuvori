  // =====================================================================
  // Orders — the Order is the contract.
  // Agree in chat → create the Order → both accept → client funds → work →
  // deliver / approve → money released. One record, one history, no PDF to sign.
  // The database table is still `contracts` (v4); every row is an Order.
  // =====================================================================
  const O_ACTIVE=["proposed","accepted","paid_marked","paid","funded","delivered","disputed","releasing","resolving"];
  const O_HOLDING=["funded","delivered","disputed","releasing","resolving"];
  const oMoney=(cents,cur)=>money((Number(cents)||0)/100,cur||"EUR");
  const oMoney2=(cents,cur)=>(cur==="EUR"||!cur?"€":escapeHtml(String(cur).slice(0,3))+" ")+((Number(cents)||0)/100).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});
  const oCents=o=>Number.isInteger(o.amount_cents)&&o.amount_cents>0?o.amount_cents:Math.round(Number(o.price||0)*100);
  const oFunded=o=>Number.isInteger(o.funded_cents)&&o.funded_cents>0?o.funded_cents:(O_HOLDING.includes(o.status)||o.status==="completed"?oCents(o):0);
  const oHeld=o=>Math.max(oFunded(o)-(o.released_cents||0)-(o.refunded_cents||0),0);
  const oLines=s=>String(s||"").split(/\n+/).map(x=>x.trim()).filter(Boolean);
  // has this side accepted the version on the table? (rows from before v18 carry no columns: the proposer had)
  function oAccepted(o, side){
    if(o.status!=="proposed") return true;
    if(o.client_accepted_version==null && o.freelancer_accepted_version==null) return (side==="client")===(o.proposed_by===o.client);
    const v=side==="client"?o.client_accepted_version:o.freelancer_accepted_version;
    return v===o.terms_version;
  }
  function oStatusKey(o, ms){
    ms=ms||[];
    switch(o.status){
      case "proposed": return !oAccepted(o,"client")?"o_stAwaitClient":"o_stAwaitFl";
      case "accepted": return isEscrow(o)?"o_stAwaitFunding":"o_stAwaitPayment";
      case "paid_marked": return "o_stPaidMarked";
      case "paid": return o.changes_open?"o_stChanges":(o.delivered_at||ms.some(m=>m.status==="submitted"))?"o_stAwaitApproval":"o_stInProgress";
      case "funded": return o.changes_open?"o_stChanges":ms.some(m=>m.status==="submitted")?"o_stAwaitApproval":"o_stInProgress";
      case "delivered": return "o_stAwaitApproval";
      case "disputed": return "o_stDisputed";
      case "releasing": case "resolving": return "o_stProcessing";
      case "completed": return "o_stCompleted";
      case "refunded": return "o_stRefunded";
      case "declined": return "o_stDeclined";
      case "cancelled": return "o_stCancelled";
    }
    return "o_stDraft";
  }
  const oStatusClass=k=>({o_stCompleted:"st-paid",o_stInProgress:"st-accepted",o_stAwaitApproval:"st-accepted",o_stAwaitFunding:"st-proposed",o_stAwaitPayment:"st-proposed",o_stAwaitClient:"st-proposed",o_stAwaitFl:"st-proposed",o_stChanges:"st-proposed",o_stDisputed:"st-disputed",o_stDeclined:"st-cancelled",o_stCancelled:"st-cancelled",o_stRefunded:"st-cancelled"}[k]||"st-accepted");
  function oStatusPill(o, ms){ const k=oStatusKey(o,ms); return `<span class="c-status ${oStatusClass(k)}">${escapeHtml(t(k))}</span>`; }

  // the price the client will pay, from the fee table in the database (never a number in the page)
  const O_QUOTES={};
  async function orderQuote(cents){
    const key=String(cents); if(O_QUOTES[key]) return O_QUOTES[key];
    if(!REAL) return { price_cents:cents, processing_cents:0, cuvori_cents:0, total_cents:cents };
    const { data } = await sb.rpc("order_quote",{ p_price_cents:cents, p_currency:"EUR", p_country:null, p_customer:"any", p_method:"card" });
    const q=data&&Number.isInteger(data.total_cents)?data:{ price_cents:cents, processing_cents:0, cuvori_cents:0, total_cents:cents };
    O_QUOTES[key]=q; return q;
  }
  function quoteHtml(q, cur){
    return `<div class="o-quote"><div><span>${t("o_priceLine")}</span><strong>${oMoney2(q.price_cents,cur)}</strong></div>
      <div><span>${t("o_processing")} <span class="muted small" title="${escapeHtml(t("o_processingHint"))}">ⓘ</span></span><strong>${oMoney2(q.processing_cents,cur)}</strong></div>
      <div><span>${t("o_cuvoriFee")}</span><strong>${oMoney2(0,cur)}</strong></div>
      <div class="o-total"><span>${t("o_total")}</span><strong>${oMoney2(q.total_cents,cur)}</strong></div>
      <div class="muted small" style="grid-column:1/-1">${escapeHtml(t("o_processingHint"))}</div></div>`;
  }

  async function activeOrderFor(conv){
    const { data } = await sb.from("contracts").select("*").eq("conversation_id",conv).in("status",O_ACTIVE).order("created_at",{ascending:false}).limit(1);
    return (data||[])[0]||null;
  }
  async function openOrderFlow(win){
    if(!requireAuth()) return;
    const o=await activeOrderFor(win.dataset.conv);
    if(o) openOrder(o.id); else orderForm(win.dataset.conv, win.dataset.person);
  }

  // ---------- who is the freelancer in this conversation, and what can be prefilled ----------
  async function orderParties(key, existing){
    const me=myId(), other=keyToId(key);
    if(existing) return { fl:existing.editor, cl:existing.client };
    let otherPro=false; try{ const { data } = await sb.rpc("is_editor",{ uid:other }); otherPro=!!data; }catch(e){}
    // the same rule as the database: the professional is the freelancer; two professionals → whoever creates the Order is hiring
    const fl=(isEditor() && !otherPro) ? me : other;
    return { fl, cl: fl===me?other:me };
  }
  function orderPrefill(key, fl){
    const pf=(state.orderPrefill||{})[key]||{};
    const p=PROFILES["u:"+fl]; const s=p&&p.services&&p.services[0];
    return { title:pf.title||"", scope:pf.scope||"", deadline:pf.deadline||"", profession_slug:pf.profession_slug||(s&&s.profession_slug)||(p&&p.professionSlug)||"",
             service_id:(s&&s.id)||"", price:pf.price!=null?pf.price:(s&&s.rate_unit==="project"&&s.rate_amount?Number(s.rate_amount):""), job_id:pf.job_id||"" };
  }

  // ---------- create / edit ----------
  function oMsRowHtml(m, i){
    return `<div class="o-ms-row" data-ms="${i}"><input class="o-ms-title" maxlength="120" placeholder="${escapeHtml(t("o_msTitle"))} ${i+1}" value="${escapeHtml(m.title||"")}"><input class="o-ms-amt" type="number" min="1" step="1" placeholder="${escapeHtml(t("o_msAmount"))}" value="${m.amount_cents?m.amount_cents/100:""}"><input class="o-ms-due" type="date" value="${escapeHtml(m.due||"")}"><button type="button" class="link-btn o-ms-x" aria-label="remove">×</button></div>`;
  }
  function orderForm(conv, key, existing){
    const other=displayOf(key); const editing=!!existing; const o=existing||{};
    const profs=(typeof visibleProfessions==="function"?[...visibleProfessions(), ...joinableProfessions().filter(p=>!visibleProfessions().some(x=>x.slug===p.slug))]:[]);
    openModal(editing?t("o_edit"):fill(t("o_newTitle"),{name:other}), `<div class="muted small">${t("o_loading")}</div>`, async root=>{
      const { fl, cl } = await orderParties(key, existing);
      const pf=editing?{ title:o.title, scope:o.description, deadline:o.deadline||"", profession_slug:o.profession_slug||"", service_id:o.service_id||"", price:oCents(o)/100, job_id:o.job_id||"" }:orderPrefill(key, fl);
      let ms=[]; if(editing && o.__milestones) ms=o.__milestones.map(m=>({title:m.title,amount_cents:m.amount_cents,due:m.due||""}));
      const revSel=v=>[1,2,3,5].map(n=>`<option value="${n}" ${String(v)===String(n)?"selected":""}>${n}</option>`).join("")+`<option value="50" ${String(v)==="50"?"selected":""}>${escapeHtml(t("o_revUnlimited"))}</option>`;
      $(".modal-body",root).innerHTML=`
        <p class="muted" style="margin-bottom:12px">${escapeHtml(t("o_newDesc"))}</p>
        <div class="form-grid">
          <div style="grid-column:1/-1"><label>${t("o_title")}</label><input id="oTitle" maxlength="200" placeholder="${escapeHtml(t("o_titlePh"))}" value="${escapeHtml(pf.title)}"></div>
          <div><label>${t("o_prof")}</label><select id="oProf"><option value="">—</option>${profs.map(p=>`<option value="${escapeHtml(p.slug)}" ${pf.profession_slug===p.slug?"selected":""}>${escapeHtml(pl(p.labels))}</option>`).join("")}</select></div>
          <div><label>${t("o_price")}</label><input id="oPrice" type="number" min="1" max="1000000" step="1" value="${escapeHtml(pf.price)}"><div class="muted small">${escapeHtml(t("o_priceHint"))}</div></div>
          <div style="grid-column:1/-1"><label>${t("o_scope")}</label><textarea id="oScope" maxlength="5000" style="min-height:90px" placeholder="${escapeHtml(t("o_scopePh"))}">${escapeHtml(pf.scope)}</textarea></div>
          <div style="grid-column:1/-1"><label>${t("o_deliverables")}</label><textarea id="oDeliv" maxlength="3000" style="min-height:70px" placeholder="${escapeHtml(t("o_delivPh"))}">${escapeHtml(o.deliverables||"")}</textarea></div>
          <div><label>${t("o_deadline")}</label><input id="oDeadline" type="date" value="${escapeHtml(pf.deadline)}"></div>
          <div><label>${t("o_revisions")}</label><select id="oRev">${revSel(o.revisions??2)}</select></div>
          <div><label>${t("o_clientDuties")}</label><textarea id="oCd" maxlength="2000" style="min-height:56px" placeholder="${escapeHtml(t("o_clientDutiesPh"))}">${escapeHtml(o.client_duties||"")}</textarea></div>
          <div><label>${t("o_flDuties")}</label><textarea id="oFd" maxlength="2000" style="min-height:56px">${escapeHtml(o.freelancer_duties||"")}</textarea></div>
          <div style="grid-column:1/-1"><label>${t("o_rights")}</label>
            <label class="ct-toggle"><input type="radio" name="oRights" value="full" ${(o.rights||"full")==="full"?"checked":""}> <span>${escapeHtml(t("o_rightsFull"))}</span></label>
            <label class="ct-toggle"><input type="radio" name="oRights" value="license" ${o.rights==="license"?"checked":""}> <span>${escapeHtml(t("o_rightsLicense"))}</span></label></div>
          <div style="grid-column:1/-1"><label class="switch-row" style="border:0;padding:6px 0"><span>${escapeHtml(t("o_milestones"))}</span><input type="checkbox" class="switch" id="oMsOn" ${ms.length?"checked":""}></label>
            <div id="oMsBox" class="${ms.length?"":"hidden"}"><div id="oMsList">${ms.map(oMsRowHtml).join("")}</div><button type="button" class="link-btn" id="oMsAdd">+ ${escapeHtml(t("o_msAdd"))}</button><div class="muted small" id="oMsHint"></div></div></div>
          <div style="grid-column:1/-1"><label>${t("o_custom")}</label><textarea id="oCustom" maxlength="5000" style="min-height:56px" placeholder="${escapeHtml(t("ct_customPh"))}">${escapeHtml((o.terms&&o.terms.custom)||"")}</textarea></div>
        </div>
        <details class="ct-details" style="margin-top:12px"><summary><strong>${t("o_stdTerms")}</strong> <span class="muted small">· ${escapeHtml(t("o_stdTermsHint"))}</span></summary><div id="oTermsPreview" class="ct-doc"></div></details>
        <div class="muted small" style="margin-top:10px">${ESCROW.enabled?escapeHtml(fill(t("es_proposeNote"),{n:ESCROW.days})):escapeHtml(t("o_directNote"))}</div>
        <button class="primary" id="oSend" style="margin-top:14px">${editing?t("o_saveChanges"):t("o_send")}</button>`;
      const q=s=>$(s,root);
      const readMs=()=>$$(".o-ms-row",root).map(r=>({ title:$(".o-ms-title",r).value.trim(), amount_cents:Math.round(Number($(".o-ms-amt",r).value||0)*100), due:$(".o-ms-due",r).value||null }));
      const collect=()=>{ const price=Math.round(Number(q("#oPrice").value||0)*100); const on=q("#oMsOn").checked; const list=on?readMs():[];
        return { title:q("#oTitle").value.trim(), scope:q("#oScope").value.trim(), deliverables:q("#oDeliv").value.trim(), price_cents:price, currency:"EUR", deadline:q("#oDeadline").value||null,
          revisions:Number(q("#oRev").value||2), client_duties:q("#oCd").value.trim(), freelancer_duties:q("#oFd").value.trim(), rights:(root.querySelector("input[name=oRights]:checked")||{}).value||"full",
          profession_slug:q("#oProf").value||null, service_id:pf.service_id||null, job_id:pf.job_id||null, custom:q("#oCustom").value.trim(), milestones:list,
          mode:(existing?existing.payment_mode:(ESCROW.enabled?"escrow":"direct")), language:state.language, law:(existing&&existing.law_country)||"DE" }; };
      const msHint=()=>{ const f=collect(); const h=q("#oMsHint"); if(!q("#oMsOn").checked){ h.textContent=""; return; } const sum=f.milestones.reduce((a,m)=>a+m.amount_cents,0);
        h.textContent=f.milestones.length===1?t("o_msNeedTwo"):sum!==f.price_cents?fill(t("o_msSum"),{total:oMoney(f.price_cents), sum:oMoney(sum)}):""; h.classList.toggle("danger-text",!!h.textContent); };
      const previewTerms=()=>{ const f=collect(); const row={ ...o, title:f.title||"—", description:f.scope, price:f.price_cents/100, pricing:"project", deadline:f.deadline, revisions:f.revisions, contract_type:"fixed", law_country:f.law, language:f.language,
          terms:{ on:{usage:f.rights==="full",cancel:true,liability:true,force:true,vat:true,materials:true,credit:true}, custom:f.custom, cancel_days:7, grace_days:7 }, payment_mode:f.mode, terms_version:(o.terms_version||0)+1, accepted_at:null, funded_at:null, terms_doc:null };
        q("#oTermsPreview").innerHTML=ctClauses(row,{editor:displayOf("u:"+fl),client:displayOf("u:"+cl)}).map((k,i)=>`<h4>${i+1}. ${escapeHtml(k.t)}</h4><p>${escapeHtml(k.b)}</p>`).join("")+`<p class="muted small">${escapeHtml(t("ct_notLegal"))}</p>`; };
      root.querySelector("details").addEventListener("toggle",previewTerms);
      q("#oMsOn").addEventListener("change",()=>{ q("#oMsBox").classList.toggle("hidden",!q("#oMsOn").checked); if(q("#oMsOn").checked && !$$(".o-ms-row",root).length){ q("#oMsList").insertAdjacentHTML("beforeend",oMsRowHtml({},0)+oMsRowHtml({},1)); } msHint(); });
      q("#oMsAdd").addEventListener("click",()=>{ const n=$$(".o-ms-row",root).length; if(n>=20) return; q("#oMsList").insertAdjacentHTML("beforeend",oMsRowHtml({},n)); msHint(); });
      root.addEventListener("input",msHint); root.addEventListener("click",e=>{ const x=e.target.closest(".o-ms-x"); if(x){ x.closest(".o-ms-row").remove(); msHint(); } });
      q("#oSend").addEventListener("click",async()=>{
        const f=collect();
        if(!f.title||!f.price_cents||f.price_cents<100){ toast(t("a_fillAll")); return; }
        if(f.milestones.length===1||(f.milestones.length&&f.milestones.reduce((a,m)=>a+m.amount_cents,0)!==f.price_cents)||f.milestones.some(m=>!m.title||m.amount_cents<=0)){ msHint(); toast(t("o_msFix")); return; }
        const btn=q("#oSend"); btn.disabled=true;
        try{
          if(editing){
            const { data, error } = await sb.rpc("order_update",{ p_order:o.id, p:f });
            if(error||data!=="ok"){ toast(errText(error,data)); return; }
            closeModal(); toast(fill(t("o_changed"),{name:other})); openOrder(o.id); refreshOrdersPage();
          } else {
            const { data, error } = await sb.rpc("order_create",{ p_conv:conv, p:f });
            if(error){ toast(errText(error)); console.error(error); return; }
            closeModal(); toast(fill(t("o_sent"),{name:other})); refreshOrdersPage(); if(state.orderPrefill) delete state.orderPrefill[key]; if(data) openOrder(data);
          }
        } finally { btn.disabled=false; }
      });
    }, "wide");
  }

  // ---------- chat cards: one line, click to open ----------
  const O_CARD_EVENTS={ proposed:"c_ev_proposed", accept:"c_ev_accept", client_accepted:"c_ev_client_accepted", freelancer_accepted:"c_ev_freelancer_accepted", decline:"c_ev_decline", cancel:"c_ev_cancel",
    mark_paid:"c_ev_mark_paid", confirm_paid:"c_ev_confirm_paid", complete:"c_ev_complete", funded:"c_ev_funded", deliver:"c_ev_deliver", request_changes:"c_ev_request_changes", dispute:"c_ev_dispute",
    approve:"c_ev_approve", auto_release:"c_ev_auto_release", resolved_release:"c_ev_resolved_release", resolved_refund:"c_ev_resolved_refund", resolved_split:"c_ev_resolved_split", terms_changed:"c_ev_terms_changed",
    milestone_submitted:"c_ev_milestone_submitted", milestone_approved:"c_ev_milestone_approved", amendment_proposed:"c_ev_amendment_proposed", amendment_accepted:"c_ev_amendment_accepted", amendment_declined:"c_ev_amendment_declined", cancel_refund:"c_ev_cancel_refund" };
  function contractCardHtml(m){
    const p=m.payload||{}; const mine=m.sender===myId();
    const cid=/^[0-9a-f-]{36}$/i.test(String(p.contract_id||""))?p.contract_id:"";
    const ev=O_CARD_EVENTS[p.event]?p.event:"proposed";
    const amt=Number.isInteger(p.amount_cents)?oMoney(p.amount_cents,p.currency):money(p.price,p.currency);
    const line=fill(t(O_CARD_EVENTS[ev]),{amt, label:escapeHtml(String(p.label||""))});
    return `<div class="contract-card ${mine?"mine":""}" data-cid="${cid}"><div class="cc-top"><span class="mini-tag">${t("o_order")}</span><strong>${escapeHtml(p.title||"")}</strong></div><div class="cc-line">${line}</div><div class="muted small">${t("c_openBtn")} →</div></div>`;
  }
  function bindContractCards(win){
    $$(".contract-card[data-cid]",win).forEach(c=>{ if(c.dataset.bound||!c.dataset.cid) return; c.dataset.bound="1"; c.addEventListener("click",()=>openOrder(c.dataset.cid)); });
  }

  // ---------- the Orders page: the list ----------
  async function refreshOrdersPage(){
    if(!REAL) return;
    const host=$("#contractsList"); if(!host) return;
    if(!signedIn()){ host.innerHTML=`<div class="empty-state small"><strong>${t("p_noContractsTitle")}</strong><p class="muted">${t("c_signInToSee")}</p></div>`; return; }
    const { data } = await sb.from("contracts").select("*").order("created_at",{ascending:false});
    const rows=data||[];
    const sc=$("[data-stat='contracts'] .stat-num, .stat[data-route='contracts'] .stat-num"); if(sc) sc.textContent=rows.filter(c=>O_ACTIVE.includes(c.status)).length;
    if(!rows.length){ host.innerHTML=`<div class="empty-state small"><strong>${t("p_noContractsTitle")}</strong><p class="muted">${t("c_howToStart")}</p></div>`; return; }
    for(const c of rows){ await ensurePerson(c.editor); await ensurePerson(c.client); }
    host.innerHTML=rows.map(c=>{ const other=c.editor===myId()?c.client:c.editor; return `<button class="c-row" data-cid="${c.id}"><span><strong>${escapeHtml(c.title)}</strong><span class="muted small"> · ${escapeHtml(displayOf("u:"+other))}</span><br><span class="muted small">${c.profession_slug?escapeHtml(profName(c.profession_slug))+" · ":""}${fmtDate(c.created_at)}</span></span><span class="c-right"><strong>${oMoney(oCents(c),c.currency)}</strong><br>${oStatusPill(c)}</span></button>`; }).join("");
    $$(".c-row",host).forEach(b=>b.addEventListener("click",()=>openOrder(b.dataset.cid)));
    if(typeof avAfterJobCheck==="function") avAfterJobCheck(rows);
  }
  const refreshContractsPage=refreshOrdersPage;

  // ---------- return from Stripe Checkout ----------
  async function handleContractsReturn(q){
    if(!q) return;
    const paid=q.get("paid"), cancelled=q.get("cancelled");
    if(cancelled){ toast(t("es_cancelled")); return; }
    if(!paid) return;
    toast(t("es_confirming"));
    for(let i=0;i<10;i++){ const { data:c } = await sb.from("contracts").select("status,funded_cents,amount_cents").eq("id",paid).maybeSingle(); if(c&&c.status!=="accepted"&&(c.funded_cents||0)>=(c.amount_cents||0)) break; await new Promise(r=>setTimeout(r,1500)); }
    refreshOrdersPage(); openOrder(paid);
  }

  // ---------- small modals ----------
  function oNoteModal(title, desc, ph, btnLabel, withLink, onSend){
    openModal(title, `<p class="muted" style="margin-bottom:10px">${escapeHtml(desc)}</p>${withLink?`<label>${t("es_deliverLink")}</label><input id="onUrl" maxlength="2000" placeholder="https://…"><label style="margin-top:10px">${t("es_deliverNote")}</label>`:""}<textarea id="onNote" maxlength="2000" style="min-height:90px" placeholder="${escapeHtml(ph)}"></textarea><button class="primary" id="onGo" style="margin-top:14px">${escapeHtml(btnLabel)}</button>`, root=>{
      $("#onGo",root).addEventListener("click",async()=>{ const note=$("#onNote",root).value.trim(); let link=null; if(withLink){ link=normUrl($("#onUrl",root).value); if(link===null){ toast(t("err_badLink")); return; } link=link||null; } $("#onGo",root).disabled=true; try{ await onSend(note, link); } finally { const b=$("#onGo",root); if(b) b.disabled=false; } });
    });
  }
  function oConfirmMoney(title, text, yes, onYes){
    openModal(title, `<p class="muted">${escapeHtml(text)}</p><div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap"><button class="primary" id="omGo">${escapeHtml(yes)}</button><button class="secondary" data-close-modal>${t("c_decline")}</button></div>`, root=>{
      $("#omGo",root).addEventListener("click",async()=>{ $("#omGo",root).disabled=true; try{ await onYes(); }catch(e){ toast(e.message||t("a_error")); $("#omGo",root).disabled=false; } });
    });
  }
  function amendForm(o, ms){
    const other=displayOf("u:"+(o.client===myId()?o.editor:o.client));
    openModal(t("o_amendTitle"), `<p class="muted" style="margin-bottom:10px">${escapeHtml(t("o_amendDesc"))}</p>
      <div class="form-grid">
        <div style="grid-column:1/-1"><label>${t("o_amendNote")}</label><textarea id="amNote" maxlength="2000" style="min-height:70px"></textarea></div>
        <div><label>${t("o_amendExtra")}</label><input id="amDelta" type="number" min="0" step="1" value="0"></div>
        <div><label>${t("o_amendDeadline")}</label><input id="amDeadline" type="date"></div>
        <div style="grid-column:1/-1"><label>${t("o_amendScope")}</label><textarea id="amScope" maxlength="3000" style="min-height:56px"></textarea></div>
        <div style="grid-column:1/-1"><label>${t("o_amendDeliv")}</label><textarea id="amDeliv" maxlength="2000" style="min-height:56px"></textarea></div>
        <div><label>${t("o_amendRev")}</label><input id="amRev" type="number" min="0" max="50" value="0"></div>
        ${o.has_milestones?`<div><label>${t("o_amendMs")}</label><input id="amMs" maxlength="120" placeholder="${escapeHtml(t("o_msTitle"))}"></div>`:""}
      </div>
      <button class="primary" id="amGo" style="margin-top:14px">${t("o_amendSend")}</button>`, root=>{
      $("#amGo",root).addEventListener("click",async()=>{
        const delta=Math.round(Number($("#amDelta",root).value||0)*100);
        const p={ note:$("#amNote",root).value.trim(), price_delta_cents:delta, new_deadline:$("#amDeadline",root).value||null, scope_add:$("#amScope",root).value.trim(), deliverables_add:$("#amDeliv",root).value.trim(), revisions_add:Number($("#amRev",root).value||0) };
        if(o.has_milestones && delta>0){ const title=($("#amMs",root)||{}).value||""; if(!title.trim()){ toast(t("a_fillAll")); return; } p.milestones=[{title:title.trim(), amount_cents:delta}]; }
        if(!p.note && !delta && !p.new_deadline && !p.scope_add && !p.deliverables_add && !p.revisions_add){ toast(t("a_fillAll")); return; }
        $("#amGo",root).disabled=true;
        const { data, error } = await sb.rpc("order_amend",{ p_order:o.id, p });
        if(error){ toast(errText(error)); $("#amGo",root).disabled=false; return; }
        closeModal(); toast(fill(t("o_amendSentToast"),{name:other})); openOrder(o.id);
      });
    });
  }

  // ---------- the Order screen ----------
  function oEventLine(e, o){
    const d=e.data||{}; const amt=oMoney(d.amount_cents??d.editor_cents??d.refund_cents??d.price_cents??0,o.currency);
    const key="o_ev_"+e.event; const txt=fill(t(key),{amt, label:d.title||d.label||"", n:d.version||d.n||"", note:d.note||""});
    return `<div class="o-ev"><span class="muted small">${fmtDate(e.at)}</span> <span>${escapeHtml(txt)}</span>${d.note?`<div class="muted small" style="white-space:pre-wrap">${escapeHtml(String(d.note).slice(0,300))}</div>`:""}</div>`;
  }
  async function openOrder(id){
    if(!requireAuth()) return;
    const { data:b } = await sb.rpc("order_bundle",{ p_order:id });
    if(!b||!b.order){ toast(t("a_error")); return; }
    const o=b.order, ms=b.milestones||[], ams=b.amendments||[], evs=b.events||[], pays=b.payments||[];
    const me=myId(); const iAmClient=o.client===me, iAmFl=o.editor===me; const esc=isEscrow(o); const cur=o.currency||"EUR";
    await ensurePerson(o.editor); await ensurePerson(o.client);
    const flName=b.freelancer_name||displayOf("u:"+o.editor), clName=b.client_name||displayOf("u:"+o.client); const names={editor:flName, client:clName};
    const otherName=iAmClient?flName:clName;
    const total=oCents(o), funded=oFunded(o), released=o.released_cents||0, held=oHeld(o), topup=Math.max(total-funded,0);
    const actions=[]; let hint="", moneyHtml="", extra="";
    const act=(key,cls,label,fn)=>actions.push([key,cls,label,fn]);
    const rpc=(a,note,link)=>async()=>{ const { data, error } = await sb.rpc("order_action",{ p_order:o.id, p_action:a, p_note:note||null, p_link:link||null }); if(error||data!=="ok"){ toast(errText(error,data)); return false; } return true; };
    const again=()=>{ openOrder(o.id); refreshOrdersPage(); };
    const releaseWhole=()=>oConfirmMoney(t("o_approve"), fill(t("o_releaseConfirm"),{amt:oMoney(held,cur),name:flName}), fill(t("o_releaseYes"),{amt:oMoney(held,cur)}), async()=>{ await fnCall("stripe-release",{ contract_id:o.id }); closeModal(); toast(t("es_released")); again(); });
    const releaseMs=m=>oConfirmMoney(fill(t("o_msApproveRelease"),{amt:oMoney(m.amount_cents,cur)}), fill(t("o_releaseConfirm"),{amt:oMoney(m.amount_cents,cur),name:flName}), fill(t("o_releaseYes"),{amt:oMoney(m.amount_cents,cur)}), async()=>{ await fnCall("stripe-release",{ contract_id:o.id, milestone_id:m.id }); closeModal(); toast(t("es_released")); again(); });

    // --- acceptance ---
    const accC=oAccepted(o,"client"), accF=oAccepted(o,"freelancer");
    const accRow=o.status==="proposed"?`<div class="o-acc"><span class="${accC?"ok":""}">${accC?"✓":"○"} ${escapeHtml(clName)} ${escapeHtml(accC?t("o_hasAccepted"):t("o_notYet"))}</span><span class="${accF?"ok":""}">${accF?"✓":"○"} ${escapeHtml(flName)} ${escapeHtml(accF?t("o_hasAccepted"):t("o_notYet"))}</span></div>`
      :(o.accepted_at&&!["declined","cancelled"].includes(o.status)?`<div class="o-acc"><span class="ok">✓ ${escapeHtml(fill(t("o_bothAccepted"),{d:fmtDate(o.accepted_at),n:o.accepted_version||o.terms_version||1}))}</span></div>`:"");
    if(o.status==="proposed"){
      const mine=iAmClient?accC:accF;
      if(!mine) act("accept","primary",t("o_accept"),async()=>{ if(await rpc("accept")()){ await ctFreezeDoc({...o, status:"accepted", accepted_at:new Date().toISOString()}, names).catch(()=>{}); toast(t("c_updated")); again(); } });
      else hint=fill(t("o_waitingOther"),{name:otherName});
      act("edit","secondary",t("o_edit"),()=>orderForm(o.conversation_id,"u:"+(iAmClient?o.editor:o.client),{...o, __milestones:ms}));
      if(!mine) act("decline","secondary",t("o_decline"),async()=>{ if(await rpc("decline")()){ toast(t("c_updated")); again(); } });
      act("cancel","secondary",t("o_cancel"),async()=>{ if(await rpc("cancel")()){ toast(t("c_updated")); again(); } });
    }

    // --- money ---
    if(esc){
      if(o.status==="accepted"){
        if(iAmClient){
          const q=await orderQuote(total); const { data:canPay } = await sb.rpc("editor_can_receive",{ ed:o.editor });
          moneyHtml=`<div class="pay-box"><strong>${t("o_fundTitle")}</strong>${quoteHtml(q,cur)}<div class="muted small" style="margin-top:6px">${escapeHtml(fill(t("o_fundedDesc"),{n:ESCROW.days}))}</div>${canPay?"":`<div class="notice" style="margin-top:8px">${escapeHtml(t("o_notReady"))}</div>`}</div>`;
          if(canPay) act("fund","primary",fill(t("o_fundBtn"),{amt:oMoney(q.total_cents,cur)}),async()=>{ try{ const j=await fnCall("stripe-checkout",{ contract_id:o.id }); if(j.url) location.href=j.url; }catch(e){ toast(e.message); } });
        } else {
          const ready=STRIPE_ME&&STRIPE_ME.payouts_enabled;
          moneyHtml=ready?`<div class="muted small">${escapeHtml(fill(t("o_waitingFunding"),{name:clName}))}</div>`:`<div class="notice">${t("es_connectFirst")} <button class="link-btn" data-set-open="payout">${t("pay_openSettings")}</button></div>`;
        }
        act("cancel","secondary",t("o_cancel"),async()=>{ if(await rpc("cancel")()){ toast(t("c_updated")); again(); } });
      }
      if(O_HOLDING.includes(o.status)||o.status==="completed"){
        moneyHtml=`<div class="pay-box"><div class="o-money"><div><span>${t("o_msProject")}</span><strong>${oMoney(total,cur)}</strong></div><div><span>${t("o_msSecured")}</span><strong>${oMoney(funded,cur)}</strong></div><div><span>${t("o_msReleased")}</span><strong>${oMoney(released,cur)}</strong></div><div><span>${t("o_msRemaining")}</span><strong>${oMoney(held,cur)}</strong></div>${o.refunded_cents?`<div><span>${t("o_stRefunded")}</span><strong>${oMoney(o.refunded_cents,cur)}</strong></div>`:""}</div>
          ${o.status!=="completed"&&o.status!=="refunded"?`<div class="muted small" style="margin-top:6px">${escapeHtml(iAmFl?fill(t("o_securedFl"),{amt:oMoney(held,cur)}):fill(t("o_secured"),{amt:oMoney(held,cur)}))} ${escapeHtml(t("o_cuvoriZero"))}</div>`:""}
          ${topup>0&&["funded","delivered"].includes(o.status)?`<div class="notice" style="margin-top:8px">${escapeHtml(fill(t("o_topupNeeded"),{amt:oMoney(topup,cur)}))}</div>`:""}</div>`;
        if(topup>0&&iAmClient&&["funded","delivered"].includes(o.status)) act("topup","primary",fill(t("o_topup"),{amt:oMoney(topup,cur)}),async()=>{ try{ const j=await fnCall("stripe-checkout",{ contract_id:o.id }); if(j.url) location.href=j.url; }catch(e){ toast(e.message); } });
      }
      if(o.status==="funded"){
        if(!o.has_milestones){
          if(iAmFl) act("deliver","primary",t("o_deliver"),()=>oNoteModal(t("o_deliver"), fill(t("es_deliverDesc"),{n:ESCROW.days}), "", t("es_deliverBtn"), true, async(note,link)=>{ if(await rpc("deliver",note,link)()){ closeModal(); toast(t("c_updated")); again(); } }));
          if(iAmClient) act("release","secondary",fill(t("o_approveRelease"),{amt:oMoney(held,cur)}),releaseWhole);
        }
        if(iAmFl) act("cancelRefund","secondary danger-text",t("o_cancelFunded"),()=>oConfirmMoney(t("o_cancelFunded"), fill(t("o_cancelFundedDesc"),{amt:oMoney(held,cur)}), t("o_cancelFunded"), async()=>{ await fnCall("stripe-cancel",{ contract_id:o.id }); closeModal(); toast(t("c_updated")); again(); }));
        act("dispute","secondary danger-text",t("es_openDispute"),()=>oNoteModal(t(iAmFl?"es_disputeTitleEd":"es_disputeTitleCl"), t(iAmFl?"es_disputeDescEd":"es_disputeDescCl"), t("es_disputePh"), t("es_disputeBtn"), false, async note=>{ if(!note){ toast(t("a_fillAll")); return; } if(await rpc("dispute",note)()){ closeModal(); toast(t("es_disputeSent")); again(); } }));
      }
      if(o.status==="delivered"){
        extra=`<div class="pay-box" style="margin-top:12px"><strong>${t("es_deliveredTitle")}</strong>${safeUrl(o.delivery_url)?`<div class="pay-line"><a href="${escapeHtml(safeUrl(o.delivery_url))}" target="_blank" rel="noopener noreferrer" class="link-btn">${escapeHtml(o.delivery_url)}</a></div>`:""}${o.delivery_note?`<div style="white-space:pre-wrap;margin-top:4px">${escapeHtml(o.delivery_note)}</div>`:""}${o.auto_release_at?`<div class="muted small" style="margin-top:6px">${escapeHtml(fill(t("es_autoRelease"),{d:fmtDate(o.auto_release_at)}))}</div>`:""}</div>`;
        if(iAmClient){ act("release","primary",fill(t("o_approveRelease"),{amt:oMoney(held,cur)}),releaseWhole); act("changes","secondary",t("o_requestChanges"),()=>oNoteModal(t("o_requestChanges"), t("es_changesDesc"), t("o_changesPh"), t("es_changesBtn"), false, async note=>{ if(!note){ toast(t("a_fillAll")); return; } if(await rpc("request_changes",note)()){ closeModal(); toast(t("c_updated")); again(); } })); act("dispute","secondary danger-text",t("es_openDispute"),()=>oNoteModal(t("es_disputeTitleCl"), t("es_disputeDescCl"), t("es_disputePh"), t("es_disputeBtn"), false, async note=>{ if(!note){ toast(t("a_fillAll")); return; } if(await rpc("dispute",note)()){ closeModal(); toast(t("es_disputeSent")); again(); } })); hint=t("es_clientDeliveredHint"); }
        if(iAmFl){ act("dispute","secondary danger-text",t("es_clientNotResponding"),()=>oNoteModal(t("es_disputeTitleEd"), t("es_disputeDescEd"), t("es_disputePh"), t("es_disputeBtn"), false, async note=>{ if(!note){ toast(t("a_fillAll")); return; } if(await rpc("dispute",note)()){ closeModal(); toast(t("es_disputeSent")); again(); } })); hint=fill(t("es_editorDeliveredHint"),{d:o.auto_release_at?fmtDate(o.auto_release_at):"—"}); }
      }
      if(o.status==="disputed"){ extra=`<div class="notice" style="margin-top:12px"><strong>${t("es_disputeBy")} ${escapeHtml(o.dispute_by===o.editor?flName:clName)}</strong><div style="white-space:pre-wrap;margin-top:4px">${escapeHtml(o.dispute_reason||"")}</div></div>`; hint=t("es_disputeHint"); }
      if(o.status==="releasing"||o.status==="resolving") hint=o.money_error?t("es_settling"):t("es_processing");
      if(o.status==="completed"&&["release","split","refund"].includes(o.resolution)) hint=t("es_done_"+o.resolution);
      if(o.status==="completed"&&released>0) hint=(hint?hint+" ":"")+t(iAmFl?"es_payoutTimingFl":"es_payoutTiming");
      if(o.status==="refunded") hint=o.resolution==="chargeback"?t("es_chargebackLost"):t("es_refundedHint");
      if(o.chargeback_status==="open") extra=`<div class="notice danger" style="margin-top:12px"><strong>${escapeHtml(t("es_chargebackOpen"))}</strong></div>`+(extra||"");
      else if(o.chargeback_status==="won") extra=`<div class="notice" style="margin-top:12px">${escapeHtml(t("es_chargebackWon"))}</div>`+(extra||"");
    } else {
      // direct payments: nothing is held by anyone; both confirm what happened outside Cuvori
      if(["accepted","paid_marked","paid"].includes(o.status)){
        let pay="";
        if(iAmClient){ const { data:info } = await sb.rpc("payout_info",{ ed:o.editor }); pay=payoutInfoHtml(info); }
        else if(iAmFl){ const { data:info } = await sb.rpc("payout_info",{ ed:me }); pay=(info&&info.methods&&info.methods.length)?`<div class="muted small">${t("pay_clientSees")}</div>`:`<div class="notice">${t("pay_addYours")} <button class="link-btn" data-set-open="payout">${t("pay_openSettings")}</button></div>`; }
        moneyHtml=`<div class="pay-box"><strong>${t("o_directTitle")}</strong><div class="muted small" style="margin:4px 0 8px">${escapeHtml(t("o_directDesc"))}</div><div class="o-quote"><div><span>${t("o_priceLine")}</span><strong>${oMoney2(total,cur)}</strong></div><div><span>${t("o_cuvoriFee")}</span><strong>${oMoney2(0,cur)}</strong></div></div>${pay}</div>`;
        if(o.status==="accepted"&&iAmClient) act("mark_paid","primary",t("c_markPaid"),async()=>{ if(await rpc("mark_paid")()){ toast(t("c_updated")); again(); } });
        if((o.status==="accepted"||o.status==="paid_marked")&&iAmFl) act("confirm_paid","primary",t("c_confirmPaid"),async()=>{ if(await rpc("confirm_paid")()){ toast(t("c_updated")); again(); } });
        if(o.status!=="paid") act("cancel","secondary",t("o_cancel"),async()=>{ if(await rpc("cancel")()){ toast(t("c_updated")); again(); } });
        if(o.status==="paid"){
          if(!o.has_milestones){
            if(iAmFl) act("deliver","primary",t("o_deliver"),()=>oNoteModal(t("o_deliver"), t("o_deliverDirectDesc"), "", t("es_deliverBtn"), true, async(note,link)=>{ if(await rpc("deliver",note,link)()){ closeModal(); toast(t("c_updated")); again(); } }));
            if(iAmClient&&o.delivered_at){ act("complete","primary",t("o_approve"),async()=>{ if(await rpc("complete")()){ toast(t("c_updated")); again(); } }); act("changes","secondary",t("o_requestChanges"),()=>oNoteModal(t("o_requestChanges"), t("es_changesDesc"), t("o_changesPh"), t("es_changesBtn"), false, async note=>{ if(!note){ toast(t("a_fillAll")); return; } if(await rpc("request_changes",note)()){ closeModal(); toast(t("c_updated")); again(); } })); }
          } else if(iAmClient && ms.length && ms.every(m=>["approved","released"].includes(m.status))) act("complete","primary",t("o_approve"),async()=>{ if(await rpc("complete")()){ toast(t("c_updated")); again(); } });
          if(o.delivered_at&&!o.has_milestones) extra=`<div class="pay-box" style="margin-top:12px"><strong>${t("es_deliveredTitle")}</strong>${safeUrl(o.delivery_url)?`<div class="pay-line"><a href="${escapeHtml(safeUrl(o.delivery_url))}" target="_blank" rel="noopener noreferrer" class="link-btn">${escapeHtml(o.delivery_url)}</a></div>`:""}${o.delivery_note?`<div style="white-space:pre-wrap;margin-top:4px">${escapeHtml(o.delivery_note)}</div>`:""}</div>`;
        }
        if(o.status==="accepted"&&iAmFl) hint=t("c_waitingPayment"); else if(o.status==="paid_marked"&&iAmClient) hint=t("c_waitingConfirm"); else if(o.status==="paid"&&!o.delivered_at) hint=t("o_paidHint");
      }
    }

    // --- milestones ---
    let msHtml="";
    if(ms.length){
      const canWork=(esc&&o.status==="funded")||(!esc&&o.status==="paid");
      msHtml=`<div class="o-ms"><strong>${t("o_milestonesTitle")}</strong>${ms.map((m,i)=>{
        const st=t("o_msSt_"+m.status); const btns=[];
        if(canWork&&iAmFl&&m.status==="pending") btns.push(`<button class="small-btn" data-msact="submit" data-ms="${m.id}">${t("o_msSubmit")}</button>`);
        if(canWork&&iAmClient&&m.status==="submitted"){ btns.push(esc?`<button class="small-btn primary" data-msact="release" data-ms="${m.id}">${fill(t("o_msApproveRelease"),{amt:oMoney(m.amount_cents,cur)})}</button>`:`<button class="small-btn primary" data-msact="approve" data-ms="${m.id}">${t("o_msApprove")}</button>`); btns.push(`<button class="small-btn" data-msact="changes" data-ms="${m.id}">${t("o_requestChanges")}</button>`); }
        return `<div class="o-ms-item"><div><strong>${i+1}. ${escapeHtml(m.title)}</strong> <span class="muted small">${m.due?"· "+fmtDate(m.due):""}</span><div class="muted small">${escapeHtml(st)}${m.status==="submitted"&&iAmFl?" · "+escapeHtml(fill(t("o_msWaiting"),{name:clName})):""}${m.status==="submitted"&&safeUrl(m.delivery_url)?` · <a href="${escapeHtml(safeUrl(m.delivery_url))}" target="_blank" rel="noopener noreferrer" class="link-btn">${escapeHtml(t("es_deliveredTitle"))}</a>`:""}${m.status==="submitted"&&m.auto_release_at?" · "+escapeHtml(fill(t("es_autoRelease"),{d:fmtDate(m.auto_release_at)})):""}</div>${m.delivery_note&&m.status==="submitted"?`<div class="small" style="white-space:pre-wrap">${escapeHtml(m.delivery_note)}</div>`:""}</div><div class="o-ms-right"><strong>${oMoney(m.amount_cents,cur)}</strong><div>${btns.join(" ")}</div></div></div>`; }).join("")}</div>`;
    }

    // --- amendments ---
    const open=ams.find(a=>a.status==="proposed"); let amHtml="";
    const amLine=a=>[a.price_delta_cents?fill(t("o_amendExtraLine"),{amt:oMoney(a.price_delta_cents,cur)}):"", a.new_deadline?fill(t("o_amendDeadlineLine"),{d:fmtDate(a.new_deadline)}):"", a.revisions_add?fill(t("o_amendRevLine"),{n:a.revisions_add}):"", a.scope_add?t("o_amendScope")+": "+a.scope_add:"", a.deliverables_add?t("o_amendDeliv")+": "+a.deliverables_add:""].filter(Boolean).join(" · ");
    if(open){ const byMe=open.proposed_by===me; amHtml=`<div class="notice" style="margin-top:12px"><strong>${escapeHtml(fill(t("o_amendPending"),{name:byMe?t("youLabel"):otherName}))}</strong><div style="white-space:pre-wrap;margin-top:4px">${escapeHtml(open.note||"")}</div><div class="muted small" style="margin-top:4px">${escapeHtml(amLine(open))}</div><div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap">${byMe?`<button class="small-btn" data-amact="withdraw">${t("o_amendWithdraw")}</button>`:`<button class="small-btn primary" data-amact="accept">${t("o_amendAccept")}</button><button class="small-btn" data-amact="decline">${t("o_amendDecline")}</button>`}</div></div>`; }
    const accepted=ams.filter(a=>a.status==="accepted");
    if(accepted.length) amHtml+=`<div class="muted small" style="margin-top:8px">${accepted.map((a,i)=>`✓ ${escapeHtml(fill(t("o_amendAccepted"),{n:i+1,d:fmtDate(a.decided_at)}))} — ${escapeHtml(a.note||amLine(a))}`).join("<br>")}</div>`;
    if(!open && ["accepted","paid_marked","paid","funded","delivered"].includes(o.status)) act("amend","secondary",t("o_amend"),()=>amendForm(o, ms));

    // --- the terms as accepted, and the printable copy ---
    const termsHtml=`<details class="ct-details" style="margin-top:12px"><summary><strong>${t("o_stdTerms")}</strong> <span class="muted small">· ${escapeHtml(fill(t("ct_version"),{n:o.terms_version||1}))} · ${escapeHtml(countryName(ctLawOf(o),state.language))}</span></summary>${ctDocHtml(o,names)}</details>`;
    if(!["proposed","declined","cancelled"].includes(o.status)) act("pdf","secondary",t("o_pdf"),()=>ctPrint(o,names));
    const histHtml=evs.length?`<details class="ct-details" style="margin-top:8px"><summary><strong>${t("o_history")}</strong> <span class="muted small">· ${evs.length}</span></summary><div class="ct-doc">${evs.map(e=>oEventLine(e,o)).join("")}</div></details>`:"";

    const facts=[[t("o_deadline"),o.deadline?fmtDate(o.deadline):"—"],[t("o_revisions"),o.revisions>=50?t("o_revUnlimited"):String(o.revisions??0)+(o.changes_used?` (${fill(t("o_changesLeft"),{n:o.changes_used,m:o.revisions})})`:"")],[t("o_rights"),t(o.rights==="license"?"o_rightsLicense":"o_rightsFull")]];
    openModal(t("o_order"), `
      <div class="c-head"><div>${oStatusPill(o,ms)} <span class="muted small">· ${escapeHtml(fill(t("ct_version"),{n:o.terms_version||1}))}${esc?` · <span class="mini-tag">${t("es_badge")}</span>`:""}</span><h3 style="margin:4px 0 0">${escapeHtml(o.title)}</h3><div class="muted small">${escapeHtml(clName)} → ${escapeHtml(flName)}${o.profession_slug?" · "+escapeHtml(profName(o.profession_slug)):""} · ${fmtDate(o.created_at)}</div></div><div style="font-size:24px;font-weight:900;white-space:nowrap">${oMoney(total,cur)}</div></div>
      ${accRow}
      ${moneyHtml?`<div style="margin-top:12px">${moneyHtml}</div>`:""}${extra}${msHtml}${amHtml}
      <div class="o-grid">
        <div><strong>${t("o_scope")}</strong><div class="o-text">${oLines(o.description).length?oLines(o.description).map(x=>`<div>• ${escapeHtml(x)}</div>`).join(""):"—"}</div></div>
        <div><strong>${t("o_deliverables")}</strong><div class="o-text">${oLines(o.deliverables).length?oLines(o.deliverables).map(x=>`<div>• ${escapeHtml(x)}</div>`).join(""):"—"}</div></div>
        ${o.client_duties?`<div><strong>${t("o_clientDutiesShort")}</strong><div class="o-text">${oLines(o.client_duties).map(x=>`<div>• ${escapeHtml(x)}</div>`).join("")}</div></div>`:""}
        ${o.freelancer_duties?`<div><strong>${t("o_flDutiesShort")}</strong><div class="o-text">${oLines(o.freelancer_duties).map(x=>`<div>• ${escapeHtml(x)}</div>`).join("")}</div></div>`:""}
        <div class="fact-list">${facts.map(([k,v])=>`<div><span class="muted small">${escapeHtml(k)}</span><br>${escapeHtml(v)}</div>`).join("")}</div>
      </div>
      ${termsHtml}${histHtml}
      ${hint?`<div class="muted small" style="margin-top:10px">${hint}</div>`:""}
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:14px">${actions.map(([a,cls,l])=>`<button class="${cls}" data-caction="${a}">${l}</button>`).join("")}</div>`, root=>{
        actions.forEach(([a,cls,l,fn])=>{ const btn=root.querySelector(`[data-caction="${a}"]`); if(btn) btn.addEventListener("click",async()=>{ btn.disabled=true; try{ await fn(); }finally{ btn.disabled=false; } }); });
        $("[data-set-open]",root)?.addEventListener("click",()=>{ closeModal(); route("settings"); setTimeout(()=>$(".snav[data-set='payout']")?.click(),50); });
        $$("[data-msact]",root).forEach(btn=>btn.addEventListener("click",async()=>{ const m=ms.find(x=>x.id===btn.dataset.ms); if(!m) return; const a=btn.dataset.msact;
          if(a==="release") return releaseMs(m);
          if(a==="submit") return oNoteModal(t("o_msSubmit")+" · "+m.title, fill(t("o_msSubmitDesc"),{n:ESCROW.days}), "", t("o_msSubmit"), true, async(note,link)=>{ const { data, error } = await sb.rpc("order_milestone_action",{ p_ms:m.id, p_action:"submit", p_note:note||null, p_link:link||null }); if(error||data!=="ok"){ toast(errText(error,data)); return; } closeModal(); toast(t("c_updated")); again(); });
          if(a==="changes") return oNoteModal(t("o_requestChanges")+" · "+m.title, t("es_changesDesc"), t("o_changesPh"), t("es_changesBtn"), false, async note=>{ if(!note){ toast(t("a_fillAll")); return; } const { data, error } = await sb.rpc("order_milestone_action",{ p_ms:m.id, p_action:"request_changes", p_note:note }); if(error||data!=="ok"){ toast(errText(error,data)); return; } closeModal(); toast(t("c_updated")); again(); });
          if(a==="approve"){ const { data, error } = await sb.rpc("order_milestone_action",{ p_ms:m.id, p_action:"approve" }); if(error||data!=="ok"){ toast(errText(error,data)); return; } toast(t("c_updated")); again(); }
        }));
        $$("[data-amact]",root).forEach(btn=>btn.addEventListener("click",async()=>{ const a=btn.dataset.amact; btn.disabled=true; const { data, error } = await sb.rpc("order_amendment_decide",{ p_amend:open.id, p_accept:a==="accept" }); if(error||data!=="ok"){ toast(errText(error,data)); btn.disabled=false; return; } toast(t("c_updated")); again(); }));
      }, "wide");
  }
  const contractModal=openOrder;

  // ---------- progress reports know their Order ----------
  async function orderForReport(convId){ try{ return await activeOrderFor(convId); }catch(e){ return null; } }

  function initOrders(){
    document.addEventListener("click",e=>{ const b=e.target.closest(".open-contract"); if(b){ const win=b.closest(".chat-window"); if(win) openOrderFlow(win); } });
    state.orderPrefill=state.orderPrefill||{};
  }
