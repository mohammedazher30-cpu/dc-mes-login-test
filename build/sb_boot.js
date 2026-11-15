/* ================= Supabase connection (test MES) ================= */
const SB=supabase.createClient("https://iccutmlawnnldkqxstmw.supabase.co","sb_publishable_Dmq8eav0yxwH5N64kSjYEw_aw8vxTTs");
const SB_ROLE={admin:"admin",exec:"exec",pm:"pm",manager:"manager",supervisor:"supervisor",storekeeper:"storekeeper",team_leader:"operator"};
let sbSnap={task:{},mach:{}},sbBooting=false,sbLastSync=null,sbMap={ws:{},mach:{},op:{},machCode:{}};
window.ZOHO_IMPORT=[]; /* projects and tasks come from Supabase */
const sbTaskKey=k=>JSON.stringify([k.status,k.doneAt||null,k.doneBy||"",k.zohoPct||0]);
const sbMachKey=m=>JSON.stringify([m.state||"run",m.reason||""]);
async function sbAll(q){let out=[],from=0;for(;;){const {data,error}=await q().range(from,from+999);if(error)throw error;out=out.concat(data);if(data.length<1000)return out;from+=1000}}

/* ---- part 2: projects, tasks, dependencies ---- */
async function sbLoadProjects(){
  const [r1,r2,r3]=await Promise.all([
    SB.from("project").select("id,code,name,event_date,status,source,zoho_project_id,zoho_rev,venue,customer:customer_id(name)"),
    SB.from("project_task").select("id,project_id,task_no,name,type,team,start_date,end_date,status,zoho_pct,note,done_at,done_by"),
    SB.from("task_dependency").select("task_id,depends_on")]);
  const err=r1.error||r2.error||r3.error;if(err)throw err;
  ensureTasks();ensureZoho();
  const pid={},tid={};
  const P=r1.data.map(p=>{const zid=p.zoho_project_id||p.code;const ex=db.projects.find(x=>x.sbId===p.id||(x.zohoId&&x.zohoId===zid));
    const id=ex?ex.id:"P-"+String(++db.seq.proj).padStart(3,"0");pid[p.id]=id;
    return Object.assign(ex||{},{id,sbId:p.id,name:p.name,customer:(p.customer&&p.customer.name)||"",venue:p.venue||(ex&&ex.venue)||"",eventDate:p.event_date,status:p.status,source:p.source,zohoId:zid,zRev:p.zoho_rev||1})});
  const keep=new Set(P.map(p=>p.id));
  const localMes=db.projects.filter(p=>!keep.has(p.id)&&p.source==="mes"&&!p.sbId);
  const dropped=new Set(db.projects.filter(p=>!keep.has(p.id)&&!localMes.includes(p)).map(p=>p.id));
  const T=r2.data.map(x=>{const p=pid[x.project_id];const ex=db.tasks.find(k=>k.sbId===x.id||(k.project===p&&k.no===x.task_no));
    const id=ex?ex.id:"T-"+String(++db.seq.task).padStart(3,"0");tid[x.id]=id;
    return Object.assign(ex||{wos:[]},{id,sbId:x.id,project:p,no:x.task_no,name:x.name,type:x.type,team:x.team,start:x.start_date,end:x.end_date,
      status:x.status==="in progress"?"inprog":x.status,zohoPct:x.zoho_pct||0,note:x.note||"",doneAt:x.done_at,doneBy:x.done_by||""})});
  T.forEach(k=>{const sid=k.sbId;k.deps=r3.data.filter(d=>d.task_id===sid).map(d=>tid[d.depends_on]).filter(Boolean);k.wos=k.wos||[]});
  db.projects=P.concat(localMes);
  db.tasks=T.concat(db.tasks.filter(k=>!k.sbId&&!dropped.has(k.project)&&!keep.has(k.project)));
  if(dropped.size){const goneWO=new Set(db.workorders.filter(w=>dropped.has(w.project)).map(w=>w.id));
    db.workorders=db.workorders.filter(w=>!goneWO.has(w.id));db.shipments=(db.shipments||[]).filter(s=>!dropped.has(s.project));
    db.executions=(db.executions||[]).filter(e=>!goneWO.has(e.wo));db.consumption=(db.consumption||[]).filter(c=>!goneWO.has(c.wo));
    db.articles.forEach(a=>{if(a.project&&dropped.has(a.project))a.project=""})}
  db.purge1=true;db.zNew1=true;
  sbSnap.task={};db.tasks.forEach(k=>{if(k.sbId)sbSnap.task[k.sbId]=sbTaskKey(k)});
  return {p:P.length,t:T.length,d:r3.data.length};
}

/* ---- part 3: master data ---- */
async function sbLoadMaster(){
  const [w,m,a,o,c,r,arts]=await Promise.all([
    SB.from("workshop").select("id,code,name,kmp_code").order("code"),
    SB.from("machine").select("id,code,name,state,stop_reason,workshop:workshop_id(code)"),
    SB.from("asset").select("id,code,name,model,description,status,photo_url,workshop:workshop_id(code),station:station_id(code)").order("code"),
    SB.from("operator").select("id,code,name,skills,workshop:workshop_id(code),machine:machine_id(code)"),
    SB.from("raw_catalog").select("code,name").order("code"),
    SB.from("stop_reason").select("category,name_en,name_ar,sort").order("sort"),
    sbAll(()=>SB.from("article").select("id,code,name,unit,stock,min_stock,max_stock,item_group,family,source,catalog:catalog_id(code)").eq("type","raw material").order("code"))]);
  const err=[w,m,a,o,c,r].map(x=>x.error).find(Boolean);if(err)throw err;
  /* workshops: keep the demo's order, take names from Supabase */
  const order=(db.workshops||[]).map(x=>x.id);
  db.workshops=w.data.map(x=>{sbMap.ws[x.id]=x.code;const ex=(db.workshops||[]).find(y=>y.id===x.code)||{};return Object.assign(ex,{id:x.code,name:x.name,code:x.code,sbId:x.id})})
    .sort((a,b)=>{const i=order.indexOf(a.id),j=order.indexOf(b.id);return (i<0?99:i)-(j<0?99:j)});
  /* stations (machines in the demo) */
  db.machines=m.data.map(x=>{sbMap.mach[x.id]=x.code;sbMap.machCode[x.code]=x.id;const ex=(db.machines||[]).find(y=>y.id===x.code)||{};
    return Object.assign(ex,{id:x.code,ws:x.workshop&&x.workshop.code,name:x.name,state:x.state||"run",reason:x.stop_reason||"",sbId:x.id})});
  applyPhotos();
  sbSnap.mach={};db.machines.forEach(x=>sbSnap.mach[x.id]=sbMachKey(x));
  /* physical machines */
  db.assets=a.data.map(x=>({id:x.code,name:x.name,ws:x.workshop&&x.workshop.code,op:x.station&&x.station.code,model:x.model||"",desc:x.description||"",status:x.status,sbId:x.id}));
  /* team leaders */
  db.operators=o.data.map(x=>{const ex=(db.operators||[]).find(y=>(x.code&&y.code===x.code)||y.name===x.name);
    const id=ex?ex.id:"OP-"+x.code;sbMap.op[x.id]=id;
    return Object.assign(ex||{},{id,name:x.name,ws:x.workshop&&x.workshop.code,machine:x.machine&&x.machine.code,skills:x.skills||"",code:/^TL-/.test(x.code)?"":x.code,sbId:x.id})});
  /* raw material catalogs + raw materials (stock figures stay local until the Zoho Inventory stock sync is built) */
  db.rawCatalogs=c.data.map(x=>({id:x.code,name:x.name}));
  const local=new Map(db.articles.filter(x=>x.type==="raw").map(x=>[x.id,x]));
  const raws=arts.map(x=>{const ex=local.get(x.code)||{};return Object.assign(ex,{id:x.code,name:x.name,type:"raw",unit:x.unit||ex.unit||"pcs",
    stock:ex.stock!=null?ex.stock:(+x.stock||0),minStock:ex.minStock!=null?ex.minStock:(+x.min_stock||0),maxStock:ex.maxStock!=null?ex.maxStock:(+x.max_stock||0),
    catalog:x.catalog&&x.catalog.code,family:"raw material",group:x.item_group||"",src:"zinv",sbId:x.id})});
  db.articles=db.articles.filter(x=>x.type!=="raw").concat(raws);
  /* stop reasons */
  if(r.data.length){const g={};r.data.forEach(x=>{(g[x.category]=g[x.category]||[]).push(x.name_en);if(x.name_ar&&T.ar)T.ar[x.name_en]=x.name_ar});
    REASON_GROUPS.length=0;["Planned","Equipment","Material","People","Process","Quality","Flow"].forEach(k=>{if(g[k])REASON_GROUPS.push([k,g[k]])});
    REASONS.length=0;REASON_GROUPS.forEach(x=>x[1].forEach(n=>REASONS.push(n)))}
  return {w:w.data.length,m:m.data.length,a:a.data.length,o:o.data.length,raw:raws.length};
}

/* push changes made in the MES back to Supabase: task status, station state */
const _sbPersist=persist;
persist=function(){const r=_sbPersist();if(!me||sbBooting)return r;
  (db.tasks||[]).filter(k=>k.sbId&&sbSnap.task[k.sbId]!==sbTaskKey(k)).forEach(k=>{sbSnap.task[k.sbId]=sbTaskKey(k);
    SB.from("project_task").update({status:k.status==="inprog"?"in progress":k.status,done_at:k.doneAt||null,done_by:k.doneBy||null,zoho_pct:Math.round(k.zohoPct||0)}).eq("id",k.sbId)
      .then(({error})=>{if(error){delete sbSnap.task[k.sbId];toast("Could not save task to Supabase")}})});
  (db.machines||[]).filter(x=>x.sbId&&sbSnap.mach[x.id]!==sbMachKey(x)).forEach(x=>{sbSnap.mach[x.id]=sbMachKey(x);
    SB.from("machine").update({state:["run","stopped","out"].includes(x.state)?x.state:"run",stop_reason:x.reason||null}).eq("id",x.sbId)
      .then(({error})=>{if(error){delete sbSnap.mach[x.id];toast("Could not save station state to Supabase")}})});
  return r};

async function sbProfileToMe(){
  const {data,error}=await SB.rpc("my_profile");
  if(error)return null;
  if(!data||!data.length)return false;
  const p=data[0];
  const {data:row}=await SB.from("app_user").select("workshop_ids,operator_id").eq("id",p.id).maybeSingle();
  return {id:p.id,name:p.full_name,email:p.email,role:SB_ROLE[p.role]||"operator",wsIds:(row&&row.workshop_ids)||[],opId:row&&row.operator_id,ws:[],op:"",sb:true};
}
async function sbBoot(){
  if(sbBooting)return;sbBooting=true;
  try{
    const {data}=await SB.auth.getSession();
    if(!data.session){me=null;sbBooting=false;render();return}
    const u=await sbProfileToMe();
    if(u===false){await SB.auth.signOut({scope:"local"});me=null;sbBooting=false;ui.sbMsg="Your account is not active in the MES. Contact your admin.";render();return}
    if(!u)throw new Error("Could not read your profile. Check your connection and try again.");
    $("#main").innerHTML=`<div class="empty">Loading from Supabase…</div>`;
    const s3=await sbLoadMaster();
    const s2=await sbLoadProjects();
    u.ws=u.wsIds.map(id=>sbMap.ws[id]).filter(Boolean);u.op=u.opId?(sbMap.op[u.opId]||""):"";
    sbLastSync=new Date();
    db.syncLog=db.syncLog||[];db.syncLog.unshift({at:sbLastSync.toISOString(),dir:"in",msg:`Supabase: ${s3.w} workshops, ${s3.m} stations, ${s3.a} assets, ${s3.o} team leaders, ${s3.raw} raw materials · ${s2.p} project(s), ${s2.t} tasks, ${s2.d} dependencies`});
    _sbPersist();
    me=u;sbBooting=false;if(!myViews().includes(view))view=myViews()[0];render();
  }catch(e){sbBooting=false;console.error(e);$("#main").innerHTML=`<div class="card" style="max-width:520px;margin:40px auto"><h2>Could not load data from Supabase</h2><p class="muted">${esc(e.message||String(e))}</p><button class="btn" onclick="location.reload()">Try again</button></div>`}
}
loginScreen=function(){
  document.body.classList.add("locked");
  const m=ui.sbMsg||"";ui.sbMsg="";
  $("#main").innerHTML=`<div class="login"><div class="login-card" style="max-width:420px">
    <div class="login-brand">${document.querySelector(".logo")?document.querySelector(".logo").innerHTML:""}<h1 style="margin:6px 0 2px">${t("brand")}</h1><div class="muted">${t("signIn")} · test (Supabase)</div></div>
    <div id="sbStep1"><label class="muted" style="font-size:12px">Company email</label>
      <input id="sbEmail" type="email" placeholder="name@dcevent.com" style="width:100%;margin:4px 0 10px" autocomplete="email">
      <button class="btn big" id="sbSend" style="width:100%">Send sign-in link</button></div>
    <div class="note" id="sbMsg" style="text-align:center;margin-top:12px;${m?"color:var(--bad)":""}">${esc(m)}</div>
    <div class="row" style="justify-content:center;margin-top:16px"><button class="btn sec sm" id="langBtn2">${t("lang")}</button></div>
  </div></div>`;
  const send=async()=>{const email=$("#sbEmail").value.trim().toLowerCase();
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){$("#sbMsg").textContent="Enter a valid email";$("#sbMsg").style.color="var(--bad)";return}
    $("#sbSend").disabled=true;
    const {error}=await SB.auth.signInWithOtp({email,options:{shouldCreateUser:false,emailRedirectTo:location.origin+location.pathname}});
    $("#sbSend").disabled=false;
    if(error){$("#sbMsg").textContent=/signups not allowed|Signups/i.test(error.message)?"This email has no MES account. Ask your admin to invite you.":/rate|too many/i.test(error.message)?"Too many sign-in emails were sent. Wait a while and try again.":error.message;$("#sbMsg").style.color="var(--bad)";return}
    $("#sbMsg").style.color="";$("#sbMsg").textContent="Email sent. Open it in this same browser and click Sign in (check spam too).";};
  $("#sbSend").onclick=send;$("#sbEmail").onkeydown=e=>{if(e.key==="Enter")send()};
  $("#langBtn2").onclick=()=>{$("#langBtn").click()};
};
logout=async function(){if(!confirm("Log out of the MES?"))return;me=null;ui.tWarn=null;try{await SB.auth.signOut({scope:"local"})}catch(e){}render()};
const _sbRenderUser=renderUser;
renderUser=function(){_sbRenderUser();const e=$("#userBox");if(e&&sbLastSync&&!e.querySelector(".sbstat"))e.insertAdjacentHTML("beforeend",`<div class="sbstat" style="font-size:11px;margin-top:6px;opacity:.8">● Supabase · ${sbLastSync.toLocaleTimeString()}</div>`)};
SB.auth.onAuthStateChange((ev)=>{if(ev==="SIGNED_IN"&&!me)setTimeout(sbBoot,0);if(ev==="SIGNED_OUT"&&me){me=null;console.warn("[MES] signed out");setTimeout(render,0)}});
me=null;
sbBoot();
