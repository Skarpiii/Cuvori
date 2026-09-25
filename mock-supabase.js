// In-memory Supabase mock injected before page scripts (test only).
(() => {
  function validateContract(a){ const ct=a.ctype||"fixed", pr=a.pricing||"project"; if(!a.title||a.title.length>200) return "bad_title"; if(!(a.price>=0&&a.price<=1000000)) return "bad_price"; if(!["fixed","hourly","retainer","quick"].includes(ct)) return "bad_type"; if((["fixed","quick"].includes(ct)&&pr!=="project")||(ct==="hourly"&&!["hour","day"].includes(pr))||(ct==="retainer"&&pr!=="month")) return "bad_pricing"; if(a.mode==="escrow"&&pr!=="project") return "escrow_fixed_price_only"; if(a.law&&!/^[A-Z]{2}$/.test(a.law)) return "bad_country"; if(a.lang&&!["en","de","ru","lt","es","pl","uk"].includes(a.lang)) return "bad_language"; const t=a.terms||{}; if(JSON.stringify(t).length>20000||(t.custom||"").length>5000) return "bad_terms"; if(t.late_pct!=null&&!(t.late_pct>=0&&t.late_pct<=5)) return "bad_terms"; if(t.deposit_pct!=null&&!(t.deposit_pct>=0&&t.deposit_pct<=100)) return "bad_terms"; if(t.grace_days!=null&&!(t.grace_days>=0&&t.grace_days<=60)) return "bad_terms"; for(const k of Object.keys(t)) if(!["on","custom","included","cancel_days","late_pct","pay_days","hours","cap","months","grace_days","deposit_pct"].includes(k)) return "bad_terms"; return null; }

  // ---------- professions (mirrors schema_v15 / v16) ----------
  // the page defines window.CUVORI_PROFESSIONS after this mock is injected, so read it lazily
  let _PCFG=null; const pcfg=()=>_PCFG||(_PCFG=JSON.parse(JSON.stringify(window.CUVORI_PROFESSIONS || {professions:[],filters:[],profession_filters:[],units:{},groups:[]})));
  const pfDef = k => pcfg().filters.find(f=>f.key===k);
  const pfAttached = (slug,k) => pcfg().profession_filters.some(x=>x.profession_slug===slug && x.filter_key===k);
  function serviceValuesError(slug, v){
    if(!v || typeof v!=="object" || Array.isArray(v)) return "values_not_object";
    for(const [k,val] of Object.entries(v)){
      const d=pfDef(k); if(!d || !pfAttached(slug,k)) return "unknown_field:"+k;
      if(["price","languages","location","availability"].includes(d.kind)) return "not_a_value:"+k;
      if(d.kind==="multi"||d.kind==="tags"){ if(!Array.isArray(val)) return "not_a_list:"+k; if(val.length>30) return "too_many:"+k;
        let cn=0; for(const e of val){ if(typeof e!=="string") return "bad_item:"+k;
          if(d.kind==="multi" && !d.options.some(o=>o.key===e)){ if(!d.allow_custom) return "unknown_option:"+k+"="+e; cn++; if(cn>10) return "too_many_custom:"+k; if(e.length>40||!e.trim()||/[<>]/.test(e)) return "bad_custom:"+k; }
          if(d.kind==="tags" && (e.length>40||/[<>]/.test(e))) return "bad_tag:"+k; } }
      else if(d.kind==="single"){ if(typeof val!=="string") return "not_text:"+k; if(!d.options.some(o=>o.key===val)) return "unknown_option:"+k; }
      else if(d.kind==="bool"){ if(typeof val!=="boolean") return "not_boolean:"+k; }
      else if(d.kind==="range"){ if(typeof val!=="number") return "not_number:"+k; if((d.min_value!=null&&val<d.min_value)||(d.max_value!=null&&val>d.max_value)) return "out_of_range:"+k; }
    }
    return null;
  }
  function serviceGuard(row, isInsert){
    const p=pcfg().professions.find(x=>x.slug===row.profession_slug); if(!p) throw new Error("unknown_profession");
    const meP=db.profiles.find(x=>x.id===row.profile_id);
    if(isInsert && !p.active && !(meP&&meP.is_admin)) throw new Error("profession_not_open");
    row.rate_unit=row.rate_unit||"hour"; if(!p.pricing_units.includes(row.rate_unit)) throw new Error("bad_unit");
    if(row.rate_amount!=null && (row.rate_amount<0||row.rate_amount>100000)) throw new Error("bad_price");
    row.headline=row.headline||""; if(row.headline.length>120||/[<>]/.test(row.headline)) throw new Error("bad_headline");
    row.values=row.values||{}; const err=serviceValuesError(row.profession_slug,row.values); if(err) throw new Error(err);
    if(row.is_public==null) row.is_public=true; if(row.sort_order==null) row.sort_order=0; row.updated_at=new Date().toISOString();
  }
  function serviceMirror(profile_id){
    const list=db.services.filter(x=>x.profile_id===profile_id).sort((a,b)=>(a.sort_order-b.sort_order)); const s=list[0]; if(!s) return;
    const e=db.editor_profiles.find(x=>x.id===profile_id); if(!e) return;
    const swDef=pfDef("software"); const sw=(s.values.software||[]).map(k=>{ const o=(swDef&&swDef.options||[]).find(x=>x.key===k); return o?o.labels.en:k; });
    const vsDef=pfDef("video_skills"); const vs=(s.values.video_skills||[]).map(k=>{ const o=(vsDef&&vsDef.options||[]).find(x=>x.key===k); return o?o.labels.en:k; });
    const sk=[...vs, ...(s.values.skills||[])]; const spec=(s.values.video_specialty||[]);
    e.rate_amount=s.rate_amount; if(["hour","project","day"].includes(s.rate_unit)) e.rate_unit=s.rate_unit;
    if(list.length===1) e.role_label = s.profession_slug==="videographer"?"videographer":s.profession_slug==="photographer"?"photographer":"editor";
    if(spec.length) e.specializations=spec; if(sw.length+sk.length) e.tools=[...sw,...sk].slice(0,60);
    if(s.values.turnaround_days) e.turnaround_days=s.values.turnaround_days;
  }
  // a legacy save of editor_profiles (no service yet) gets a service, as the v15 migration does
  function migrateEditor(e){
    if(db.services.some(x=>x.profile_id===e.id)) return;
    const map={editor:[["video-editor",0]],videographer:[["videographer",0]],photographer:[["photographer",0]],editor_photographer:[["video-editor",0],["photographer",1]]};
    for(const [slug,ord] of (map[e.role_label]||map.editor)){
      const p=pcfg().professions.find(x=>x.slug===slug); const v={};
      if(slug!=="photographer"){ const spec=(e.specializations||[]).filter(k=>(pfDef("video_specialty").options).some(o=>o.key===k)); if(spec.length) v.video_specialty=spec;
        const sw=(e.tools||[]).map(t0=>(pfDef("software").options.find(o=>o.labels.en.toLowerCase()===String(t0).toLowerCase())||{}).key).filter(Boolean); if(sw.length) v.software=sw;
        const vs=(e.tools||[]).map(t0=>(pfDef("video_skills").options.find(o=>o.labels.en.toLowerCase()===String(t0).toLowerCase())||{}).key).filter(Boolean); if(vs.length) v.video_skills=vs;
        v.turnaround_days=Math.min(60,Math.max(1,e.turnaround_days||7)); }
      else { const m={catWedding:"wedding",catRealEstate:"real_estate",catCorporate:"corporate",catTravel:"travel",catCommercial:"product"}; const st=(e.specializations||[]).map(k=>m[k]).filter(Boolean); if(st.length) v.shoot_type=st; v.delivery_days=Math.min(60,Math.max(1,e.turnaround_days||7)); }
      const known=new Set([...pfDef("software").options.map(o=>o.labels.en.toLowerCase()),...pfDef("video_skills").options.map(o=>o.labels.en.toLowerCase())]);
      const left=(e.tools||[]).filter(t0=>!known.has(String(t0).toLowerCase())).slice(0,30).map(t0=>String(t0).slice(0,40)); if(left.length) v.skills=left;
      db.services.push({ id:uuid(), profile_id:e.id, profession_slug:slug, rate_amount:e.rate_amount??null, rate_unit:p.pricing_units.includes(e.rate_unit)?e.rate_unit:p.pricing_units[0], currency:"EUR", headline:"", values:v, is_public:true, sort_order:ord, created_at:new Date().toISOString(), updated_at:new Date().toISOString() });
    }
  }
  const listed = id => { const p=db.profiles.find(x=>x.id===id); return !!(p && !p.banned && (p.visibility||"public")==="public"); };
  function editorIsOpen(e){ const set=e.availability_set_at?new Date(e.availability_set_at):null; if(set && (Date.now()-set)/864e5>30) return false; if(e.availability==="closed") return false; if(e.availability==="busy"){ if(!e.free_from) return false; return new Date(e.free_from)<=new Date(); } return true; }
  function searchProfessionals(a){
    const f=a.p_filters||{}; const q=(a.p_q||"").toLowerCase(); const out=[];
    for(const s of db.services){
      const e=db.editor_profiles.find(x=>x.id===s.profile_id); const pr=db.profiles.find(x=>x.id===s.profile_id); const p=pcfg().professions.find(x=>x.slug===s.profession_slug);
      if(!e||!pr||!p||!s.is_public||!e.is_public||pr.banned||(pr.visibility||"public")!=="public"||!p.active) continue;
      if(a.p_profession && s.profession_slug!==a.p_profession) continue;
      if(f.price){ if(f.price.min!=null && !(s.rate_amount>=f.price.min)) continue; if(f.price.max!=null && !(s.rate_amount<=f.price.max)) continue; if(f.price.unit && s.rate_unit!==f.price.unit) continue; }
      if(f.languages && f.languages.length && !f.languages.every(l=>(e.languages||[]).includes(l))) continue;
      if(f.location){ if(f.location.country && !String(e.country||"").toLowerCase().includes(f.location.country.toLowerCase())) continue; if(f.location.city && !String(e.city||"").toLowerCase().includes(f.location.city.toLowerCase())) continue; }
      if(f.availability==="open" && !editorIsOpen(e)) continue;
      let ok=true;
      for(const [k,v] of Object.entries(f)){ if(["price","languages","location","availability"].includes(k)) continue; const d=pfDef(k); if(!d) continue; const sv=s.values[k];
        let m=false;
        if(d.kind==="multi") m = !Array.isArray(v)||!v.length ? true : (d.match==="all" ? v.every(x=>(sv||[]).includes(x)) : v.some(x=>(sv||[]).includes(x)));
        else if(d.kind==="single") m = sv===v;
        else if(d.kind==="bool") m = v!==true || sv===true;
        else if(d.kind==="range") m = sv!=null && (v.min==null||sv>=v.min) && (v.max==null||sv<=v.max);
        else if(d.kind==="tags") m = Array.isArray(v) && v.some(x=>(sv||[]).some(t0=>t0.toLowerCase().includes(String(x).toLowerCase())));
        else m=true;
        if(!m){ ok=false; break; } }
      if(!ok) continue;
      if(q){ const blob=[e.display_name,e.city,e.country,(e.languages||[]).join(" "),s.headline,(e.tools||[]).join(" "),JSON.stringify(s.values),e.bio,...db.projects.filter(x=>x.owner===e.id).map(x=>x.title+" "+(x.tags||[]).join(" "))].join(" ").toLowerCase(); if(!blob.includes(q)) continue; }
      const rv=db.reviews.filter(r=>r.editor===e.id && listed(r.client));
      out.push({ service_id:s.id, profile_id:e.id, profession_slug:s.profession_slug, rate_amount:s.rate_amount, rate_unit:s.rate_unit, headline:s.headline, values:s.values,
        display_name:e.display_name, role_label:e.role_label, city:e.city, country:e.country, languages:e.languages||[], bio:e.bio, tools:e.tools||[], specializations:e.specializations||[], credentials:e.credentials||[],
        responds_hours:e.responds_hours, turnaround_days:e.turnaround_days, revisions:e.revisions, availability:e.availability, free_from:e.free_from, availability_set_at:e.availability_set_at, last_active_on:e.last_active_on,
        is_public:e.is_public, created_at:e.created_at, rating: rv.length? +(rv.reduce((x,r)=>x+r.stars,0)/rv.length).toFixed(1):null, review_count:rv.length, _open:editorIsOpen(e) });
    }
    out.sort((x,y)=>(x._open===y._open?0:(x._open?-1:1)) || ((y.rating||0)-(x.rating||0)) || (y.review_count-x.review_count) || String(x.created_at).localeCompare(String(y.created_at)));
    const total=out.length; const lim=Math.max(1,Math.min(a.p_limit||60,200)), off=Math.max(0,a.p_offset||0);
    return out.slice(off,off+lim).map(r=>{ const c={...r, total_count:total}; delete c._open; return c; });
  }
  function professionConfig(){
    const cfg=JSON.parse(JSON.stringify(pcfg()));
    cfg.professions.forEach(p=>{ p.professional_count=db.services.filter(s=>s.profession_slug===p.slug && s.is_public && (db.editor_profiles.find(e=>e.id===s.profile_id)||{}).is_public && listed(s.profile_id)).length; });
    return cfg;
  }
  const db = { profiles:[], editor_profiles:[], projects:[], jobs:[], conversations:[], messages:[], reviews:[], invites:[], contracts:[], payout_details:[], user_flags:[], user_identifiers:[], deleted_user_identifiers:[], reports:[], services:[], order_milestones:[], order_amendments:[], order_events:[], order_payments:[], order_reviews:[], fee_schedules:[{id:1,provider:"stripe",region:"EEA",country:null,customer_kind:"any",method:"any",percent:1.5,fixed_cents:25,currency:"EUR",payer:"client",active:true,note:"Stripe: standard European cards"},{id:2,provider:"stripe",region:"INTL",country:null,customer_kind:"any",method:"any",percent:3.25,fixed_cents:25,currency:"EUR",payer:"client",active:true,note:"non-European cards"},{id:3,provider:"stripe",region:"ANY",country:null,customer_kind:"any",method:"any",percent:1.5,fixed_cents:25,currency:"EUR",payer:"client",active:true,note:"country unknown"}] };
  const rvDays = () => (window.__MOCK_REVIEW_DAYS||14);
  const rvOpens = (c) => new Date(c.completed_at||c.closed_at||c.created_at||Date.now()).getTime();
  const rvDue = (c) => rvOpens(c) + rvDays()*86400000;
  const rvPublic = (r) => r.moderation_status==="visible" && (r.is_revealed || Date.now() > new Date(r.reveal_due).getTime());
  const users = {}; let session = null; const listeners = []; const invites = {"CUV-2026-EDIT":null,"CUV-MAYA-0001":null};
  const channels = [];
  const norm=v=>String(v||"").toLowerCase().replace(/[\s\-\.]/g,"");
  const recId=(uid,kind,value,label)=>{ if(!uid||!value||norm(value).length<4) return; const h="h:"+norm(value); if(!db.user_identifiers.some(i=>i.user_id===uid&&i.kind===kind&&i.value_hash===h)) db.user_identifiers.push({user_id:uid,kind,value_hash:h,label:label||"",created_at:new Date().toISOString()});
    db.user_identifiers.filter(i=>i.kind===kind&&i.value_hash===h&&i.user_id!==uid).forEach(i=>{ const p=db.profiles.find(x=>x.id===i.user_id); if(p&&(p.banned||db.user_flags.some(f=>f.user_id===p.id))&&!db.user_flags.some(f=>f.user_id===uid&&f.kind==="match"&&f.reason.includes(p.id))) db.user_flags.push({id:uuid(),user_id:uid,kind:"match",reason:"Same "+kind+" ("+label+") as flagged user "+(p.first_name||p.email)+" ["+p.id+"]",created_at:new Date().toISOString()}); });
    db.deleted_user_identifiers.filter(g=>g.kind===kind&&g.value_hash===h).forEach(g=>{ if(!db.user_flags.some(f=>f.user_id===uid&&f.reason.includes(g.id))) db.user_flags.push({id:uuid(),user_id:uid,kind:"match",reason:"Same "+kind+" ("+label+") as a deleted account that was flagged: "+g.note+" [deleted account "+g.id+"]",created_at:new Date().toISOString()}); }); };
  window.__recId=recId;
  const evt=(c,ev,cents,label)=>{ const row={id:uuid(),conversation_id:c.conversation_id,sender:uid()||c.editor,kind:"contract",body:c.title,payload:{contract_id:c.id,event:ev,title:c.title,price:c.price,currency:c.currency,pricing:c.pricing,status:c.status,amount_cents:cents!=null?cents:c.amount_cents,label:label||""},created_at:new Date().toISOString()}; db.messages.push(row); const cv=db.conversations.find(x=>x.id===c.conversation_id); if(cv) cv.last_message_at=row.created_at; setTimeout(()=>channels.forEach(ch=>ch.fire("INSERT","messages",row)),0); };
  const uuid = () => "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => { const r = Math.random()*16|0; return (c==="x"?r:(r&0x3|0x8)).toString(16); });
  const emit = ev => listeners.forEach(f => f(ev, session));
  const uid = () => session ? session.user.id : null;

  // ---------- v20: jobs a freelancer can trust (mirrors schema_v20.sql) ----------
  const SETTINGS={ posting_rules:{ require_identity:false, expiry_days:30, daily_limit_new:3, daily_limit_verified:10, active_limit_new:3, active_limit_verified:15, duplicate_cooldown_days:7, auto_hide_score:5 } };
  db.site_settings=SETTINGS; db.job_reports=[]; db.job_flags=[]; db.moderation_actions=[]; db.identity_verifications=[];
  const HIRE_ST=["paid","funded","delivered","disputed","releasing","resolving","completed"];
  const isVerified=u=>db.identity_verifications.some(v=>v.user_id===u&&v.status==="verified")||db.payout_details.some(x=>x.id===u&&x.stripe_payouts_enabled);
  const identityState=u=>isVerified(u)?"verified":((db.identity_verifications.find(v=>v.user_id===u)||{}).status||"none");
  const jobOpenNow=j=>j.status==="open"&&(!j.expires_at||new Date(j.expires_at)>new Date());
  const listedOwner=u=>{ const p=db.profiles.find(x=>x.id===u); return !!p&&!p.banned&&(p.visibility||"public")==="public"; };
  const clientStats=u=>{ const jobs=db.jobs.filter(j=>j.owner===u&&j.status!=="removed"); const posted=jobs.length; const open=jobs.filter(jobOpenNow).length; const hires=db.contracts.filter(c=>c.client===u&&HIRE_ST.includes(c.status)).length; const done=db.contracts.filter(c=>c.client===u&&c.status==="completed").length; const p=db.profiles.find(x=>x.id===u)||{}; const since=p.created_at||new Date().toISOString(); const days=Math.floor((Date.now()-new Date(since))/86400000);
    return { jobs_posted:posted, jobs_open:open, hires, completed_orders:done, hire_rate:posted>=3?Math.round(100*Math.min(hires,posted)/posted):null, member_since:since.slice(0,7), account_days:days, identity:identityState(u), is_new:hires===0&&(posted<=2||days<30), repeat_no_hire:posted>=5&&hires===0&&days>=30 }; };
  const jobSecured=id=>db.contracts.some(c=>c.job_id===id&&c.payment_mode==="escrow"&&(c.funded_cents||0)>0&&["funded","delivered","disputed","releasing","resolving","completed"].includes(c.status));
  const fingerprint=(t,d)=>String((t||"")+" "+(d||"")).toLowerCase().replace(/[^a-z0-9]+/g," ").trim();
  const jobLinks=d=>{ const m=String(d||"").match(/(https?:\/\/[^\s"'<>)]+|www\.[^\s"'<>)]+|t\.me\/[^\s]+|wa\.me\/[^\s]+)/gi)||[]; return [...new Set(m.map(x=>x.toLowerCase()))].slice(0,20); };
  const budgetCents=b=>{ let m=(String(b||"").match(/([0-9][0-9 .,']*[0-9]|[0-9])/)||[])[1]; if(!m) return null; m=m.replace(/[ ']/g,""); if(/[.,]/.test(m)){ const seps=m.replace(/[^.,]/g,""); const d=seps.slice(-1); if(m.includes(".")&&m.includes(",")) m=m.split(d==="."?",":".").join(""); else if(seps.length>1) m=m.split(d).join(""); else if(new RegExp("\\"+d+"[0-9]{3}$").test(m)) m=m.split(d).join(""); m=m.replace(",","."); } const n=Number(m); return Number.isFinite(n)?Math.min(Math.round(n*100),100000000):null; };
  const jobRisk=(title,desc,budget,links)=>{ const txt=((title||"")+" "+(desc||"")).toLowerCase(); const hits=[]; const hit=(k,s)=>hits.push({k,s});
    if(/(telegram|whatsapp|signal|viber|wechat)/.test(txt)&&/(contact|write|message|dm|text|reach)/.test(txt)) hit("external_channel",2);
    if(/(crypto|bitcoin|btc|usdt|ethereum|binance|wallet address|blockchain investment)/.test(txt)) hit("crypto",2);
    if(/(registration fee|activation fee|training fee|pay (a |the )?(fee|deposit)|deposit (first|before)|buy (the )?(kit|equipment|software) first|send money first)/.test(txt)) hit("pay_to_work",4);
    if(/(passport|id card|social security|ssn|bank login|credit card number|copy of (your )?id)/.test(txt)) hit("sensitive_info",3);
    if(/(western union|moneygram|gift ?card|steam card|itunes card)/.test(txt)) hit("odd_payment",3);
    if(/(outside (of )?cuvori|off(-| )platform|avoid (the )?(fee|escrow|platform)|pay(ment)? directly to avoid)/.test(txt)) hit("bypass_platform",2);
    if(/(no experience (needed|required|necessary)|earn \$?€?[0-9]{3,} (per|a) (day|hour)|guaranteed income|work from home and earn)/.test(txt)) hit("too_good",2);
    const b=budgetCents(budget); if(b!=null&&b>=2000000&&/(simple|easy|quick|no experience)/.test(txt)) hit("unrealistic_pay",2);
    (links||[]).forEach(l=>{ if(/(bit\.ly|tinyurl|t\.me\/|wa\.me\/|cutt\.ly|rb\.gy|goo\.gl|is\.gd|\.xyz(\/|$)|\.top(\/|$)|\.click(\/|$)|\.icu(\/|$))/.test(l)) hit("link:"+l.slice(0,60),2); });
    if((links||[]).length>=5) hit("many_links",1);
    return { score:hits.reduce((a,h)=>a+h.s,0), hits }; };
  const trigrams=str=>{ const s="  "+String(str||"").toLowerCase().replace(/[^a-z0-9 ]+/g," ").replace(/\s+/g," ").trim()+" "; const out=new Set(); for(let i=0;i<s.length-2;i++) out.add(s.slice(i,i+3)); return out; };
  const similar=(a,b)=>{ const A=trigrams(a), B=trigrams(b); let both=0; A.forEach(x=>{ if(B.has(x)) both++; }); const uni=A.size+B.size-both; return uni?both/uni:0; };
  const fillJobs=()=>db.contracts.forEach(c=>{ if(c.job_id&&HIRE_ST.includes(c.status)){ const j=db.jobs.find(x=>x.id===c.job_id); if(j&&j.status==="open"){ j.status="filled"; j.closed_at=new Date().toISOString(); } } });
  const jobGuard=(row,ins)=>{ const me=uid(); const p=db.profiles.find(x=>x.id===me)||{}; const rules=SETTINGS.posting_rules;
    if(ins){ if(me) row.created_at=new Date().toISOString(); if(me&&!p.is_admin) row.status="open"; if(!row.status) row.status="open"; }
    if(!row.profession_slug) row.profession_slug={videographer:"videographer",photographer:"photographer"}[row.role_needed]||"video-editor";
    row.fingerprint=fingerprint(row.title,row.description); row.links=jobLinks(row.description); row.budget_cents=budgetCents(row.budget); row.updated_at=new Date().toISOString();
    if(row.report_count==null) row.report_count=0; if(row.renewed_count==null) row.renewed_count=0;
    if(ins&&me&&!p.is_admin){ const ver=isVerified(me); if(rules.require_identity&&!ver) throw new Error("identity_required");
      const mine=db.jobs.filter(j=>j.owner===me); if(mine.filter(j=>Date.now()-new Date(j.created_at)<86400000).length>=(ver?rules.daily_limit_verified:rules.daily_limit_new)) throw new Error("job_daily_limit");
      if(mine.filter(jobOpenNow).length>=(ver?rules.active_limit_verified:rules.active_limit_new)) throw new Error("job_active_limit");
      if(mine.some(j=>j.fingerprint===row.fingerprint&&["open","hidden"].includes(j.status)&&Date.now()-new Date(j.created_at)<rules.duplicate_cooldown_days*86400000)) throw new Error("duplicate_cooldown");
      row.expires_at=new Date(Date.now()+rules.expiry_days*86400000).toISOString(); }
    const risk=jobRisk(row.title,row.description,row.budget,row.links); row.risk_score=risk.score; row.risk_flags=risk.hits;
    if(ins&&!p.is_admin&&risk.score>=rules.auto_hide_score){ row.status="hidden"; row.hidden_reason="auto_review"; } };
  const jobAfterWrite=row=>{ db.job_flags=db.job_flags.filter(f=>!(f.job_id===row.id&&f.status==="open"&&["duplicate","near_duplicate","risk_text","links","repeat_no_hire"].includes(f.kind)));
    const flag=(kind,detail,score)=>db.job_flags.push({ id:db.job_flags.length+1, job_id:row.id, kind, detail, score, status:"open", created_at:new Date().toISOString() });
    (row.risk_flags||[]).forEach(h=>flag(h.k.startsWith("link:")?"links":"risk_text",{hit:h.k},h.s));
    db.jobs.filter(j=>j.owner===row.owner&&j.id!==row.id&&j.status!=="removed"&&Date.now()-new Date(j.created_at)<90*86400000).forEach(j=>{ if(j.fingerprint===row.fingerprint) flag("duplicate",{other:j.id,title:j.title,at:j.created_at,other_status:j.status},2); else { const ts=similar(j.title,row.title); if(ts>=0.6) flag("near_duplicate",{other:j.id,title:j.title,at:j.created_at,similarity:Math.round(ts*100)/100,other_status:j.status},1); } });
    const st=clientStats(row.owner); if(st.repeat_no_hire) flag("repeat_no_hire",{jobs_posted:st.jobs_posted,hires:st.hires,account_days:st.account_days},2); };
  window.__jobsMock={ SETTINGS, clientStats, jobRisk, budgetCents };

  function query(table){
    const st = { filters:[], order:null, limit:null, op:"select", vals:null, single:false, maybe:false, sel:"*" };
    const rows = () => db[table];
    const match = r => st.filters.every(f => f.kind==="eq" ? String(r[f.k])===String(f.v) : f.kind==="in" ? f.v.map(String).includes(String(r[f.k])) : true);
    const q = {
      select(sel){ if(st.op==="select") st.sel=sel||"*"; st.wantReturn=true; return q; },
      eq(k,v){ st.filters.push({kind:"eq",k,v}); return q; },
      in(k,v){ st.filters.push({kind:"in",k,v}); return q; },
      order(k,o){ st.order={k,asc:!o||o.ascending!==false}; return q; },
      limit(n){ st.limit=n; return q; },
      single(){ st.single=true; return q; },
      maybeSingle(){ st.maybe=true; return q; },
      insert(vals){ st.op="insert"; st.vals=Array.isArray(vals)?vals:[vals]; return q; },
      upsert(vals,opts){ st.op="upsert"; st.vals=Array.isArray(vals)?vals:[vals]; st.conflict=opts&&opts.onConflict?opts.onConflict.split(","):["id"]; return q; },
      update(vals){ st.op="update"; st.vals=vals; return q; },
      delete(){ st.op="delete"; return q; },
      then(res, rej){
        let out=null, error=null;
        try{
          if(st.op==="select"){
            let r = rows().filter(match);
            // RLS-ish: editor_profiles only public or own; projects only of public editors or own; invites hidden
            if(table==="editor_profiles") r = r.filter(x => (x.is_public && !(db.profiles.find(p=>p.id===x.id)||{}).banned) || x.id===uid());
            if(table==="projects") r = r.filter(x => x.owner===uid() || db.editor_profiles.some(e=>e.id===x.owner && e.is_public));
            if(table==="conversations") r = r.filter(x => uid() && (x.user_a===uid()||x.user_b===uid()));
            if(table==="contracts") r = r.filter(x => uid() && (x.editor===uid()||x.client===uid()));
            if(table==="payout_details") r = r.filter(x => x.id===uid());
            if(table==="jobs"){ const a=(db.profiles.find(p=>p.id===uid())||{}).is_admin; r = r.filter(x => (jobOpenNow(x)&&listedOwner(x.owner)) || x.owner===uid() || a); }
            if(table==="messages") r = r.filter(x => db.conversations.some(c=>c.id===x.conversation_id && uid() && (c.user_a===uid()||c.user_b===uid())));
            // ties keep the order the rows were written in (a real database orders by its own key too):
            // without this, two rows written in the same millisecond come back in an arbitrary order
            if(st.order){ const pos=new Map(r.map((x,i)=>[x,i])); const k=st.order.k, dir=st.order.asc?1:-1;
              r = r.slice().sort((a,b)=>{ const d=(a[k]>b[k]?1:a[k]<b[k]?-1:0); return (d||(pos.get(a)-pos.get(b))) * dir; }); }
            if(st.limit) r = r.slice(0, st.limit);
            out = (st.single||st.maybe) ? (r[0]||null) : r;
            if(st.single && !out) error={message:"no rows"};
          } else if(st.op==="insert" || st.op==="upsert"){
            const ins = st.vals.map(v => { const row={...v}; if(!row.id) row.id=uuid(); if(!row.created_at) row.created_at=new Date().toISOString(); return row; });
            for(const row of ins){
              if(table==="messages"){ const c=db.conversations.find(c=>c.id===row.conversation_id); if(c) c.last_message_at=row.created_at; setTimeout(()=>channels.forEach(ch=>ch.fire("INSERT",table,row)),0); }
              if(table==="services"){ const old=db.services.find(x=>x.id===row.id)||db.services.find(x=>x.profile_id===row.profile_id&&x.profession_slug===row.profession_slug);
                if(!old){ if(uid()!==row.profile_id) throw new Error("permission denied for table services"); const me=db.profiles.find(x=>x.id===uid()); if(!me||me.role!=="editor") throw new Error("new row violates row-level security policy for table \"services\""); }
                if(old && st.op==="upsert" && !row.id){ row.id=old.id; }
                serviceGuard(Object.assign(row,{profile_id:row.profile_id||(old||{}).profile_id}), !old); if(!old) row.created_at=new Date().toISOString(); }
              if(table==="editor_profiles"){
                const old=db.editor_profiles.find(e=>e.id===row.id);
                if(row.availability!=="busy") row.free_from=null;
                if(old){ row.last_active_on=old.last_active_on;
                  row.availability_set_at=(row.availability!==old.availability||row.free_from!==old.free_from)?new Date().toISOString():old.availability_set_at; }
                else { row.availability_set_at=new Date().toISOString(); row.last_active_on=new Date().toISOString().slice(0,10); }
                if(!row.availability) row.availability="open";
              }
              if(table==="reviews"){ row.via_contract = db.contracts.some(c=>c.editor===row.editor && c.client===row.client && ["accepted","paid_marked","paid","funded","delivered","disputed","releasing","resolving","completed","refunded"].includes(c.status)); }
              if(table==="payout_details"){ (row.methods||[]).forEach(m=>{ let k=m.type==='bank'?'iban':(['paypal','revolut','wise'].includes(m.type)?m.type:'other'); recId(row.id,k,m.details,k+' ••'+String(m.details||'').replace(/\s/g,'').slice(-4)); }); }
              if(table==="services"){ const i=rows().findIndex(x=>x.id===row.id||(x.profile_id===row.profile_id&&x.profession_slug===row.profession_slug)); if(i>=0){ rows()[i]={...rows()[i],...row}; } else rows().push(row); serviceMirror(row.profile_id); continue; }
              if(st.op==="upsert"){ const i=rows().findIndex(x=>st.conflict.every(k=>x[k]===row[k])); if(i>=0){ rows()[i]={...rows()[i],...row}; if(table==="editor_profiles") migrateEditor(rows()[i]); continue; } }
              if(table==="jobs"){ if(!uid()||row.owner!==uid()) throw new Error("new row violates row-level security policy for table \"jobs\""); if((db.profiles.find(p=>p.id===uid())||{}).banned) throw new Error("new row violates row-level security policy for table \"jobs\""); jobGuard(row,true); }
              rows().push(row); if(table==="editor_profiles") migrateEditor(row); if(table==="jobs") jobAfterWrite(row);
            }
            out = st.single ? ins[0] : ins;
          } else if(st.op==="update"){
            const r = rows().filter(match);
            if(table==="services"){ r.forEach(x=>{ if(x.profile_id!==uid()) throw new Error("permission denied"); const nx={...x,...st.vals}; serviceGuard(nx,false); Object.assign(x,nx); serviceMirror(x.profile_id); }); }
            else if(table==="jobs"){ const allowed=["title","description","location","remote","pricing","budget","deadline","category","profession_slug","details","role_needed"]; for(const k in st.vals) if(!allowed.includes(k)) throw new Error("permission denied for table jobs"); r.forEach(x=>{ if(x.owner!==uid()) return; Object.assign(x, st.vals); jobGuard(x,false); jobAfterWrite(x); }); }
            else r.forEach(x=>Object.assign(x, st.vals));
            if(table==="messages") r.forEach(x=>setTimeout(()=>channels.forEach(ch=>ch.fire("UPDATE",table,x)),0));
            out = r;
          } else if(st.op==="delete"){
            const keep = rows().filter(x=>!match(x)); db[table].length=0; keep.forEach(x=>db[table].push(x)); out=null;
          }
        }catch(e){ error={message:e.message}; }
        return Promise.resolve({ data:out, error }).then(res, rej);
      }
    };
    return q;
  }

  function oauthSession(provider, ev){ const email=provider+"-user@test.com"; let u=users[email]; let id;
    if(!u){ id=uuid(); users[email]={id,password:"oauth"}; db.profiles.push({id,email,first_name:provider==="google"?"Greta":"Fabio",role:"client",is_admin:Object.keys(users).length===1,banned:false,rules_version:null,created_at:new Date().toISOString()}); recId(id,"email",email,email); } else id=u.id;
    session={user:{id,email,user_metadata:{full_name:provider==="google"?"Greta Google":"Fabio Facebook"}}}; setTimeout(()=>emit(ev||"SIGNED_IN"),0); }
  // supabase-js reads the tokens out of the address a moment after the page loads (first getSession); a page that rewrote the address before that loses the sign-in
  let urlDone=false;
  function consumeUrl(){ if(urlDone) return; urlDone=true; let h; try{ h=new URLSearchParams(location.hash.slice(1)); }catch(e){ return; }
    const tok=h.get("access_token"); if(tok && /^mock-/.test(tok)) oauthSession(tok.slice(5), h.get("type")==="recovery" ? "PASSWORD_RECOVERY" : "SIGNED_IN"); }   // a reset link fires PASSWORD_RECOVERY instead of SIGNED_IN, like the real client
  const client = {
    auth:{
      async getSession(){ consumeUrl(); return {data:{session}}; },
      onAuthStateChange(f){ listeners.push(f); return {data:{subscription:{unsubscribe(){}}}}; },
      async signUp({email,password,options}){ if(users[email]) return {data:{},error:{message:"User already registered"}}; const id=uuid(); users[email]={id,password}; db.profiles.push({id,email,first_name:options.data.first_name,role:"client",is_admin:Object.keys(users).length===1,banned:false,created_at:new Date().toISOString()}); recId(id,"email",email,email); session={user:{id,email,user_metadata:{first_name:options.data.first_name}}}; setTimeout(()=>emit("SIGNED_IN"),0); return {data:{session},error:null}; },
      async signInWithOAuth({provider,options}){ if(!window.__mockOAuth) return {data:{url:null},error:{message:"Unsupported provider: provider is not enabled"}};
        if(window.__mockOAuthRedirect){ return {data:{url:options.redirectTo+"?mock_oauth=1#access_token=mock-"+provider+"&refresh_token=r&expires_in=3600&token_type=bearer",provider},error:null}; }   // like the real thing: leave and come back with tokens in the address
        oauthSession(provider); return {data:{url:null,provider},error:null}; },
      async signInWithPassword({email,password}){ const u=users[email]; if(!u||u.password!==password) return {data:{},error:{message:"Invalid login credentials"}}; session={user:{id:u.id,email,user_metadata:{}}}; setTimeout(()=>emit("SIGNED_IN"),0); return {data:{session},error:null}; },
      async signOut(){ session=null; setTimeout(()=>emit("SIGNED_OUT"),0); return {error:null}; },
      async resetPasswordForEmail(){ return {error:null}; },
      async updateUser(){ return {error:null}; }
    },
    from(table){ return query(table); },
    rpc(fn, args){
      const pr=this.rpcImpl(fn, args||{});
      pr.maybeSingle=()=>pr.then(r=>({...r, data:Array.isArray(r.data)?(r.data[0]||null):r.data}));
      pr.single=pr.maybeSingle;
      return pr;
    },
    async rpcImpl(fn, args){
      if(fn==="my_profile"){ if(!uid()) return {data:[]}; return {data: db.profiles.filter(p=>p.id===uid()).map(p=>({...p}))}; }
      if(fn==="redeem_invite"){ const code=args.code; if(!uid()) return {data:"not_signed_in"}; if(!(code in invites)) return {data:"invalid"}; if(invites[code]) return {data:"used"}; invites[code]=uid(); const inv=db.invites.find(i=>i.code===code); if(inv){ inv.used_by=uid(); inv.used_at=new Date().toISOString(); } db.profiles.find(p=>p.id===uid()).role="editor"; return {data:"ok"}; }
      if(fn==="open_conversation"){ const other=args.other; if(!uid()) return {error:{message:"not signed in"}}; const [a,b]=[uid(),other].sort(); let c=db.conversations.find(c=>c.user_a===a&&c.user_b===b);
        const meP=db.profiles.find(p=>p.id===uid()), oP=db.profiles.find(p=>p.id===other);
        if(!c && meP && meP.banned) return {error:{message:"banned"}};
        if(!c && (!oP || oP.banned || !(meP&&meP.is_admin || db.editor_profiles.some(e=>e.id===other&&e.is_public) || db.jobs.some(j=>j.owner===other&&j.status==="open")))) return {error:{message:"not_available"}};
        if(!c){ c={id:uuid(),user_a:a,user_b:b,created_at:new Date().toISOString(),last_message_at:new Date().toISOString()}; db.conversations.push(c); } return {data:c.id}; }
      const me=()=>db.profiles.find(p=>p.id===uid()); const adm=()=>me()&&me().is_admin;
      const purge=(t)=>{ const p0=db.profiles.find(p=>p.id===t); if(p0&&(p0.banned||db.user_flags.some(f=>f.user_id===t))){ const note=db.user_flags.filter(f=>f.user_id===t).map(f=>f.kind+': '+f.reason).join(' | ')||'banned'; db.user_identifiers.filter(i=>i.user_id===t).forEach(i=>db.deleted_user_identifiers.push({id:uuid(),kind:i.kind,value_hash:i.value_hash,label:i.label,note})); } db.user_identifiers=db.user_identifiers.filter(i=>i.user_id!==t); db.user_flags=db.user_flags.filter(f=>f.user_id!==t); db.reviews=db.reviews.filter(r=>r.client!==t&&r.editor!==t); db.order_reviews=db.order_reviews.filter(r=>r.reviewer!==t&&r.reviewee!==t); db.messages=db.messages.filter(m=>m.sender!==t); db.conversations=db.conversations.filter(c=>c.user_a!==t&&c.user_b!==t); db.jobs=db.jobs.filter(j=>j.owner!==t); db.projects=db.projects.filter(p=>p.owner!==t); db.editor_profiles=db.editor_profiles.filter(e=>e.id!==t); db.profiles=db.profiles.filter(p=>p.id!==t); for(const e in users) if(users[e].id===t) delete users[e]; };
      if(fn==="payout_info"){ const ed=args.ed; if(!uid()) return {data:null}; const ok=uid()===ed||db.contracts.some(k=>k.editor===ed&&k.client===uid()&&(k.payment_mode||"direct")==="direct"&&["accepted","paid_marked","paid","completed"].includes(k.status)); if(!ok) return {data:null}; const p=db.payout_details.find(x=>x.id===ed); return {data:p?{methods:p.methods,note:p.note}:null}; }
      if(fn==="propose_contract"){ const cv=db.conversations.find(c=>c.id===args.conv&&(c.user_a===uid()||c.user_b===uid())); if(!cv) return {error:{message:"not your conversation"}}; const isEd=id=>(db.profiles.find(p=>p.id===id)||{}).role==="editor"; let ed,cl; if(isEd(cv.user_a)&&!isEd(cv.user_b)){ed=cv.user_a;cl=cv.user_b;} else if(isEd(cv.user_b)&&!isEd(cv.user_a)){ed=cv.user_b;cl=cv.user_a;} else if(isEd(cv.user_a)&&isEd(cv.user_b)){ cl=uid(); ed=uid()===cv.user_a?cv.user_b:cv.user_a; } else return {error:{message:"no editor in this conversation"}}; if(db.contracts.some(x=>x.conversation_id===args.conv&&["proposed","accepted","paid_marked","paid","funded","delivered","disputed"].includes(x.status))) return {error:{message:"active_contract_exists"}}; const bad=validateContract(args); if(bad) return {error:{message:bad}}; const c={id:uuid(),conversation_id:args.conv,editor:ed,client:cl,proposed_by:uid(),title:args.title,description:args.description||"",price:args.price,currency:"EUR",pricing:args.pricing||"project",deadline:args.deadline,revisions:args.revisions==null?2:args.revisions,status:"proposed",payment_mode:args.mode==="escrow"?"escrow":"direct",amount_cents:Math.round(args.price*100),contract_type:args.ctype||"fixed",law_country:args.law||"XX",language:args.lang||"en",terms:args.terms||{},terms_version:1,terms_changed_by:uid(),created_at:new Date().toISOString()}; db.contracts.push(c); evt(c,"proposed"); return {data:c.id}; }
      if(fn==="store_contract_doc"){ const c=db.contracts.find(x=>x.id===args.cid&&(x.editor===uid()||x.client===uid())); if(!c) return {data:"not_found"}; if(c.terms_doc) return {data:"ok"}; if(["proposed","declined","cancelled"].includes(c.status)) return {data:"not_allowed"}; if(!args.doc||typeof args.doc!=="object"||JSON.stringify(args.doc).length>200000) return {data:"bad_terms"}; c.terms_doc=args.doc; return {data:"ok"}; }
      if(fn==="adjust_contract"){ const c=db.contracts.find(x=>x.id===args.cid&&(x.editor===uid()||x.client===uid())); if(!c) return {data:"not_found"}; if(c.status!=="proposed") return {data:"not_allowed"}; const bad=validateContract({...args,mode:c.payment_mode}); if(bad) return {error:{message:bad}}; Object.assign(c,{title:args.title,description:args.description||"",price:args.price,pricing:args.pricing,deadline:args.deadline,revisions:args.revisions==null?2:args.revisions,amount_cents:Math.round(args.price*100),contract_type:args.ctype,law_country:args.law,language:args.lang,terms:args.terms||{},terms_version:(c.terms_version||1)+1,terms_changed_by:uid(),proposed_by:uid()}); evt(c,"terms_changed"); return {data:"ok"}; }
      // ---------- v18: the Order is the contract ----------
      const olog=(c,ev,data)=>db.order_events.push({id:db.order_events.length+1,order_id:c.id,actor:uid(),event:ev,data:data||{},created_at:new Date().toISOString()});
      const oheld=c=>Math.max((c.funded_cents||0)-(c.released_cents||0)-(c.refunded_cents||0),0);
      const isEdU=id=>(db.profiles.find(p=>p.id===id)||{}).role==="editor";
      const oValidate=(p)=>{ if(!p||typeof p!=="object") return "bad_terms"; if(!p.title||!String(p.title).trim()||String(p.title).length>200) return "bad_title"; if(String(p.scope||"").length>5000||String(p.deliverables||"").length>3000||String(p.client_duties||"").length>2000||String(p.freelancer_duties||"").length>2000||String(p.custom||"").length>5000) return "description_too_long";
        const pc=Number(p.price_cents); if(!Number.isInteger(pc)||pc<100||pc>100000000) return "bad_price"; const rev=p.revisions==null?2:Number(p.revisions); if(!(rev>=0&&rev<=50)) return "bad_revisions"; if(p.deadline&&p.deadline<new Date().toISOString().slice(0,10)) return "deadline_in_past";
        if(p.rights&&!["full","license"].includes(p.rights)) return "bad_rights"; if(p.profession_slug&&!pcfg().professions.some(x=>x.slug===p.profession_slug)) return "bad_profession";
        const ms=Array.isArray(p.milestones)?p.milestones:[]; if(ms.length===1) return "bad_milestones"; if(ms.length>20) return "too_many_milestones"; let sum=0; for(const m of ms){ if(!m||!String(m.title||"").trim()||String(m.title).length>120||!Number.isInteger(Number(m.amount_cents))||Number(m.amount_cents)<=0) return "bad_milestones"; sum+=Number(m.amount_cents); } if(ms.length&&sum!==pc) return "milestones_sum"; return null; };
      const oWriteMs=(c,ms)=>{ db.order_milestones=db.order_milestones.filter(m=>!(m.order_id===c.id&&m.status==="pending")); (Array.isArray(ms)?ms:[]).forEach((m,i)=>db.order_milestones.push({id:uuid(),order_id:c.id,position:i+1,title:String(m.title).trim(),amount_cents:Number(m.amount_cents),due:m.due||null,status:"pending",submitted_at:null,approved_at:null,released_at:null,auto_release_at:null,delivery_note:null,delivery_url:null,transfer_ref:null,created_at:new Date().toISOString()})); };
      const oTerms=p=>({on:{usage:(p.rights||"full")==="full",cancel:true,liability:true,force:true,vat:true,materials:true,credit:true},custom:String(p.custom||"").slice(0,5000),cancel_days:7,grace_days:7});
      if(fn==="is_editor") return {data:isEdU(args.uid)};
      if(fn==="order_quote"){ const pc=Number(args.p_price_cents); if(!Number.isInteger(pc)||pc<0) return {error:{message:"bad_price"}}; const eea=["AT","BE","BG","HR","CY","CZ","DK","EE","FI","FR","DE","GR","HU","IE","IT","LV","LT","LU","MT","NL","PL","PT","RO","SK","SI","ES","SE","IS","LI","NO"]; const reg=!args.p_country?"ANY":eea.includes(String(args.p_country).toUpperCase())?"EEA":"INTL"; const cust=args.p_customer||"any", meth=args.p_method||"any";
        const rows=db.fee_schedules.filter(f=>f.active&&f.currency==="EUR"&&(f.country===String(args.p_country||"").toUpperCase()||(!f.country&&[reg,"ANY"].includes(f.region)))&&[cust,"any"].includes(f.customer_kind)&&[meth,"any"].includes(f.method)).sort((a,b)=>((b.country?1:0)-(a.country?1:0))||((b.region===reg?1:0)-(a.region===reg?1:0))||((b.customer_kind!=="any"?1:0)-(a.customer_kind!=="any"?1:0))||((b.method!=="any"?1:0)-(a.method!=="any"?1:0))||(a.id-b.id));
        const f=rows[0]; if(!f) return {data:{price_cents:pc,processing_cents:0,cuvori_cents:0,total_cents:pc,currency:"EUR",payer:"platform",percent:0,fixed_cents:0,schedule_id:null,region:reg}};
        const total=(f.payer==="platform"||pc===0)?pc:Math.ceil((pc+f.fixed_cents)/(1-f.percent/100)); return {data:{price_cents:pc,processing_cents:total-pc,cuvori_cents:0,total_cents:total,currency:"EUR",payer:f.payer,percent:f.percent,fixed_cents:f.fixed_cents,schedule_id:f.id,region:reg,provider:f.provider}}; }
      if(fn==="admin_fee_schedules"){ if(!adm()) return {data:[]}; return {data:db.fee_schedules.slice()}; }
      if(fn==="admin_set_fee_schedule"){ if(!adm()) return {data:"forbidden"}; const p=args.p||{}; if(p.id){ const f=db.fee_schedules.find(x=>x.id===Number(p.id)); if(!f) return {data:"not_found"}; if(p.percent!=null) f.percent=Number(p.percent); if(p.fixed_cents!=null) f.fixed_cents=Number(p.fixed_cents); if(p.payer) f.payer=p.payer; if(p.active!=null) f.active=!!p.active; if(p.note!=null) f.note=String(p.note).slice(0,300); if(p.customer_kind) f.customer_kind=p.customer_kind; if(p.method) f.method=p.method; if(p.region) f.region=p.region; if("country" in p) f.country=p.country||null; }
        else db.fee_schedules.push({id:db.fee_schedules.length+1,provider:p.provider||"stripe",region:p.region||"ANY",country:p.country||null,customer_kind:p.customer_kind||"any",method:p.method||"any",percent:Number(p.percent||0),fixed_cents:Number(p.fixed_cents||0),currency:"EUR",payer:p.payer||"client",active:p.active!=null?!!p.active:true,note:String(p.note||"").slice(0,300)}); return {data:"ok"}; }
      if(fn==="order_create"){ if(!uid()) return {error:{message:"not_signed_in"}}; if(me()&&me().banned) return {error:{message:"banned"}}; const cv=db.conversations.find(c=>c.id===args.p_conv&&(c.user_a===uid()||c.user_b===uid())); if(!cv) return {error:{message:"not_your_conversation"}}; const p=args.p||{}; const bad=oValidate(p); if(bad) return {error:{message:bad}};
        let ed,cl; if(isEdU(cv.user_a)&&!isEdU(cv.user_b)){ed=cv.user_a;cl=cv.user_b;} else if(isEdU(cv.user_b)&&!isEdU(cv.user_a)){ed=cv.user_b;cl=cv.user_a;} else if(isEdU(cv.user_a)&&isEdU(cv.user_b)){ cl=uid(); ed=uid()===cv.user_a?cv.user_b:cv.user_a; } else return {error:{message:"no_professional"}};
        if(db.contracts.some(x=>x.conversation_id===cv.id&&["proposed","accepted","paid_marked","paid","funded","delivered","disputed","releasing","resolving"].includes(x.status))) return {error:{message:"active_contract_exists"}};
        const pc=Number(p.price_cents); const ms=Array.isArray(p.milestones)?p.milestones:[]; const mine=uid()===cl?"client":"freelancer";
        const c={id:uuid(),conversation_id:cv.id,editor:ed,client:cl,proposed_by:uid(),title:String(p.title).trim(),description:p.scope||"",price:pc/100,currency:"EUR",pricing:"project",deadline:p.deadline||null,revisions:p.revisions==null?2:Number(p.revisions),status:"proposed",payment_mode:p.mode==="escrow"?"escrow":"direct",amount_cents:pc,contract_type:"fixed",law_country:(p.law||"XX").toUpperCase(),language:p.language||"en",terms:oTerms(p),terms_version:1,terms_changed_by:uid(),
          profession_slug:p.profession_slug||null,service_id:p.service_id||null,job_id:p.job_id||null,deliverables:p.deliverables||"",client_duties:p.client_duties||"",freelancer_duties:p.freelancer_duties||"",rights:p.rights||"full",has_milestones:ms.length>0,changes_used:0,changes_open:false,amendments:0,funded_cents:0,released_cents:0,refunded_cents:0,auto_days:7,
          client_accepted_version:mine==="client"?1:null,client_accepted_at:mine==="client"?new Date().toISOString():null,freelancer_accepted_version:mine==="freelancer"?1:null,freelancer_accepted_at:mine==="freelancer"?new Date().toISOString():null,accepted_version:null,created_at:new Date().toISOString()};
        db.contracts.push(c); oWriteMs(c,ms); olog(c,"created",{version:1,price_cents:pc,milestones:ms}); olog(c,mine+"_accepted",{version:1}); evt(c,"proposed"); return {data:c.id}; }
      if(fn==="order_update"){ const c=db.contracts.find(x=>x.id===args.p_order&&(x.editor===uid()||x.client===uid())); if(!c) return {data:"not_found"}; if(c.status!=="proposed") return {data:"not_allowed"}; const p=args.p||{}; const bad=oValidate(p); if(bad) return {error:{message:bad}}; const pc=Number(p.price_cents); const v=c.terms_version+1; const ms=Array.isArray(p.milestones)?p.milestones:[]; const mine=uid()===c.client?"client":"freelancer";
        Object.assign(c,{title:String(p.title).trim(),description:p.scope||"",price:pc/100,amount_cents:pc,deadline:p.deadline||null,revisions:p.revisions==null?2:Number(p.revisions),law_country:(p.law||c.law_country).toUpperCase(),language:p.language||c.language,terms:oTerms(p),profession_slug:p.profession_slug||c.profession_slug,deliverables:p.deliverables||"",client_duties:p.client_duties||"",freelancer_duties:p.freelancer_duties||"",rights:p.rights||"full",has_milestones:ms.length>0,terms_version:v,terms_changed_by:uid(),proposed_by:uid(),
          client_accepted_version:mine==="client"?v:null,client_accepted_at:mine==="client"?new Date().toISOString():null,freelancer_accepted_version:mine==="freelancer"?v:null,freelancer_accepted_at:mine==="freelancer"?new Date().toISOString():null});
        oWriteMs(c,ms); olog(c,"updated",{version:v,price_cents:pc,title:c.title,deadline:c.deadline,milestones:ms}); olog(c,mine+"_accepted",{version:v}); evt(c,"terms_changed"); return {data:"ok"}; }
      if(fn==="order_accept"||(fn==="order_action"&&args.p_action==="accept")||(fn==="contract_action"&&args.action==="accept")){ const oid=args.p_order||args.cid; const c=db.contracts.find(x=>x.id===oid&&(x.editor===uid()||x.client===uid())); if(!c) return {data:"not_found"}; if(c.status!=="proposed") return {data:"not_allowed"};
        if(c.client_accepted_version==null&&c.freelancer_accepted_version==null){ if(c.proposed_by===c.client) c.client_accepted_version=c.terms_version; else c.freelancer_accepted_version=c.terms_version; }
        const mine=uid()===c.client?"client":"freelancer"; if(c[mine+"_accepted_version"]===c.terms_version) return {data:"already_accepted"}; c[mine+"_accepted_version"]=c.terms_version; c[mine+"_accepted_at"]=new Date().toISOString(); olog(c,mine+"_accepted",{version:c.terms_version});
        if(c.client_accepted_version===c.terms_version&&c.freelancer_accepted_version===c.terms_version){ c.status="accepted"; c.accepted_at=new Date().toISOString(); c.accepted_version=c.terms_version; olog(c,"accepted",{version:c.terms_version,price_cents:c.amount_cents}); evt(c,"accept"); } else evt(c,mine+"_accepted"); return {data:"ok"}; }
      if(fn==="order_action"||fn==="contract_action"){ const oid=args.p_order||args.cid, a=args.p_action||args.action, note=(args.p_note||args.note||"").trim()||null, link=(args.p_link||args.link||"").trim()||null; const c=db.contracts.find(x=>x.id===oid&&(x.editor===uid()||x.client===uid())); if(!c) return {data:"not_found"}; const me0=uid(); const no={data:"not_allowed"}; if(note&&note.length>2000) return {data:"note_too_long"}; if(link&&!/^https:\/\//.test(link)) return {data:"bad_link"};
        if(a==="decline"){ if(c.status!=="proposed"||c.proposed_by===me0) return no; c.status="declined"; c.closed_at=new Date().toISOString(); olog(c,"declined",{note}); }
        else if(a==="cancel"){ if(!(["proposed","accepted"].includes(c.status)||(c.payment_mode==="direct"&&c.status==="paid_marked"))) return no; c.status="cancelled"; c.closed_at=new Date().toISOString(); olog(c,"cancelled",{note}); }
        else if(a==="mark_paid"){ if(c.payment_mode!=="direct"||c.status!=="accepted"||me0!==c.client) return no; c.status="paid_marked"; c.paid_marked_at=new Date().toISOString(); olog(c,"paid_marked",{}); }
        else if(a==="confirm_paid"){ if(c.payment_mode!=="direct"||!["accepted","paid_marked"].includes(c.status)||me0!==c.editor) return no; c.status="paid"; c.paid_at=new Date().toISOString(); c.funded_cents=c.amount_cents; db.order_payments.push({id:uuid(),order_id:c.id,milestone_id:null,kind:"fund",amount_cents:c.amount_cents,fee_cents:0,provider:"direct",provider_ref:null,status:"succeeded",note:"confirmed by the freelancer",created_at:new Date().toISOString()}); olog(c,"paid_confirmed",{amount_cents:c.amount_cents}); }
        else if(a==="complete"){ if(c.payment_mode!=="direct"||c.status!=="paid"||me0!==c.client) return no; c.status="completed"; c.completed_at=new Date().toISOString(); c.released_cents=c.funded_cents; db.order_payments.push({id:uuid(),order_id:c.id,milestone_id:null,kind:"release",amount_cents:c.amount_cents,fee_cents:0,provider:"direct",provider_ref:null,status:"succeeded",note:"work approved by the client",created_at:new Date().toISOString()}); olog(c,"completed",{}); }
        else if(a==="deliver"){ if(!["funded","paid"].includes(c.status)||me0!==c.editor||c.has_milestones) return no; c.delivered_at=new Date().toISOString(); c.delivery_note=note; c.delivery_url=link; c.changes_open=false; if(c.payment_mode==="escrow"){ c.status="delivered"; c.auto_release_at=new Date(Date.now()+7*86400000).toISOString(); } olog(c,"delivered",{note,link}); }
        else if(a==="request_changes"){ if(me0!==c.client) return no; if(c.payment_mode==="escrow"){ if(c.status!=="delivered") return no; c.changes_used=(c.changes_used||0)+1; c.changes_open=true; if(c.changes_used<=(c.revisions||0)){ c.status="funded"; c.auto_release_at=null; } } else { if(!["paid","paid_marked","accepted"].includes(c.status)||!c.delivered_at) return no; c.changes_used=(c.changes_used||0)+1; c.changes_open=true; }
          if(note) db.messages.push({id:uuid(),conversation_id:c.conversation_id,sender:me0,kind:"change_request",body:note,created_at:new Date().toISOString()}); olog(c,"changes_requested",{note,round:c.changes_used}); }
        else if(a==="dispute"){ if(c.payment_mode!=="escrow"||!["funded","delivered"].includes(c.status)) return no; c.status="disputed"; c.dispute_by=me0; c.dispute_reason=note; c.disputed_at=new Date().toISOString(); c.auto_release_at=null; db.order_milestones.filter(m=>m.order_id===c.id).forEach(m=>m.auto_release_at=null); olog(c,"disputed",{note}); }
        else return {data:"bad_action"};
        evt(c,a); return {data:"ok"}; }
      if(fn==="order_milestone_action"){ const m=db.order_milestones.find(x=>x.id===args.p_ms); if(!m) return {data:"not_found"}; const c=db.contracts.find(x=>x.id===m.order_id&&(x.editor===uid()||x.client===uid())); if(!c) return {data:"not_found"}; const a=args.p_action, note=(args.p_note||"").trim()||null, link=(args.p_link||"").trim()||null; const no={data:"not_allowed"};
        if(a==="submit"){ if(uid()!==c.editor||!["funded","paid"].includes(c.status)||m.status!=="pending") return no; m.status="submitted"; m.submitted_at=new Date().toISOString(); m.delivery_note=note; m.delivery_url=link; m.auto_release_at=c.payment_mode==="escrow"?new Date(Date.now()+7*86400000).toISOString():null; c.changes_open=false; olog(c,"milestone_submitted",{milestone:m.id,title:m.title,amount_cents:m.amount_cents,note,link}); evt(c,"milestone_submitted",m.amount_cents,m.title); }
        else if(a==="request_changes"){ if(uid()!==c.client||m.status!=="submitted") return no; c.changes_used=(c.changes_used||0)+1; c.changes_open=true; if(c.changes_used<=(c.revisions||0)){ m.status="pending"; m.auto_release_at=null; } if(note) db.messages.push({id:uuid(),conversation_id:c.conversation_id,sender:uid(),kind:"change_request",body:note,created_at:new Date().toISOString()}); olog(c,"milestone_changes_requested",{milestone:m.id,title:m.title,note,round:c.changes_used}); evt(c,"request_changes",m.amount_cents,m.title); }
        else if(a==="approve"){ if(uid()!==c.client||c.payment_mode!=="direct"||m.status!=="submitted") return no; m.status="approved"; m.approved_at=new Date().toISOString(); olog(c,"milestone_approved",{milestone:m.id,title:m.title,amount_cents:m.amount_cents}); evt(c,"milestone_approved",m.amount_cents,m.title); if(!db.order_milestones.some(x=>x.order_id===c.id&&!["approved","released"].includes(x.status))) c.delivered_at=new Date().toISOString(); }
        else return {data:"bad_action"}; return {data:"ok"}; }
      if(fn==="order_amend"){ const c=db.contracts.find(x=>x.id===args.p_order&&(x.editor===uid()||x.client===uid())); if(!c) return {error:{message:"not_found"}}; if(!["accepted","paid_marked","paid","funded","delivered"].includes(c.status)) return {error:{message:"not_allowed"}}; if(db.order_amendments.some(x=>x.order_id===c.id&&x.status==="proposed")) return {error:{message:"amendment_open"}}; const p=args.p||{}; const delta=Number(p.price_delta_cents||0);
        if(String(p.note||"").length>2000||String(p.scope_add||"").length>3000) return {error:{message:"description_too_long"}}; if(delta<-c.amount_cents||c.amount_cents+delta<100) return {error:{message:"bad_price"}}; if(delta<0&&(c.has_milestones||["funded","delivered"].includes(c.status))) return {error:{message:"bad_price"}}; const ms=Array.isArray(p.milestones)?p.milestones:[]; if(ms.length){ if(!c.has_milestones) return {error:{message:"bad_milestones"}}; if(ms.reduce((a,m)=>a+Number(m.amount_cents||0),0)!==delta) return {error:{message:"milestones_sum"}}; } else if(c.has_milestones&&delta>0) return {error:{message:"milestones_sum"}};
        if(!p.note&&!delta&&!p.new_deadline&&!p.scope_add&&!p.deliverables_add&&!Number(p.revisions_add||0)) return {error:{message:"bad_terms"}};
        const a={id:uuid(),order_id:c.id,proposed_by:uid(),note:p.note||"",price_delta_cents:delta,new_deadline:p.new_deadline||null,scope_add:p.scope_add||"",deliverables_add:p.deliverables_add||"",revisions_add:Number(p.revisions_add||0),milestones:ms,status:"proposed",created_at:new Date().toISOString(),decided_at:null,decided_by:null}; db.order_amendments.push(a); olog(c,"amendment_proposed",{amendment:a.id,price_delta_cents:delta,new_deadline:a.new_deadline,note:a.note}); evt(c,"amendment_proposed",delta,a.note); return {data:a.id}; }
      if(fn==="order_amendment_decide"){ const a=db.order_amendments.find(x=>x.id===args.p_amend); if(!a) return {data:"not_found"}; const c=db.contracts.find(x=>x.id===a.order_id&&(x.editor===uid()||x.client===uid())); if(!c) return {data:"not_found"}; if(a.status!=="proposed") return {data:"not_allowed"};
        if(a.proposed_by===uid()){ if(args.p_accept) return {data:"not_allowed"}; a.status="withdrawn"; a.decided_at=new Date().toISOString(); a.decided_by=uid(); olog(c,"amendment_withdrawn",{amendment:a.id}); return {data:"ok"}; }
        if(!args.p_accept){ a.status="declined"; a.decided_at=new Date().toISOString(); a.decided_by=uid(); olog(c,"amendment_declined",{amendment:a.id}); evt(c,"amendment_declined",a.price_delta_cents,a.note); return {data:"ok"}; }
        const n=(c.amendments||0)+1; c.amount_cents+=a.price_delta_cents; c.price=c.amount_cents/100; if(a.new_deadline) c.deadline=a.new_deadline; c.revisions=(c.revisions||0)+a.revisions_add; if(a.scope_add) c.description=(c.description||"")+"\n\nAmendment "+n+": "+a.scope_add; if(a.deliverables_add) c.deliverables=(c.deliverables||"")+"\n"+a.deliverables_add; c.amendments=n;
        let pos=db.order_milestones.filter(m=>m.order_id===c.id).length; (a.milestones||[]).forEach(m=>db.order_milestones.push({id:uuid(),order_id:c.id,position:++pos,title:String(m.title).trim(),amount_cents:Number(m.amount_cents),due:m.due||null,status:"pending",created_at:new Date().toISOString()}));
        a.status="accepted"; a.decided_at=new Date().toISOString(); a.decided_by=uid(); olog(c,"amendment_accepted",{amendment:a.id,price_delta_cents:a.price_delta_cents,price_cents:c.amount_cents,deadline:c.deadline,n}); evt(c,"amendment_accepted",a.price_delta_cents,a.note); return {data:"ok"}; }
      if(fn==="order_bundle"){ const c=db.contracts.find(x=>x.id===args.p_order&&(x.editor===uid()||x.client===uid()||adm())); if(!c) return {data:null}; const ep=db.editor_profiles.find(e=>e.id===c.editor), pe=db.profiles.find(p=>p.id===c.editor), pc=db.profiles.find(p=>p.id===c.client);
        return {data:{order:{...c},milestones:db.order_milestones.filter(m=>m.order_id===c.id).sort((a,b)=>a.position-b.position).map(m=>({...m})),amendments:db.order_amendments.filter(a=>a.order_id===c.id).map(a=>({...a})),events:db.order_events.filter(e=>e.order_id===c.id).map(e=>({id:e.id,actor:e.actor,event:e.event,data:e.data,at:e.created_at})),payments:db.order_payments.filter(p=>p.order_id===c.id).map(p=>({...p})),client_name:pc?pc.first_name:"",freelancer_name:(ep&&ep.display_name)||(pe&&pe.first_name)||""}}; }
      if(fn==="contract_action"){ const c=db.contracts.find(x=>x.id===args.cid&&(x.editor===uid()||x.client===uid())); if(!c) return {data:"not_found"}; const a=args.action, me=uid(); const no={data:"not_allowed"};
        if(a==="accept"){ if(c.status!=="proposed"||c.proposed_by===me) return no; c.status="accepted"; c.accepted_at=new Date().toISOString(); }
        else if(a==="decline"){ if(c.status!=="proposed"||c.proposed_by===me) return no; c.status="declined"; }
        else if(a==="cancel"){ if(!["proposed","accepted"].includes(c.status)) return no; c.status="cancelled"; }
        else if(a==="mark_paid"){ if(c.status!=="accepted"||me!==c.client) return no; c.status="paid_marked"; }
        else if(a==="confirm_paid"){ if(!["accepted","paid_marked"].includes(c.status)||me!==c.editor) return no; c.status="paid"; c.paid_at=new Date().toISOString(); }
        else if(a==="complete"){ if(c.status!=="paid") return no; c.status="completed"; c.completed_at=new Date().toISOString(); }
        else if(a==="deliver"){ if(c.payment_mode!=="escrow"||c.status!=="funded"||me!==c.editor) return no; c.status="delivered"; c.delivered_at=new Date().toISOString(); c.delivery_note=args.note; c.delivery_url=args.link; c.auto_release_at=new Date(Date.now()+7*86400000).toISOString(); }
        else if(a==="request_changes"){ if(c.payment_mode!=="escrow"||c.status!=="delivered"||me!==c.client) return no; c.changes_used=(c.changes_used||0)+1; if(c.changes_used<=(c.revisions||0)){ c.status="funded"; c.auto_release_at=null; } if(args.note) db.messages.push({id:uuid(),conversation_id:c.conversation_id,sender:me,kind:"change_request",body:args.note,created_at:new Date().toISOString()}); }
        else if(a==="dispute"){ if(c.payment_mode!=="escrow"||!["funded","delivered"].includes(c.status)) return no; c.status="disputed"; c.dispute_by=me; c.dispute_reason=args.note; c.disputed_at=new Date().toISOString(); }
        else return {data:"bad_action"};
        evt(c,a); return {data:"ok"}; }
      if(fn==="admin_flag_user"){ if(!adm()) return {data:"forbidden"}; db.user_flags.push({id:uuid(),user_id:args.target,kind:args.kind||"other",reason:args.reason||"",contract_id:args.contract||null,created_by:uid(),created_at:new Date().toISOString()}); return {data:"ok"}; }
      if(fn==="admin_unflag"){ if(!adm()) return {data:"forbidden"}; db.user_flags=db.user_flags.filter(f=>f.id!==args.flag); return {data:"ok"}; }
      if(fn==="admin_list_bad_actors"){ if(!adm()) return {data:[]}; return {data: db.profiles.filter(p=>p.banned||db.user_flags.some(f=>f.user_id===p.id)).map(p=>{ const fl=db.user_flags.filter(f=>f.user_id===p.id).sort((a,b)=>b.created_at.localeCompare(a.created_at)); const e=db.editor_profiles.find(x=>x.id===p.id); const lost=db.contracts.filter(c=>c.disputed_at&&["completed","refunded"].includes(c.status)&&((c.editor===p.id&&c.resolution==="refund")||(c.client===p.id&&c.resolution==="release"))).length; const won=db.contracts.filter(c=>c.disputed_at&&["completed","refunded"].includes(c.status)&&((c.editor===p.id&&c.resolution==="release")||(c.client===p.id&&c.resolution==="refund"))).length; const open=db.contracts.filter(c=>c.status==="disputed"&&(c.editor===p.id||c.client===p.id)).length; return {...p, display_name:e?e.display_name:null, flag_count:fl.length, last_flag:fl[0]?fl[0].created_at:null, disputes_lost:lost, disputes_won:won, disputes_open:open, flags:fl, identifiers:db.user_identifiers.filter(i=>i.user_id===p.id).map(i=>({kind:i.kind,label:i.label,shared:db.user_identifiers.filter(j=>j.kind===i.kind&&j.value_hash===i.value_hash&&j.user_id!==p.id).length}))}; })}; }
      if(fn==="editor_can_receive"){ const p=db.payout_details.find(x=>x.id===args.ed); return {data:!!(p&&p.stripe_payouts_enabled)}; }
      if(fn==="admin_list_contracts"){ if(!adm()) return {data:[]}; return {data: db.contracts.map(c=>({...c, funded_cents:c.funded_cents||0, released_cents:c.released_cents||0, refunded_cents:c.refunded_cents||0, editor_name:(db.editor_profiles.find(e=>e.id===c.editor)||{}).display_name, client_name:(db.profiles.find(p=>p.id===c.client)||{}).first_name})).sort((a,b)=>(b.status==="disputed")-(a.status==="disputed"))}; }
      // ----- reviews that belong to an Order (v22) -----
      if(fn==="review_window_days"){ return {data: (window.__MOCK_REVIEW_DAYS||14)}; }
      if(fn==="my_review_invites"){
        if(!uid()) return {data:[]};
        const out=db.contracts.filter(c=>c.status==="completed" && (c.client===uid()||c.editor===uid()))
          .filter(c=>!db.order_reviews.some(r=>r.order_id===c.id && r.reviewer===uid()))
          .filter(c=>rvDue(c)>Date.now())
          .map(c=>{ const other=c.client===uid()?c.editor:c.client; const pr=db.profiles.find(p=>p.id===other)||{};
            const ep=db.editor_profiles.find(e=>e.id===other);
            return { order_id:c.id, other_id:other, title:c.title, closes_at:new Date(rvDue(c)).toISOString(), other_name:(ep&&ep.display_name)||pr.first_name||"Cuvori" }; });
        return {data: out};
      }
      if(fn==="profile_ratings"){
        const ids=args.p_ids||[]; const out=[];
        ids.forEach(id=>{ const vis=db.order_reviews.filter(r=>r.reviewee===id && rvPublic(r));
          if(vis.length) out.push({ user_id:id, rating:(vis.reduce((s,r)=>s+r.rating,0)/vis.length).toFixed(1), reviews:vis.length }); });
        return {data: out};
      }
      if(fn==="profile_reviews"){
        const id=args.p_user; const vis=db.order_reviews.filter(r=>r.reviewee===id && rvPublic(r)).sort((a,b)=>new Date(b.submitted_at)-new Date(a.submitted_at));
        return {data: { user_id:id, rating: vis.length?(vis.reduce((s,r)=>s+r.rating,0)/vis.length).toFixed(1):null, count:vis.length,
          reviews: vis.map(r=>{ const pr=db.profiles.find(p=>p.id===r.reviewer)||{}; const ep=db.editor_profiles.find(e=>e.id===r.reviewer);
            const c=db.contracts.find(x=>x.id===r.order_id)||{};
            return { id:r.id, rating:r.rating, comment:r.comment, reason:r.low_reason, role:r.reviewer_role, profession:c.profession_slug||null,
                     submitted_at:r.submitted_at, verified:true, who:(ep&&ep.display_name)||pr.first_name||"Cuvori" }; }) }};
      }
      if(fn==="order_review_state"){
        const c=db.contracts.find(x=>x.id===args.p_order); if(!c) return {data:{eligible:false,reason:"not_found"}};
        const me0=uid(); const role=me0===c.client?"client":(me0===c.editor?"freelancer":null);
        if(!role) return {data:{eligible:false,reason:"not_your_order"}};
        const other=role==="client"?c.editor:c.client; const pr=db.profiles.find(p=>p.id===other)||{}; const ep=db.editor_profiles.find(e=>e.id===other);
        const mine=db.order_reviews.find(r=>r.order_id===c.id && r.reviewer===me0)||null;
        const theirs=db.order_reviews.find(r=>r.order_id===c.id && r.reviewer!==me0)||null;
        const shown=!!(theirs && rvPublic(theirs));
        return {data:{ eligible: c.status==="completed" && rvDue(c)>Date.now(), role, status:c.status,
          window_days:(window.__MOCK_REVIEW_DAYS||14), closes_at:new Date(rvDue(c)).toISOString(),
          other_name:(ep&&ep.display_name)||pr.first_name||"Cuvori", other_id:other,
          mine: mine?{ id:mine.id, rating:mine.rating, comment:mine.comment, reason:mine.low_reason, submitted_at:mine.submitted_at, revealed:rvPublic(mine), edits_left:Math.max(0,2-(mine.edits||0)) }:null,
          theirs: shown?{ id:theirs.id, rating:theirs.rating, comment:theirs.comment, reason:theirs.low_reason, submitted_at:theirs.submitted_at }:null,
          theirs_waiting: !!theirs && !shown }};
      }
      if(fn==="order_review_submit"){
        const me0=uid(); if(!me0) return {data:"not_signed_in"};
        const c=db.contracts.find(x=>x.id===args.p_order); if(!c) return {data:"not_found"};
        const role=me0===c.client?"client":(me0===c.editor?"freelancer":null);
        if(!role) return {data:"not_your_order"};
        if(c.status!=="completed") return {data:"review_not_completed"};
        if(rvDue(c)<=Date.now()) return {data:"review_window_closed"};
        const rating=args.p_rating, comment=(args.p_comment||"").trim(); let reason=args.p_reason||null;
        if(!(rating>=1&&rating<=5)) return {data:"bad_rating"};
        if(rating<=3){ if(!reason) return {data:"reason_required"}; if(comment.length<10) return {data:"comment_required"}; }
        else reason=null;
        const allowed=role==="client"?["poor_quality","missed_deadline","poor_communication","scope_not_followed","unprofessional","other"]
                                     :["poor_communication","scope_changes","payment_issue","unreasonable_demands","missing_materials","abusive","other"];
        if(reason && !allowed.includes(reason)) return {data:"bad_reason"};
        let mine=db.order_reviews.find(r=>r.order_id===c.id && r.reviewer===me0);
        if(mine){
          if(rvPublic(mine)) return {data:"review_locked"};
          if((mine.edits||0)>=2) return {data:"review_edit_limit"};
          mine.rating=rating; mine.comment=comment; mine.low_reason=reason; mine.edits=(mine.edits||0)+1;
        } else {
          mine={ id:uuid(), order_id:c.id, reviewer:me0, reviewee:role==="client"?c.editor:c.client, reviewer_role:role,
                 rating, comment, low_reason:reason, submitted_at:new Date().toISOString(), reveal_due:new Date(rvDue(c)).toISOString(),
                 is_revealed:false, revealed_at:null, moderation_status:"visible", moderation_reason:null, edits:0 };
          db.order_reviews.push(mine);
        }
        const other=db.order_reviews.find(r=>r.order_id===c.id && r.reviewer!==me0);
        if(other){ [mine,other].forEach(r=>{ if(!r.is_revealed){ r.is_revealed=true; r.revealed_at=new Date().toISOString(); } }); }
        return {data:"ok"};
      }
      if(fn==="admin_list_order_reviews"){ if(!adm()) return {data:[]};
        return {data: db.order_reviews.filter(r=>!args.p_status||r.moderation_status===args.p_status).map(r=>({...r,
          reviewer_name:(db.profiles.find(p=>p.id===r.reviewer)||{}).first_name||"user",
          reviewee_name:(db.profiles.find(p=>p.id===r.reviewee)||{}).first_name||"user" }))};
      }
      if(fn==="admin_moderate_review"){ if(!adm()) return {data:"forbidden"};
        const r=db.order_reviews.find(x=>x.id===args.p_id); if(!r) return {data:"not_found"};
        if(!["visible","reported","hidden"].includes(args.p_status)) return {data:"bad_status"};
        r.moderation_status=args.p_status; r.moderation_reason=(args.p_reason||"").trim()||null; return {data:"ok"};
      }
      if(fn==="can_review"){ const ed=args.ed; return {data: !!uid() && uid()!==ed && db.profiles.some(p=>p.id===ed&&p.role==="editor") && db.conversations.some(c=>(c.user_a===uid()&&c.user_b===ed)||(c.user_b===uid()&&c.user_a===ed))}; }
      const held=(t)=>db.contracts.some(k=>(k.editor===t||k.client===t)&&["funded","delivered","disputed","releasing","resolving"].includes(k.status));
      if(fn==="delete_my_account"){ if(!uid()) return {data:"not_signed_in"}; if(held(uid())) return {data:"active_payments"}; purge(uid()); return {data:"ok"}; }
      if(fn==="admin_list_users"){ if(!adm()) return {data:[]}; return {data: db.profiles.map(p=>{ const e=db.editor_profiles.find(x=>x.id===p.id); const rv=db.reviews.filter(r=>r.editor===p.id); return {...p, visibility:p.visibility||"public", display_name:e?e.display_name:null, is_public:!!(e&&e.is_public), projects:db.projects.filter(x=>x.owner===p.id).length, reviews:rv.length, avg_stars: rv.length? +(rv.reduce((a,r)=>a+r.stars,0)/rv.length).toFixed(1):null, flags:db.user_flags.filter(f=>f.user_id===p.id).length}; })}; }
      if(fn==="admin_set_ban"){ if(!adm()) return {data:"forbidden"}; if(args.target===uid()) return {data:"cannot_ban_self"}; if(args.ban && String(args.reason||"").trim().length<5) return {data:"bad_reason"}; const p=db.profiles.find(p=>p.id===args.target); p.banned=args.ban; p.ban_reason=args.ban?args.reason:null; return {data:"ok"}; }
      if(fn==="admin_delete_user"){ if(!adm()) return {data:"forbidden"}; if(args.target===uid()) return {data:"cannot_delete_self"}; if(held(args.target)) return {data:"active_payments"}; purge(args.target); return {data:"ok"}; }
      if(fn==="admin_set_role"){ if(!adm()) return {data:"forbidden"}; db.profiles.find(p=>p.id===args.target).role=args.new_role; return {data:"ok"}; }
      if(fn==="admin_create_invite"){ if(!adm()) return {error:{message:"forbidden"}}; const code="CUV-"+Math.random().toString(36).slice(2,6).toUpperCase()+"-"+Math.random().toString(36).slice(2,6).toUpperCase(); invites[code]=null; db.invites.push({code_hash:"h"+code,label:code.slice(0,8)+"****",note:args.note,created_at:new Date().toISOString(),used_at:null,used_by:null,code}); return {data:code}; }
      if(fn==="admin_list_invites"){ if(!adm()) return {data:[]}; return {data: db.invites.map(i=>({...i, used_by_name: i.used_by? (db.profiles.find(p=>p.id===i.used_by)||{}).first_name : null}))}; }
      if(fn==="admin_delete_invite"){ if(!adm()) return {data:"forbidden"}; const i=db.invites.find(x=>x.code_hash===args.hash); if(i&&!i.used_by){ db.invites=db.invites.filter(x=>x!==i); delete invites[i.code]; } return {data:"ok"}; }
      if(fn==="admin_list_reviews"){ if(!adm()) return {data:[]}; return {data: db.reviews.map(r=>({...r, editor_name:(db.editor_profiles.find(e=>e.id===r.editor)||{}).display_name, client_name:(db.profiles.find(p=>p.id===r.client)||{}).first_name}))}; }
      if(fn==="profession_config"){ return {data: professionConfig()}; }
      if(fn==="search_professionals"){ return {data: searchProfessionals(args||{})}; }
      if(fn==="admin_set_visibility"){ if(!adm()) return {data:"not_allowed"}; if(!["public","demo","hidden"].includes(args.v)) return {data:"bad_value"}; const p=db.profiles.find(x=>x.id===args.target); if(!p) return {data:"not_found"}; p.visibility=args.v; return {data:"ok"}; }
      if(fn==="admin_set_profession"){ if(!adm()) return {data:"not_allowed"}; let p=pcfg().professions.find(x=>x.slug===args.p_slug); if(!p){ p={slug:args.p_slug,group_slug:null,sort_order:100,active:false,invite_only:true,pricing_units:["hour","project","day"],portfolio_kind:"video",labels:args.p_labels||{},synonyms:[]}; pcfg().professions.push(p); } if(args.p_active!=null) p.active=args.p_active; if(args.p_invite_only!=null) p.invite_only=args.p_invite_only; if(args.p_sort!=null) p.sort_order=args.p_sort; if(args.p_labels) p.labels=args.p_labels; return {data:"ok"}; }
      if(fn==="admin_set_profession_filter"){ if(!adm()) return {data:"not_allowed"}; if(!pcfg().professions.some(x=>x.slug===args.p_slug)) return {data:"unknown_profession"}; if(!pfDef(args.p_key)) return {data:"unknown_filter"}; const i=pcfg().profession_filters.findIndex(x=>x.profession_slug===args.p_slug&&x.filter_key===args.p_key); if(!args.p_attached){ if(i>=0) pcfg().profession_filters.splice(i,1); return {data:"ok"}; } if(i>=0){ const x=pcfg().profession_filters[i]; if(args.p_sort!=null) x.sort_order=args.p_sort; if(args.p_primary!=null) x.primary_filter=args.p_primary; if(args.p_profile!=null) x.profile_field=args.p_profile; } else pcfg().profession_filters.push({profession_slug:args.p_slug,filter_key:args.p_key,sort_order:args.p_sort??100,primary_filter:!!args.p_primary,profile_field:args.p_profile??true}); return {data:"ok"}; }
      if(fn==="admin_set_filter_option"){ if(!adm()) return {data:"not_allowed"}; const d=pfDef(args.p_key); if(!d||!["multi","single"].includes(d.kind)) return {data:"unknown_filter"}; if(!/^[A-Za-z0-9_]{1,40}$/.test(args.p_option)) return {data:"bad_option"}; if(args.p_remove){ if(db.services.some(s=>(s.values[args.p_key]||[]).includes?.(args.p_option)||s.values[args.p_key]===args.p_option)) return {data:"option_in_use"}; d.options=d.options.filter(o=>o.key!==args.p_option); return {data:"ok"}; } const o=d.options.find(x=>x.key===args.p_option); if(o){ if(args.p_labels) o.labels=args.p_labels; } else d.options.push({key:args.p_option,labels:args.p_labels||{}}); return {data:"ok"}; }
      if(fn==="admin_set_filter_custom"){ if(!adm()) return {data:"not_allowed"}; const d=pfDef(args.p_key); if(!d||d.kind!=="multi") return {data:"unknown_filter"}; d.allow_custom=!!args.p_allow; return {data:"ok"}; }
      if(fn==="admin_upsert_filter"){ if(!adm()) return {data:"not_allowed"}; if(!/^[a-z0-9_]{2,40}$/.test(args.p_key)) return {data:"bad_key"}; if(!["multi","single","bool","range","tags"].includes(args.p_kind)) return {data:"bad_kind"}; let d=pfDef(args.p_key); if(!d){ d={key:args.p_key,kind:args.p_kind,match:args.p_match||"any",options:[],min_value:args.p_min??null,max_value:args.p_max??null,unit:args.p_unit||null,labels:args.p_labels||{}}; pcfg().filters.push(d); } else { if(args.p_labels) d.labels=args.p_labels; if(args.p_match) d.match=args.p_match; if(args.p_min!=null) d.min_value=args.p_min; if(args.p_max!=null) d.max_value=args.p_max; if(args.p_unit) d.unit=args.p_unit; } return {data:"ok"}; }
      if(fn==="set_availability"){ if(!uid()) return {data:"not_signed_in"};
        if(!["open","busy","closed"].includes(args.p_status)) return {data:"bad_status"};
        const e=db.editor_profiles.find(e=>e.id===uid()); if(!e) return {data:"no_profile"};
        e.availability=args.p_status; e.free_from=args.p_status==="busy"?(args.p_free_from||null):null;
        e.availability_set_at=new Date().toISOString(); e.last_active_on=new Date().toISOString().slice(0,10);
        return {data:"ok"}; }
      if(fn==="touch_activity"){ if(!uid()) return {data:"not_signed_in"}; const pr=db.profiles.find(p=>p.id===uid()); if(pr) pr.last_seen_at=new Date().toISOString(); const e=db.editor_profiles.find(e=>e.id===uid()); if(e) e.last_active_on=new Date().toISOString().slice(0,10); return {data:"ok"}; }
      if(fn==="accept_rules"){ if(!uid()) return {data:"not_signed_in"}; if(!/^[0-9]{4}-[0-9]{2}$/.test(String(args.v||""))) return {data:"bad_version"}; const p=db.profiles.find(p=>p.id===uid()); if(p){ p.rules_version=args.v; p.rules_accepted_at=new Date().toISOString(); } return {data:"ok"}; }
      if(fn==="submit_report"){ if(!uid()) return {data:"not_signed_in"};
        const body=String(args.p_body||"").trim();
        if(body.length<10||body.length>4000) return {data:"bad_body"};
        if(!["illegal","rights","scam","abuse","fake","other"].includes(args.p_kind)) return {data:"bad_kind"};
        if(!["profile","job","review","message","contract","other"].includes(args.p_target_kind||"other")) return {data:"bad_kind"};
        if(String(args.p_target_id||"").length>200) return {data:"bad_target"};
        db.reports=db.reports||[]; db.reports.push({id:uuid(),reporter:uid(),kind:args.p_kind,target_kind:args.p_target_kind||"other",target_id:args.p_target_id||"",body,status:"open",outcome:null,created_at:new Date().toISOString()});
        // deliver it to every admin as a real message, the way schema_v14 does
        const header="Report · "+args.p_kind+" · "+(args.p_target_kind||"other")+(args.p_target_id?" ("+String(args.p_target_id).slice(0,60)+")":"");
        db.profiles.filter(x=>x.is_admin && x.id!==uid() && !x.banned).forEach(adm=>{
          let c=db.conversations.find(c=>[c.user_a,c.user_b].includes(adm.id) && [c.user_a,c.user_b].includes(uid()));
          if(!c){ const [a,b]=[uid(),adm.id].sort(); c={id:uuid(),user_a:a,user_b:b,last_message_at:new Date().toISOString()}; db.conversations.push(c); }
          const msg={id:uuid(),conversation_id:c.id,sender:uid(),kind:"text",body:header+"\n"+body,created_at:new Date().toISOString()};
          db.messages.push(msg); c.last_message_at=msg.created_at;
          setTimeout(()=>channels.forEach(ch=>ch.fire("INSERT","messages",msg)),0);
        });
        return {data:"ok"}; }
      // ---------- v20 rpcs ----------
      if(fn==="setting"){ return {data:SETTINGS[args.p_key]||null}; }
      if(fn==="admin_set_setting"){ if(!adm()) return {data:"forbidden"}; if(!/^[a-z_]{1,40}$/.test(String(args.p_key||""))||!args.p_value||JSON.stringify(args.p_value).length>5000) return {data:"bad_input"}; SETTINGS[args.p_key]=args.p_value; return {data:"ok"}; }
      if(fn==="identity_state"){ return {data:identityState(args.uid)}; }
      if(fn==="is_verified"){ return {data:isVerified(args.uid)}; }
      if(fn==="client_stats"){ return {data:clientStats(args.uid)}; }
      if(fn==="job_payment_secured"){ return {data:jobSecured(args.p_job)}; }
      if(fn==="browse_jobs"){ fillJobs(); const rows=db.jobs.filter(j=>jobOpenNow(j)&&listedOwner(j.owner)).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).slice(0,Math.min(Math.max(args.p_limit||200,1),500)).map(j=>{ const o={...j}; delete o.fingerprint; delete o.risk_score; delete o.risk_flags; delete o.hidden_reason; delete o.report_count; o.owner_name=(db.profiles.find(p=>p.id===j.owner)||{}).first_name||""; o.client=clientStats(j.owner); o.payment_secured=jobSecured(j.id); return o; }); return {data:rows}; }
      if(fn==="my_jobs"){ if(!uid()) return {data:[]}; fillJobs(); return {data:db.jobs.filter(j=>j.owner===uid()).sort((a,b)=>new Date(b.created_at)-new Date(a.created_at)).map(j=>({ id:j.id, title:j.title, status:(j.status==="open"&&j.expires_at&&new Date(j.expires_at)<new Date())?"expired":j.status, created_at:j.created_at, expires_at:j.expires_at||null, renewed_count:j.renewed_count||0, hidden_reason:j.hidden_reason||null, report_count:j.report_count||0, budget:j.budget||"", profession_slug:j.profession_slug, hires:db.contracts.filter(c=>c.job_id===j.id&&HIRE_ST.includes(c.status)).length, payment_secured:jobSecured(j.id) }))}; }
      if(fn==="set_job_status"){ if(!uid()) return {data:"not_signed_in"}; const j=db.jobs.find(x=>x.id===args.p_job&&x.owner===uid()); if(!j) return {data:"not_found"}; const st=args.p_status; if(!["filled","closed","open"].includes(st)) return {data:"bad_input"}; if(["hidden","removed"].includes(j.status)) return {data:"under_review"}; if(st==="open"&&!["filled","closed","expired"].includes(j.status)) return {data:"not_allowed"};
        if(st==="open"){ j.status="open"; j.closed_at=null; j.expires_at=new Date(Date.now()+SETTINGS.posting_rules.expiry_days*86400000).toISOString(); j.renewed_count=(j.renewed_count||0)+1; j.last_renewed_at=new Date().toISOString(); } else { j.status=st; j.closed_at=new Date().toISOString(); } return {data:"ok"}; }
      if(fn==="renew_job"){ if(!uid()) return {data:"not_signed_in"}; const j=db.jobs.find(x=>x.id===args.p_job&&x.owner===uid()); if(!j) return {data:"not_found"}; if(!["open","expired"].includes(j.status)) return {data:"not_allowed"}; if((j.renewed_count||0)>=12) return {data:"too_many_renewals"}; j.status="open"; j.expires_at=new Date(Date.now()+SETTINGS.posting_rules.expiry_days*86400000).toISOString(); j.renewed_count=(j.renewed_count||0)+1; j.last_renewed_at=new Date().toISOString(); return {data:"ok"}; }
      if(fn==="expire_jobs"){ return {error:{message:"permission denied for function expire_jobs"}}; }
      if(fn==="report_job"){ const m=uid(); if(!m) return {data:"not_signed_in"}; if((me()||{}).banned) return {data:"banned"}; if(!["scam","fake","spam","duplicate","payment","inappropriate","other"].includes(args.p_reason)) return {data:"bad_input"}; if(String(args.p_note||"").length>1000) return {data:"note_too_long"}; const j=db.jobs.find(x=>x.id===args.p_job); if(!j||j.owner===m) return {data:"not_found"};
        const ex=db.job_reports.find(r=>r.job_id===j.id&&r.reporter===m); if(ex){ ex.reason=args.p_reason; ex.note=args.p_note||""; ex.created_at=new Date().toISOString(); } else db.job_reports.push({ id:uuid(), job_id:j.id, reporter:m, reason:args.p_reason, note:args.p_note||"", created_at:new Date().toISOString() });
        const n=new Set(db.job_reports.filter(r=>r.job_id===j.id).map(r=>r.reporter)).size; j.report_count=n; const f=db.job_flags.find(x=>x.job_id===j.id&&x.kind==="reports"&&x.status==="open"); if(f){ f.detail={reports:n}; f.score=n>=3?3:1; } else db.job_flags.push({ id:db.job_flags.length+1, job_id:j.id, kind:"reports", detail:{reports:n}, score:n>=3?3:1, status:"open", created_at:new Date().toISOString() }); return {data:"ok"}; }
      if(fn==="admin_job_queue"){ if(!adm()) return {data:[]}; const rows=db.jobs.filter(j=>j.status==="hidden"||db.job_flags.some(f=>f.job_id===j.id&&f.status==="open")).map(j=>{ const p=db.profiles.find(x=>x.id===j.owner)||{}; const flags=db.job_flags.filter(f=>f.job_id===j.id&&f.status==="open").map(f=>({id:f.id,kind:f.kind,detail:f.detail,score:f.score,at:f.created_at})); const o={...j}; delete o.fingerprint;
          return { job:o, owner_name:p.first_name||"", owner_email:p.email||"", owner_banned:!!p.banned, client:clientStats(j.owner), flags, score:flags.reduce((a,f)=>a+f.score,0), last_flag:flags.length?flags[flags.length-1].at:null,
            reports:db.job_reports.filter(r=>r.job_id===j.id).map(r=>({reason:r.reason,note:r.note,at:r.created_at,reporter:(db.profiles.find(x=>x.id===r.reporter)||{}).first_name||""})),
            history:db.jobs.filter(x=>x.owner===j.owner&&x.id!==j.id).slice(0,10).map(x=>({id:x.id,title:x.title,status:x.status,at:x.created_at})),
            actions:db.moderation_actions.filter(m=>m.job_id===j.id).map(m=>({action:m.action,reason:m.reason,at:m.created_at})) }; }).sort((a,b)=>b.score-a.score); return {data:rows}; }
      if(fn==="admin_job_action"){ if(!adm()) return {data:"forbidden"}; const j=db.jobs.find(x=>x.id===args.p_job); if(!j) return {data:"not_found"}; const a=args.p_action; if(!["approve","hide","remove","warn","suspend","false_positive","unhide"].includes(a)) return {data:"bad_input"}; const reason=String(args.p_reason||"").slice(0,1000); const resolve=()=>db.job_flags.filter(f=>f.job_id===j.id&&f.status==="open").forEach(f=>{ f.status="resolved"; f.resolved_at=new Date().toISOString(); f.resolved_by=uid(); });
        if(a==="approve"||a==="false_positive"){ resolve(); if(j.status==="hidden"){ j.status="open"; j.hidden_reason=null; } }
        else if(a==="hide"){ if(!reason) return {data:"reason_required"}; j.status="hidden"; j.hidden_reason=reason; }
        else if(a==="unhide"){ j.status="open"; j.hidden_reason=null; }
        else if(a==="remove"){ if(!reason) return {data:"reason_required"}; j.status="removed"; j.hidden_reason=reason; j.closed_at=new Date().toISOString(); resolve(); }
        else if(a==="warn"){ if(!reason) return {data:"reason_required"}; const [x,y]=[uid(),j.owner].sort(); let c=db.conversations.find(v=>v.user_a===x&&v.user_b===y); if(!c){ c={id:uuid(),user_a:x,user_b:y,created_at:new Date().toISOString(),last_message_at:new Date().toISOString()}; db.conversations.push(c); } const msg={id:uuid(),conversation_id:c.id,sender:uid(),kind:"text",body:'About your job "'+j.title.slice(0,80)+'": '+reason,created_at:new Date().toISOString()}; db.messages.push(msg); c.last_message_at=msg.created_at; setTimeout(()=>channels.forEach(ch=>ch.fire("INSERT","messages",msg)),0); }
        else if(a==="suspend"){ if(reason.length<5) return {data:"reason_required"}; const p=db.profiles.find(x=>x.id===j.owner); if(p){ p.banned=true; p.ban_reason=reason; } db.jobs.filter(x=>x.owner===j.owner&&x.status==="open").forEach(x=>{ x.status="hidden"; x.hidden_reason="account_suspended"; }); }
        db.moderation_actions.push({ id:db.moderation_actions.length+1, job_id:j.id, target_user:j.owner, admin:uid(), action:a, reason, created_at:new Date().toISOString() }); return {data:"ok"}; }
      if(fn==="admin_set_identity"){ if(!adm()) return {data:"forbidden"}; if(!["none","pending","verified","failed"].includes(args.p_status)) return {data:"bad_input"}; const v=db.identity_verifications.find(x=>x.user_id===args.p_user); if(v){ v.status=args.p_status; v.provider="admin"; v.checked_at=new Date().toISOString(); } else db.identity_verifications.push({ user_id:args.p_user, provider:"admin", status:args.p_status, checked_at:new Date().toISOString(), updated_at:new Date().toISOString() }); db.moderation_actions.push({ id:db.moderation_actions.length+1, job_id:null, target_user:args.p_user, admin:uid(), action:"identity_"+args.p_status, reason:String(args.p_note||"").slice(0,500), created_at:new Date().toISOString() }); return {data:"ok"}; }
      if(fn==="admin_open_reports"){ return {data: adm() ? (db.reports||[]).filter(r=>r.status==="open").length : 0}; }
      if(fn==="my_reports"){ return {data:(db.reports||[]).filter(r=>r.reporter===uid())}; }
      if(fn==="admin_list_reports"){ if(!adm()) return {data:[]}; return {data:(db.reports||[]).filter(r=>args.p_status==="all"||r.status===(args.p_status||"open"))}; }
      if(fn==="admin_resolve_report"){ if(!adm()) return {data:"not_allowed"}; if(!["actioned","rejected"].includes(args.p_status)) return {data:"bad_status"}; const o=String(args.p_outcome||"").trim(); if(o.length<5||o.length>2000) return {data:"bad_outcome"}; const r=(db.reports||[]).find(x=>x.id===args.p_id); if(!r) return {data:"not_found"}; r.status=args.p_status; r.outcome=o; r.handled_at=new Date().toISOString(); return {data:"ok"}; }
      return {data:null,error:{message:"unknown rpc"}};
    },
    channel(name){ const ch={ handlers:[], on(ev,cfg,fn){ ch.handlers.push({cfg,fn}); return ch; }, subscribe(){ channels.push(ch); return ch; }, fire(event,table,row){ ch.handlers.forEach(h=>{ if(h.cfg.table===table && h.cfg.event===event){ const f=h.cfg.filter; if(!f || f===`conversation_id=eq.${row.conversation_id}`) h.fn({new:row}); } }); } }; return ch; },
    removeChannel(ch){ const i=channels.indexOf(ch); if(i>=0) channels.splice(i,1); },
    storage:{ from(){ return { async upload(path){ return {error:null,data:{path}}; }, getPublicUrl(path){ return {data:{publicUrl:"https://storage.test/"+path}}; } }; } }
  };
  // tests may pre-load rows: window.__MOCK_SEED = { profiles:[…], editor_profiles:[…], services:[…] }
  if(window.__MOCK_SEED){ for(const [k,v] of Object.entries(window.__MOCK_SEED)){ if(Array.isArray(db[k]) && Array.isArray(v)) db[k].push(...v); } }
  window.__mockdb = db;
  window.__sb = client;   // tests poke the mock API directly
  window.__mockEscrow = false; const FAKE_STRIPE={ transfers:[], refunds:[] }; window.__fakeStripe=FAKE_STRIPE;
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, init={}) => {
    const u=String(url); if(!u.includes("/.netlify/functions/")) return realFetch(url, init);
    const name=u.split("/.netlify/functions/")[1].split("?")[0]; const body=init.body?JSON.parse(init.body):{}; const method=init.method||"GET";
    const res=(status,data)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}});
    const me=uid()?db.profiles.find(p=>p.id===uid()):null;
    if(name==="stripe-status") return res(200,{escrow:window.__mockEscrow,autoReleaseDays:7});
    if(!window.__mockEscrow) return res(503,{error:"Escrow payments are not configured yet"});
    if(!me) return res(401,{error:"Sign in first"});
    if(name==="stripe-connect"){ if(me.role!=="editor") return res(403,{error:"Only editors"}); let p=db.payout_details.find(x=>x.id===me.id); if(method==="GET") return res(200,{connected:!!(p&&p.stripe_account_id),payouts_enabled:!!(p&&p.stripe_payouts_enabled)}); if(!p){ p={id:me.id,methods:[],note:""}; db.payout_details.push(p);} p.stripe_account_id=p.stripe_account_id||"acct_"+me.id.slice(0,6); p.stripe_payouts_enabled=true; /* pretend onboarding completes instantly */ return res(200,{url:"#settings?stripe=return"}); }
    const olog2=(c,ev,data,actor)=>db.order_events.push({id:db.order_events.length+1,order_id:c.id,actor:actor===undefined?me.id:actor,event:ev,data:data||{},created_at:new Date().toISOString()});
    const oheld2=c=>Math.max((c.funded_cents||0)-(c.released_cents||0)-(c.refunded_cents||0),0);
    if(name==="stripe-checkout"){ const c=db.contracts.find(x=>x.id===body.contract_id); if(!c||c.client!==me.id) return res(403,{error:"Not your order"}); let amount,kind; if(c.status==="accepted"){ amount=c.amount_cents; kind="fund"; } else if(["funded","delivered"].includes(c.status)&&c.amount_cents>(c.funded_cents||0)){ amount=c.amount_cents-(c.funded_cents||0); kind="topup"; } else return res(409,{error:"This order is not waiting for payment"}); const p=db.payout_details.find(x=>x.id===c.editor); if(!p||!p.stripe_payouts_enabled) return res(409,{error:"The freelancer has not finished setting up payouts yet"});
      const quote=(await client.rpc("order_quote",{p_price_cents:amount,p_currency:"EUR",p_country:null,p_customer:"any",p_method:"card"})).data; const fee=quote?quote.processing_cents:0; const total=amount+fee; FAKE_STRIPE.charges=FAKE_STRIPE.charges||[]; FAKE_STRIPE.charges.push({contract:c.id,amount,fee,total,kind});
      /* simulate the webhook right away */ if(kind==="fund"){ c.fee_cents=fee; c.quote=quote; c.status="funded"; c.funded_at=new Date().toISOString(); c.funded_cents=amount; c.stripe_payment_intent="pi_"+c.id.slice(0,6); } else c.funded_cents+=amount;
      db.order_payments.push({id:uuid(),order_id:c.id,milestone_id:null,kind:"fund",amount_cents:amount,fee_cents:fee,provider:"stripe",provider_ref:"pi_"+uuid().slice(0,6),status:"succeeded",note:kind,created_at:new Date().toISOString()}); olog2(c,kind==="fund"?"funded":"topped_up",{amount_cents:amount,fee_cents:fee,total_cents:total},c.client); evt(c,"funded",amount); return res(200,{url:"#orders?paid="+c.id,amount,fee,total,cuvori_fee:0,kind}); }
    if(name==="stripe-confirm"){ const c=db.contracts.find(x=>x.id===body.contract_id); if(!c||(c.client!==me.id&&c.editor!==me.id)) return res(403,{error:"Not your order"}); return res(200,{status:c.status,funded_cents:c.funded_cents||0,checked:true,result:c.status==="accepted"?"unpaid":"already"}); }
    if(name==="stripe-cancel"){ const c=db.contracts.find(x=>x.id===body.contract_id); if(!c||c.editor!==me.id) return res(403,{error:"Not your order"}); if(!["funded","delivered"].includes(c.status)||!oheld2(c)) return res(409,{error:"This order cannot be cancelled right now"}); const held=oheld2(c); FAKE_STRIPE.refunds.push({contract:c.id,amount:held}); c.refunded_cents=(c.refunded_cents||0)+held; c.status="refunded"; c.resolution="refund"; c.closed_at=new Date().toISOString(); db.order_milestones.filter(m=>m.order_id===c.id).forEach(m=>m.auto_release_at=null); db.order_payments.push({id:uuid(),order_id:c.id,kind:"refund",amount_cents:held,fee_cents:0,provider:"stripe",provider_ref:"re_x",status:"succeeded",note:"cancel_refund",created_at:new Date().toISOString()}); olog2(c,"cancelled",{by:"freelancer",refund_cents:held}); olog2(c,"refunded",{refund_cents:held}); evt(c,"cancel_refund",held); return res(200,{ok:true,status:c.status,refunded:held}); }
    if(name==="stripe-release"){ const c=db.contracts.find(x=>x.id===body.contract_id); if(!c||c.client!==me.id) return res(403,{error:"Not your order"}); if(!["funded","delivered"].includes(c.status)) return res(409,{error:"nothing to release"});
      if(body.milestone_id){ const m=db.order_milestones.find(x=>x.id===body.milestone_id&&x.order_id===c.id); if(!m||!["submitted","approved"].includes(m.status)) return res(409,{error:"This milestone is not waiting for approval"}); if(m.amount_cents>oheld2(c)) return res(409,{error:"Not enough money is held for this milestone"}); FAKE_STRIPE.transfers.push({contract:c.id,milestone:m.id,amount:m.amount_cents}); m.status="released"; m.released_at=new Date().toISOString(); m.transfer_ref="tr_"+m.id.slice(0,6); m.auto_release_at=null; c.released_cents=(c.released_cents||0)+m.amount_cents; c.changes_open=false; db.order_payments.push({id:uuid(),order_id:c.id,milestone_id:m.id,kind:"release",amount_cents:m.amount_cents,fee_cents:0,provider:"stripe",provider_ref:m.transfer_ref,status:"succeeded",note:"approve",created_at:new Date().toISOString()}); olog2(c,"milestone_released",{milestone:m.id,title:m.title,amount_cents:m.amount_cents}); evt(c,"milestone_approved",m.amount_cents,m.title);
        if(!db.order_milestones.some(x=>x.order_id===c.id&&x.status!=="released")){ c.status="completed"; c.completed_at=new Date().toISOString(); olog2(c,"completed",{}); evt(c,"complete"); } return res(200,{ok:true,transfer:m.transfer_ref,released:m.amount_cents}); }
      if(c.has_milestones) return res(409,{error:"This order is released milestone by milestone"}); const cents=oheld2(c); FAKE_STRIPE.transfers.push({contract:c.id,amount:cents}); c.released_cents=(c.released_cents||0)+cents; c.status="completed"; c.completed_at=new Date().toISOString(); c.resolution="release"; c.split_editor_cents=cents; db.order_payments.push({id:uuid(),order_id:c.id,kind:"release",amount_cents:cents,fee_cents:0,provider:"stripe",provider_ref:"tr_"+c.id.slice(0,6),status:"succeeded",note:"approve",created_at:new Date().toISOString()}); olog2(c,"released",{editor_cents:cents}); evt(c,"approve",cents); return res(200,{ok:true,released:cents}); }
    if(name==="stripe-resolve"){ if(!me.is_admin) return res(403,{error:"Admins only"}); const c=db.contracts.find(x=>x.id===body.contract_id); if(!c||!["funded","delivered","disputed"].includes(c.status)) return res(409,{error:"not holding"}); const total=oheld2(c)||c.amount_cents; let ed=0; if(body.decision==="release") ed=total; else if(body.decision==="split") ed=Math.round(total*body.editor_percent/100); const rf=total-ed; if(ed) FAKE_STRIPE.transfers.push({contract:c.id,amount:ed}); if(rf) FAKE_STRIPE.refunds.push({contract:c.id,amount:rf}); const wasDisputed=c.status==="disputed"; c.status=ed?"completed":"refunded"; c.resolution=body.decision; c.split_editor_cents=ed; c.released_cents=(c.released_cents||0)+ed; c.refunded_cents=(c.refunded_cents||0)+rf; olog2(c,"resolved",{editor_cents:ed,refund_cents:rf,decision:body.decision}); evt(c,"resolved_"+body.decision); if(wasDisputed){ const loser=body.decision==="refund"?c.editor:body.decision==="release"?c.client:null; if(loser) db.user_flags.push({id:uuid(),user_id:loser,kind:"dispute_lost",reason:"Lost dispute on \""+c.title+"\"",contract_id:c.id,created_by:me.id,created_at:new Date().toISOString()}); } if(body.note) db.messages.push({id:uuid(),conversation_id:c.conversation_id,sender:me.id,kind:"text",body:"Cuvori decision: "+body.note,created_at:new Date().toISOString()}); return res(200,{ok:true}); }
    return res(404,{error:"unknown function"});
  };
  window.supabase = { createClient(){ return client; } };
  const cfg={supabaseUrl:"https://x.supabase.co",supabaseAnonKey:"key"}; Object.defineProperty(window,"CUVORI_CONFIG",{get(){return cfg;},set(v){ if(v&&typeof v==="object") for(const k in v){ if(k!=="supabaseUrl"&&k!=="supabaseAnonKey") cfg[k]=v[k]; } }});   // the page's own flags (facebookLogin…) flow through; the keys stay fake
})();
