/* ================= Supabase connection (test MES) ================= */
const SB=supabase.createClient("https://iccutmlawnnldkqxstmw.supabase.co","sb_publishable_Dmq8eav0yxwH5N64kSjYEw_aw8vxTTs");
const SB_ROLE={admin:"admin",exec:"exec",pm:"pm",manager:"manager",supervisor:"supervisor",storekeeper:"storekeeper",team_leader:"operator"};
let sbSnap={task:{},mach:{},wo:{}},sbBooting=false,sbLastSync=null,sbMap={ws:{},mach:{},op:{},machCode:{}};
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


/* ---- part 4: products (articles + routing + sub-parts) and work orders ---- */
let sbCompany=null,sbUid=null,sbCust={},sbWoQ={};
const sbWsU=c=>{const w=(db.workshops||[]).find(x=>x.id===c);return w&&w.sbId||null};
const sbMachU=c=>(c&&sbMap.machCode[c])||null;
async function sbLoadProducts(){
  const [a,r,b,co]=await Promise.all([
    sbAll(()=>SB.from("article").select("id,code,name,type,unit,family,item_group,source,props,workshop:workshop_id(code)").in("type",["final item","subpart"]).order("code")),
    sbAll(()=>SB.from("routing_operation").select("article_id,seq,operation,unit_minutes,time_unit,machine:machine_id(code),workshop:workshop_id(code)").order("seq")),
    SB.from("bom_line").select("parent_id,child_id,qty,operation"),
    SB.from("company").select("id").limit(1)]);
  if(b.error)throw b.error;if(co.error)throw co.error;
  sbCompany=co.data[0]&&co.data[0].id;
  const code={};db.articles.forEach(x=>{if(x.sbId)code[x.sbId]=x.id});a.forEach(x=>code[x.id]=x.code);
  db.prodCatalogs=db.prodCatalogs||[];db.routing=db.routing||[];db.bom=db.bom||[];
  const projOf=n=>{const k=(n||"").toLowerCase().trim();return k&&db.projects.find(p=>{const q=p.name.toLowerCase();return q===k||q.startsWith(k)||k.startsWith(q)})};
  let added=0;
  a.forEach(x=>{const ex=by(db.articles,x.code);if(ex){ex.sbId=x.id;return}
    const pr=x.props||{};let cat=pr.catalog_local||"";
    if(!cat){const p=projOf(pr.catalog);if(p)cat=p.id;else if(pr.catalog){cat=pr.kmp_cat?"KC-"+pr.kmp_cat:"KC-"+pr.catalog;if(!db.prodCatalogs.some(c=>c.id===cat))db.prodCatalogs.push({id:cat,name:pr.catalog})}}
    const p=by(db.projects,cat);
    db.articles.push({id:x.code,name:x.name,type:"finished",unit:x.unit||"pcs",stock:0,catalog:cat,project:p?p.id:"",family:x.family||x.type,group:x.item_group||"",ws:x.workshop&&x.workshop.code||"",props:{},src:x.source,kmSteps:pr.km_steps||"",sbId:x.id});added++;
    r.filter(o=>o.article_id===x.id).forEach(o=>{const m=o.machine&&o.machine.code;db.routing.push({article:x.code,order:o.seq,op:m||o.operation,machine:m||"",ws:o.workshop&&o.workshop.code,time:+o.unit_minutes||60,tu:o.time_unit||"h",kmName:o.operation})});
    b.data.filter(l=>l.parent_id===x.id).forEach(l=>{if(code[l.child_id])db.bom.push({parent:x.code,child:code[l.child_id],qty:+l.qty||1,op:+l.operation||10})});
  });
  return {n:a.length,added};
}
/* make sure a product used in a work order exists in Supabase (new products made in the MES) */
async function sbEnsureArticle(id,depth){
  const x=by(db.articles,id);if(!x)return null;if(x.sbId)return x.sbId;if(x.type==="raw"||(depth||0)>3)return null;
  const fam=["final item","subpart"].includes(x.family)?x.family:"final item";
  const {data,error}=await SB.from("article").insert({company_id:sbCompany,code:x.id,name:x.name,type:fam,unit:x.unit||"pcs",stock:0,workshop_id:sbWsU(x.ws),family:fam,item_group:x.group||null,source:"mes",
    props:{catalog:catName(x.catalog||x.project),catalog_local:x.catalog||x.project||""}}).select("id").single();
  if(error){const {data:d2}=await SB.from("article").select("id").eq("code",x.id).maybeSingle();if(d2){x.sbId=d2.id;return d2.id}throw error}
  x.sbId=data.id;
  const R=(db.routing||[]).filter(o=>o.article===x.id).map(o=>({article_id:x.sbId,seq:+o.order,operation:o.kmName||o.op,machine_id:sbMachU(o.machine||o.op),workshop_id:sbWsU(o.ws),unit_minutes:+o.time||null,time_unit:o.tu==="min"?"min":"h"}));
  if(R.length){const {error:e2}=await SB.from("routing_operation").insert(R);if(e2)console.warn(e2)}
  for(const l of (db.bom||[]).filter(l=>l.parent===x.id)){const c=await sbEnsureArticle(l.child,(depth||0)+1);if(c){const {error:e3}=await SB.from("bom_line").insert({parent_id:x.sbId,child_id:c,qty:l.qty||1,operation:String(l.op||"")});if(e3)console.warn(e3)}}
  return x.sbId;
}
const sbWoKey=w=>{const {sbId,sbPending,...r}=w;return JSON.stringify(r)};
async function sbLoadWOs(){
  const [wo,ops,cu]=await Promise.all([
    sbAll(()=>SB.from("work_order").select("id,code,customer_order,project_id,task_id,planned_qty,good_qty,scrap_qty,rework_qty,due_date,status,closed_short,cancel_info,props,article:article_id(code),workshop:workshop_id(code),machine:machine_id(code)").order("created_at")),
    sbAll(()=>SB.from("work_order_operation").select("work_order_id,seq,operation,is_logistics,good_qty,scrap_qty,rework_qty,machine:machine_id(code),workshop:workshop_id(code)").order("seq")),
    SB.from("customer").select("id,name")]);
  if(cu.error)throw cu.error;
  sbCust={};cu.data.forEach(c=>sbCust[c.name.toLowerCase()]=c.id);
  const pL={},tL={};db.projects.forEach(p=>{if(p.sbId)pL[p.sbId]=p.id});db.tasks.forEach(k=>{if(k.sbId)tL[k.sbId]=k.id});
  const L=wo.map(x=>{const base=(x.props&&x.props.wo)||{};const rows=ops.filter(o=>o.work_order_id===x.id);
    const mk=o=>({seq:o.seq,op:o.operation||(o.machine&&o.machine.code)||"PRODUCTION",machine:o.machine&&o.machine.code||"",ws:o.workshop&&o.workshop.code,done:+o.good_qty||0,scrap:+o.scrap_qty||0,rw:+o.rework_qty||0,...(o.is_logistics?{tail:true}:{})});
    let O=Array.isArray(base.ops)&&base.ops.length?base.ops.map(o=>{const r=rows.find(y=>y.seq===o.seq);return r?Object.assign({},o,{done:+r.good_qty||0,scrap:+r.scrap_qty||0,rw:+r.rework_qty||0}):o}):rows.map(mk);
    const w=Object.assign({},base,{id:x.code,sbId:x.id,custOrder:x.customer_order||base.custOrder||"",project:pL[x.project_id]||base.project||"",article:x.article&&x.article.code||base.article,
      ws:x.workshop&&x.workshop.code||base.ws,machine:x.machine&&x.machine.code||"",planned:+x.planned_qty,done:+x.good_qty||0,scrap:+x.scrap_qty||0,due:x.due_date||base.due,status:x.status,
      rw:+x.rework_qty||0,closedShort:!!x.closed_short,ops:O});
    if(x.cancel_info)w.cancel=x.cancel_info;else delete w.cancel;
    if(x.task_id&&tL[x.task_id])w.task=tL[x.task_id];
    if(!w.customer){const p=by(db.projects,w.project);w.customer=p?p.customer:""}
    return w});
  const ids=new Set(L.map(w=>w.id));
  const pending=(db.workorders||[]).filter(w=>w.sbPending&&!ids.has(w.id));
  db.workorders=L.concat(pending);
  db.tasks.forEach(k=>{k.wos=db.workorders.filter(w=>w.task===k.id).map(w=>w.id)});
  sbSnap.wo={};L.forEach(w=>sbSnap.wo[w.id]=sbWoKey(w));
  return {n:L.length};
}
async function sbSaveWO(w){
  const art=await sbEnsureArticle(w.article);if(!art)throw new Error("Product "+w.article+" is not in Supabase");
  const p=by(db.projects,w.project),k=w.task&&by(db.tasks,w.task);
  const {sbId,sbPending,...full}=w;
  const row={company_id:sbCompany,code:w.id,customer_order:w.custOrder||null,customer_id:sbCust[(w.customer||(p&&p.customer)||"").toLowerCase()]||null,
    project_id:p&&p.sbId||null,task_id:k&&k.sbId||null,article_id:art,workshop_id:sbWsU(w.ws),machine_id:sbMachU(w.machine),
    planned_qty:Math.max(+w.planned||0,0.0001),good_qty:+w.done||0,scrap_qty:+w.scrap||0,rework_qty:+w.rw||0,due_date:w.due||null,
    status:["Planned","Released","In progress","Completed","Cancelled"].includes(w.status)?w.status:"Released",closed_short:!!w.closedShort,cancel_info:w.cancel||null,
    props:{wo:full},updated_at:new Date().toISOString()};
  if(!w.sbId){row.created_by=sbUid;const {data,error}=await SB.from("work_order").insert(row).select("id").single();
    if(error)throw /duplicate|unique/i.test(error.message)?new Error("Work order number "+w.id+" is already used by another user. Refresh and create it again."):error;
    w.sbId=data.id;delete w.sbPending}
  else{const {error}=await SB.from("work_order").update(row).eq("id",w.sbId);if(error)throw error}
  /* route steps */
  const seen=new Set(),O=(w.ops||[]).filter(o=>{const s=+o.seq;if(!Number.isFinite(s)||seen.has(s))return false;seen.add(s);return true}).map(o=>({work_order_id:w.sbId,seq:+o.seq,operation:o.op||null,
    workshop_id:sbWsU(o.ws),machine_id:sbMachU(o.machine),is_logistics:!!o.tail,good_qty:+o.done||0,scrap_qty:+o.scrap||0,rework_qty:+o.rw||0}));
  if(O.length){const {error}=await SB.from("work_order_operation").upsert(O,{onConflict:"work_order_id,seq"});if(error)throw error;
    const {error:e2}=await SB.from("work_order_operation").delete().eq("work_order_id",w.sbId).not("seq","in","("+O.map(o=>o.seq).join(",")+")");if(e2)console.warn(e2)}
  /* materials: product sub-parts/raw materials + extra materials, with lot numbers */
  const M={};const add=(c,q,op,ex)=>{const a=by(db.articles,c);if(!a||!a.sbId)return;const m=M[a.sbId];if(m){m.qty_per_unit+=+q||0;return}
    M[a.sbId]={work_order_id:w.sbId,article_id:a.sbId,qty_per_unit:+q||0,operation_seq:parseInt(op)||null,lot_no:(w.lots||{})[c]||null,is_extra:!!ex}};
  (db.bom||[]).filter(b=>b.parent===w.article).forEach(b=>add(b.child,b.qty,b.op,false));(w.extra||[]).forEach(x=>add(x.child,x.qty,x.op,true));
  const MR=Object.values(M);
  if(MR.length){const {error}=await SB.from("work_order_material").upsert(MR,{onConflict:"work_order_id,article_id"});if(error)throw error;
    const {error:e3}=await SB.from("work_order_material").delete().eq("work_order_id",w.sbId).not("article_id","in","("+MR.map(m=>m.article_id).join(",")+")");if(e3)console.warn(e3)}
  else{await SB.from("work_order_material").delete().eq("work_order_id",w.sbId)}
}
function sbQueueWO(w){const key=sbWoKey(w);sbSnap.wo[w.id]=key;if(!w.sbId)w.sbPending=true;
  sbWoQ[w.id]=(sbWoQ[w.id]||Promise.resolve()).then(()=>sbSaveWO(w)).then(()=>{_sbPersist()})
    .catch(e=>{console.error(e);delete sbSnap.wo[w.id];toast("Work order "+w.id+" not saved to Supabase: "+(e.message||e))})}

/* push changes made in the MES back to Supabase: task status, station state, work orders */
const _sbPersist=persist;
persist=function(){const r=_sbPersist();if(!me||sbBooting)return r;
  (db.tasks||[]).filter(k=>k.sbId&&sbSnap.task[k.sbId]!==sbTaskKey(k)).forEach(k=>{sbSnap.task[k.sbId]=sbTaskKey(k);
    SB.from("project_task").update({status:k.status==="inprog"?"in progress":k.status,done_at:k.doneAt||null,done_by:k.doneBy||null,zoho_pct:Math.round(k.zohoPct||0)}).eq("id",k.sbId)
      .then(({error})=>{if(error){delete sbSnap.task[k.sbId];toast("Could not save task to Supabase")}})});
  (db.machines||[]).filter(x=>x.sbId&&sbSnap.mach[x.id]!==sbMachKey(x)).forEach(x=>{sbSnap.mach[x.id]=sbMachKey(x);
    SB.from("machine").update({state:["run","stopped","out"].includes(x.state)?x.state:"run",stop_reason:x.reason||null}).eq("id",x.sbId)
      .then(({error})=>{if(error){delete sbSnap.mach[x.id];toast("Could not save station state to Supabase")}})});
  (db.workorders||[]).filter(w=>sbSnap.wo[w.id]!==sbWoKey(w)).forEach(sbQueueWO);
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
    sbUid=data.session.user.id;
    const s4=await sbLoadProducts();
    const s5=await sbLoadWOs();
    u.ws=u.wsIds.map(id=>sbMap.ws[id]).filter(Boolean);u.op=u.opId?(sbMap.op[u.opId]||""):"";
    sbLastSync=new Date();
    db.syncLog=db.syncLog||[];db.syncLog.unshift({at:sbLastSync.toISOString(),dir:"in",msg:`Supabase: ${s3.w} workshops, ${s3.m} stations, ${s3.a} assets, ${s3.o} team leaders, ${s3.raw} raw materials · ${s2.p} project(s), ${s2.t} tasks, ${s2.d} dependencies · ${s4.n} products, ${s5.n} work orders`});
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
