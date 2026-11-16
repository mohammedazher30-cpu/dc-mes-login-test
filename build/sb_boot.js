/* ================= Supabase connection (test MES) ================= */
const SB=supabase.createClient("https://iccutmlawnnldkqxstmw.supabase.co","sb_publishable_Dmq8eav0yxwH5N64kSjYEw_aw8vxTTs");
const SB_ROLE={admin:"admin",exec:"exec",pm:"pm",manager:"manager",supervisor:"supervisor",storekeeper:"storekeeper",team_leader:"supervisor"};
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
    SB.from("stop_reason").select("id,category,name_en,name_ar,sort").order("sort"),
    sbAll(()=>SB.from("article").select("id,code,name,unit,stock,min_stock,max_stock,item_group,family,source,catalog:catalog_id(code)").eq("type","raw material").order("code"))]);
  const err=[w,m,a,o,c,r].map(x=>x.error).find(Boolean);if(err)throw err;
  /* workshops: keep the demo's order, take names from Supabase */
  const order=(db.workshops||[]).map(x=>x.id);
  db.workshops=w.data.map(x=>{sbMap.ws[x.id]=x.code;const ex=(db.workshops||[]).find(y=>y.id===x.code)||{};return Object.assign(ex,{id:x.code,name:x.name,code:x.code,sbId:x.id})})
    .sort((a,b)=>{const i=order.indexOf(a.id),j=order.indexOf(b.id);return (i<0?99:i)-(j<0?99:j)});
  /* stations (machines in the demo) */
  db.machines=m.data.map(x=>{sbMap.mach[x.id]=x.code;sbMap.machCode[x.code]=x.id;const ex=(db.machines||[]).find(y=>y.id===x.code)||{};
    return Object.assign(ex,{id:x.code,ws:x.workshop&&x.workshop.code,name:x.name,state:x.state||"run",reason:x.stop_reason||"",sbId:x.id})});
  { const LO=["PACKING","LOADING","TRANSIT","TRUCK_UNLOADING","DELIVERY","SITE_INSTALLATION"],idx=[];
    db.machines.forEach((x,i)=>{if(x.ws==="LOG")idx.push(i)});
    const lg=idx.map(i=>db.machines[i]).sort((a,b)=>{const i=LO.indexOf(a.id),j=LO.indexOf(b.id);return (i<0?99:i)-(j<0?99:j)});
    idx.forEach((i,k)=>db.machines[i]=lg[k]) }
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
  if(r.data.length){const g={};r.data.forEach(x=>{sbReason[x.name_en]=x.id;(g[x.category]=g[x.category]||[]).push(x.name_en);if(x.name_ar&&T.ar)T.ar[x.name_en]=x.name_ar});
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
  sbSnap.wo={};L.forEach(w=>{sbSnap.wo[w.id]=sbWoKey(w);sbBase[w.id]=JSON.parse(JSON.stringify(sbClean(w)))});
  return {n:L.length};
}
async function sbSaveWO(w){
  const dl=sbDelta(w);
  for(let tries=0;;tries++){
  const ver=await sbMergeWO(w,dl);
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
  else{let q=SB.from("work_order").update(row).eq("id",w.sbId);if(ver)q=q.eq("updated_at",ver);
    const {data:upd,error}=await q.select("id");if(error)throw error;
    if(ver&&(!upd||!upd.length)){if(tries<5)continue;throw new Error("another device kept changing work order "+w.id+", try again")}}
  break}
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
  sbBase[w.id]=JSON.parse(JSON.stringify(sbClean(w)));sbSnap.wo[w.id]=sbWoKey(w);
}
function sbQueueWO(w){const key=sbWoKey(w);sbSnap.wo[w.id]=key;if(!w.sbId)w.sbPending=true;
  sbWoQ[w.id]=(sbWoQ[w.id]||Promise.resolve()).then(()=>sbSaveWO(w)).then(()=>{_sbPersist()})
    .catch(e=>{console.error(e);delete sbSnap.wo[w.id];toast("Work order "+w.id+" not saved to Supabase: "+(e.message||e))})}


/* ---- part 5: operator terminal records (runs, stops, material use, scrap/rework log) ---- */
let sbReason={},sbLogQ={},sbBase={};
const sbDays=60;
const sbWoU=code=>{const w=by(db.workorders,code);return w&&w.sbId||null};
const sbWoC=u=>{const w=(db.workorders||[]).find(x=>x.sbId===u);return w?w.id:""};
const sbOpU=id=>{const o=(db.operators||[]).find(x=>x.id===id);return o&&o.sbId||null};
const sbOpL=u=>(u&&sbMap.op[u])||"";
const sbArtU=id=>{const a=by(db.articles,id);return a&&a.sbId||null};
const sbArtC=u=>{const a=db.articles.find(x=>x.sbId===u);return a?a.id:""};
const sbMachC=u=>(u&&sbMap.mach[u])||"";
const sbClean=(o,k)=>{const {sbId,sbPending,...r}=o;return r};
const SB_LOGS={
  executions:{t:"execution",key:"ex",need:x=>sbWoU(x.wo),
    row:x=>{const w=by(db.workorders,x.wo),o=w&&w.ops&&w.ops[exOp(x)];return {code:x.id,work_order_id:sbWoU(x.wo),op_seq:o?+o.seq:null,machine_id:sbMachU(x.machine),operator_id:sbOpU(x.operator),
      started_at:x.start,ended_at:x.end||null,good_qty:+x.good||0,scrap_qty:+x.scrap||0,rework_qty:+x.rw||0,started_by:x.by||(by(db.operators,x.operator)||{}).name||null}},
    back:(r,b)=>{const wc=sbWoC(r.work_order_id),w=by(db.workorders,wc);let op=b.op;if(w&&r.op_seq!=null){const i=(w.ops||[]).findIndex(o=>+o.seq===r.op_seq);if(i>=0)op=i}
      return Object.assign(b,{id:r.code||b.id,wo:wc,op,machine:sbMachC(r.machine_id)||b.machine,operator:sbOpL(r.operator_id)||b.operator,start:r.started_at,end:r.ended_at,good:+r.good_qty||0,scrap:+r.scrap_qty||0,rw:+r.rework_qty||0})},
    sel:"id,code,work_order_id,op_seq,machine_id,operator_id,started_at,ended_at,good_qty,scrap_qty,rework_qty,props",since:"started_at",open:"ended_at",seq:"exe"},
  stops:{t:"stop_event",key:"st",need:x=>sbMachU(x.machine),
    row:x=>({code:x.id,machine_id:sbMachU(x.machine),started_at:x.start,ended_at:x.end||null,reason:x.reason||null,reason_id:sbReason[x.reason]||null,stopped_by:x.by||null,
      work_order_id:x.wo?sbWoU(x.wo):null,qualified_at:x.reason&&x.qAt?x.qAt:null}),
    back:(r,b)=>Object.assign(b,{id:r.code||b.id,machine:sbMachC(r.machine_id)||b.machine,start:r.started_at,end:r.ended_at,reason:r.reason||"",by:r.stopped_by||b.by||"",wo:r.work_order_id?sbWoC(r.work_order_id):(b.wo||"")}),
    sel:"id,code,machine_id,started_at,ended_at,reason,stopped_by,work_order_id,props",since:"started_at",open:"ended_at",seq:"stop"},
  consumption:{t:"material_issue",key:"mi",need:x=>sbWoU(x.wo)&&sbArtU(x.article),
    row:x=>({code:x.id,work_order_id:sbWoU(x.wo),article_id:sbArtU(x.article),qty:+x.qty||0,batch_no:x.batch||null,issued_at:x.ts,issued_by_name:x.by||null,zoho_sent:!!x.zsent,kind:x.kind||"use"}),
    back:(r,b)=>Object.assign(b,{id:r.code||b.id,wo:sbWoC(r.work_order_id),article:sbArtC(r.article_id)||b.article,qty:+r.qty,batch:r.batch_no||"",ts:r.issued_at,zsent:!!r.zoho_sent,kind:r.kind||"use"}),
    sel:"id,code,work_order_id,article_id,qty,batch_no,issued_at,zoho_sent,kind,props",since:"issued_at",seq:"cons"},
  scrapLog:{t:"scrap_log",key:"sc",need:x=>sbWoU(x.wo),
    row:x=>({code:x.id,at:x.at,work_order_id:sbWoU(x.wo),op_seq:x.seq!=null?+x.seq:null,machine_id:sbMachU(x.op),by_name:x.by||null,qty:+x.qty||0,action:x.action||null,reason:x.reason||null,note:x.note||null,materials:x.mat||[]}),
    back:(r,b)=>Object.assign(b,{id:r.code||b.id,at:r.at,wo:sbWoC(r.work_order_id),seq:r.op_seq,qty:+r.qty,action:r.action,reason:r.reason||"",note:r.note||"",mat:r.materials||[],by:r.by_name||b.by||""}),
    sel:"id,code,at,work_order_id,op_seq,machine_id,by_name,qty,action,reason,note,materials,props",since:"at",seq:"scrap"}
};
const sbLogKey=x=>JSON.stringify(sbClean(x));
async function sbLoadLogs(){
  const since=new Date(Date.now()-sbDays*864e5).toISOString(),out={};
  for(const [coll,c] of Object.entries(SB_LOGS)){
    const rows=await sbAll(()=>{let q=SB.from(c.t).select(c.sel);return c.open?q.or(`${c.since}.gte.${since},${c.open}.is.null`):q.gte(c.since,since)});
    const L=rows.map(r=>{const b=Object.assign({},(r.props&&r.props[c.key])||{});const x=c.back(r,b);x.sbId=r.id;return x}).filter(x=>coll==="stops"||x.wo);
    const seen=new Set();L.forEach(x=>{if(seen.has(x.id))x.id=x.id+"·"+x.sbId.slice(0,4);seen.add(x.id)});
    const pend=(db[coll]||[]).filter(x=>x.sbPending&&!L.some(y=>y.id===x.id));
    db[coll]=L.concat(pend);
    const mx=L.reduce((m,x)=>Math.max(m,parseInt(String(x.id).replace(/^\D+/,""))||0),0);db.seq[c.seq]=Math.max(db.seq[c.seq]||0,mx);
    sbSnap[coll]={};L.forEach(x=>sbSnap[coll][x.id]=sbLogKey(x));out[coll]=L.length}
  return out;
}
async function sbSaveLog(coll,x){
  const c=SB_LOGS[coll];
  if(x.wo&&sbWoQ[x.wo])await sbWoQ[x.wo];
  if(!c.need(x))throw new Error("waiting for "+(x.wo||x.machine));
  const row=c.row(x);row.props={[c.key]:sbClean(x)};
  if(!x.sbId){row.created_by=sbUid;if(c.t==="material_issue"){delete row.created_by;row.issued_by=sbUid}
    const {data,error}=await SB.from(c.t).insert(row).select("id").single();if(error)throw error;x.sbId=data.id;delete x.sbPending}
  else{const {error}=await SB.from(c.t).update(row).eq("id",x.sbId);if(error)throw error}
}
function sbQueueLog(coll,x){const k=coll+"|"+x.id;sbSnap[coll][x.id]=sbLogKey(x);if(!x.sbId)x.sbPending=true;
  sbLogQ[k]=(sbLogQ[k]||Promise.resolve()).then(()=>sbSaveLog(coll,x)).then(()=>{_sbPersist()})
    .catch(e=>{console.warn(e);delete sbSnap[coll][x.id];if(!/^waiting/.test(e.message||""))toast("Not saved to Supabase: "+(e.message||e))})}
/* two terminals on the same work order: add this device's progress to the latest server figures */
const SB_NUM=["done","scrap","rw","rs"];
async function sbMergeWO(w,dl){
  /* dl = this device's own changes since the last save; added on top of the latest server figures */
  if(!w.sbId)return null;
  const {data,error}=await SB.from("work_order").select("props,status,closed_short,cancel_info,updated_at").eq("id",w.sbId).maybeSingle();
  if(error||!data)return null;
  const srv=data.props&&data.props.wo;
  if(srv&&dl)(w.ops||[]).forEach(o=>{const so=(srv.ops||[]).find(x=>+x.seq===+o.seq),d=dl[o.seq];if(!so||!d)return;
    SB_NUM.forEach(f=>{if(d[f]==null)return;const v=Math.max(0,+((+so[f]||0)+d[f]).toFixed(4));if(v||o[f]!=null)o[f]=v})});
  if(data.status==="Cancelled"&&w.status!=="Cancelled"){w.status="Cancelled";if(data.cancel_info)w.cancel=data.cancel_info}
  if(data.closed_short&&!w.closedShort)w.closedShort=true;
  try{syncWO(w,true)}catch(e){}
  return data.updated_at;
}
function sbDelta(w){const base=sbBase[w.id];if(!base)return null;const dl={};
  (w.ops||[]).forEach(o=>{const bo=(base.ops||[]).find(x=>+x.seq===+o.seq);if(!bo)return;const d={};SB_NUM.forEach(f=>{const x=(+o[f]||0)-(+bo[f]||0);if(x)d[f]=x});if(Object.keys(d).length)dl[o.seq]=d});
  return dl}


/* ---- part 6: dispatch (shipments, QR crates, proof of delivery, site issues, history) ---- */
const SB_SH_ST=["Planned","Packed","Loaded","In transit","Delivered","Installed","Returned"];
const SB_ISSUE=["Damage","Missing item","Site not ready","Access / permit","Other"];
let sbShipBase={};const sbShipQ=new WeakMap();
const sbShipKey=s=>JSON.stringify(sbClean(s));
const sbProjL=u=>{const p=db.projects.find(x=>x.sbId===u);return p?p.id:""};
const sbTs=v=>{if(!v)return null;const d=new Date(v);return isNaN(d)?null:d.toISOString()};
const sbOk=async q=>{const {error}=await q;if(error)throw error};
const sbJ=x=>x===undefined?"~":JSON.stringify(x);
async function sbLoadShipments(){
  const rows=await sbAll(()=>SB.from("shipment").select("id,code,project_id,status,props").order("created_at"));
  const L=rows.map(r=>{const b=Object.assign({crates:[],issues:[],log:[]},(r.props&&r.props.sh)||{});
    return Object.assign(b,{id:r.code,sbId:r.id,project:sbProjL(r.project_id)||b.project,status:r.status})}).filter(s=>s.project);
  const ids=new Set(L.map(s=>s.id));
  const pend=(db.shipments||[]).filter(s=>s.sbPending&&!ids.has(s.id));
  db.shipments=L.concat(pend);
  const mx=L.reduce((m,s)=>Math.max(m,parseInt(String(s.id).replace(/^\D+/,""))||0),0);db.seq.ship=Math.max(db.seq.ship||0,mx);
  sbSnap.ship={};L.forEach(s=>{sbSnap.ship[s.id]=sbShipKey(s);sbShipBase[s.id]=JSON.parse(JSON.stringify(sbClean(s)))});
  return {n:L.length};
}
/* two devices on one shipment (office + loading station): keep both sides' scans, crates, issues and history */
async function sbMergeShip(s){
  if(!s.sbId)return null;
  const {data,error}=await SB.from("shipment").select("props,updated_at").eq("id",s.sbId).maybeSingle();
  if(error||!data)return null;
  const srv=data.props&&data.props.sh,base=sbShipBase[s.id];if(!srv||!base)return data.updated_at;
  const M=a=>new Map((a||[]).map(c=>[c.id,c]));const B=M(base.crates),S=M(srv.crates);
  s.crates=s.crates||[];const Lc=M(s.crates);
  (srv.crates||[]).forEach(c=>{if(!B.has(c.id)&&!Lc.has(c.id))s.crates.push(JSON.parse(JSON.stringify(c)))});
  s.crates=s.crates.filter(c=>!(B.has(c.id)&&!S.has(c.id)&&sbJ(c)===sbJ(B.get(c.id))));
  s.crates.forEach(c=>{const o=S.get(c.id),b=B.get(c.id);if(!o||!b)return;
    Object.keys(Object.assign({},o,b,c)).forEach(f=>{if(sbJ(c[f])===sbJ(b[f])&&sbJ(o[f])!==sbJ(c[f])){if(o[f]===undefined)delete c[f];else c[f]=JSON.parse(JSON.stringify(o[f]))}})});
  ["issues","log"].forEach(f=>{s[f]=s[f]||[];const have=new Set(s[f].map(sbJ));(srv[f]||[]).forEach(x=>{if(!have.has(sbJ(x)))s[f].push(x)});
    s[f].sort((a,b)=>String(a.ts||"").localeCompare(String(b.ts||"")))});
  Object.keys(Object.assign({},srv,base)).forEach(f=>{if(["id","crates","issues","log"].includes(f))return;
    if(sbJ(s[f])===sbJ(base[f])&&sbJ(srv[f])!==sbJ(s[f])){if(srv[f]===undefined)delete s[f];else s[f]=JSON.parse(JSON.stringify(srv[f]))}});
  return data.updated_at;
}
function sbRenumberShip(s){const old=s.id;
  const n=Math.max(db.seq.ship||0,...db.shipments.map(x=>parseInt(String(x.id).replace(/^\D+/,""))||0))+1;db.seq.ship=n;
  const id="SH-"+String(n).padStart(3,"0");s.id=id;(s.crates||[]).forEach(c=>{c.id=c.id.replace(old,id)});
  if(ui.shSel===old)ui.shSel=id;delete sbSnap.ship[old]}
async function sbSaveShip(s){
  for(let tries=0;;tries++){
    const ver=await sbMergeShip(s);
    const p=by(db.projects,s.project);if(!p||!p.sbId)throw new Error("project of shipment "+s.id+" is not in Supabase");
    const drv=by(db.operators,s.driver);
    const row={company_id:sbCompany,code:s.id,project_id:p.sbId,site:s.site||null,site_time:sbTs(s.siteTime),truck:s.truck||null,
      driver_operator_id:drv&&drv.sbId||null,driver_phone:s.driverPhone||null,status:SB_SH_ST.includes(s.status)?s.status:"Planned",
      extra_trip:!!s.extraTrip,extra_trip_needed:!!s.extraTripNeeded,departed_at:sbTs(s.departedAt),delivered_at:sbTs(s.deliveredAt),
      props:{sh:sbClean(s)},updated_at:new Date().toISOString()};
    if(!s.sbId){row.created_by=sbUid;const {data,error}=await SB.from("shipment").insert(row).select("id").single();
      if(error){if(/duplicate|unique/i.test(error.message)&&tries<10){sbRenumberShip(s);continue}throw error}
      s.sbId=data.id;delete s.sbPending}
    else{let q=SB.from("shipment").update(row).eq("id",s.sbId);if(ver)q=q.eq("updated_at",ver);
      const {data:upd,error}=await q.select("id");if(error)throw error;
      if(ver&&(!upd||!upd.length)){if(tries<5)continue;throw new Error("another device kept changing shipment "+s.id+", try again")}}
    break}
  /* reporting tables: crates + contents, site issues, history, proof of delivery */
  const sid=s.sbId;
  for(const c of s.crates||[])for(const i of c.items||[])if(i.wo&&sbWoQ[i.wo])await sbWoQ[i.wo];
  await sbOk(SB.from("crate").delete().eq("shipment_id",sid));
  const C=(s.crates||[]).map(c=>({shipment_id:sid,code:c.id,install_seq:c.installSeq!=null?+c.installSeq:null,loaded:!!c.loaded,delivered:!!c.delivered,damaged:!!c.damaged,
    packed_by:c.by||null,packed_at:sbTs(c.at),sealed:!!c.sealed,checked_by:c.chkBy||null,checked_at:sbTs(c.chkAt),
    sent_for_check:!!c.ready,reject_reason:c.rej&&c.rej.reason||null,reject_note:c.rej&&c.rej.note||null,rejected_by:c.rej&&c.rej.by||null,rejected_at:c.rej?sbTs(c.rej.at):null}));
  if(C.length){const {data:cr,error}=await SB.from("crate").insert(C).select("id,code");if(error)throw error;
    const cid={};cr.forEach(x=>cid[x.code]=x.id);const I=[];
    (s.crates||[]).forEach(c=>(c.items||[]).forEach(i=>{const a=sbArtU(i.article);if(a&&+i.qty>0)I.push({crate_id:cid[c.id],article_id:a,work_order_id:i.wo?sbWoU(i.wo):null,qty:+i.qty})}));
    if(I.length)await sbOk(SB.from("crate_item").insert(I))}
  await sbOk(SB.from("site_issue").delete().eq("shipment_id",sid));
  const IS=(s.issues||[]).map(x=>{const m=/^(\S+-C\d+) · /.exec(x.text||"");
    return {shipment_id:sid,type:SB_ISSUE.includes(x.type)?x.type:"Other",text:x.text||null,crate_code:m?m[1]:null,created_at:sbTs(x.ts)||new Date().toISOString()}});
  if(IS.length)await sbOk(SB.from("site_issue").insert(IS));
  await sbOk(SB.from("shipment_log").delete().eq("shipment_id",sid));
  const LG=(s.log||[]).map(x=>({shipment_id:sid,at:sbTs(x.ts)||new Date().toISOString(),text:x.txt||"",by_name:x.by||null}));
  if(LG.length)await sbOk(SB.from("shipment_log").insert(LG));
  if(s.pod&&s.pod.name)await sbOk(SB.from("proof_of_delivery").upsert({shipment_id:sid,receiver_name:s.pod.name,note:s.pod.note||null,delivered_at:sbTs(s.pod.ts)||new Date().toISOString()}));
  else await sbOk(SB.from("proof_of_delivery").delete().eq("shipment_id",sid));
  sbShipBase[s.id]=JSON.parse(JSON.stringify(sbClean(s)));sbSnap.ship[s.id]=sbShipKey(s);
}
function sbQueueShip(s){sbSnap.ship[s.id]=sbShipKey(s);if(!s.sbId)s.sbPending=true;
  sbShipQ.set(s,(sbShipQ.get(s)||Promise.resolve()).then(()=>sbSaveShip(s)).then(()=>{_sbPersist()})
    .catch(e=>{console.error(e);delete sbSnap.ship[s.id];toast("Shipment "+s.id+" not saved to Supabase: "+(e.message||e))}))}

/* push changes made in the MES back to Supabase: task status, station state, work orders, terminal records, shipments */
const _sbPersist=persist;
persist=function(){if(me&&!sbBooting){try{syncTailFromCrates()}catch(e){console.warn(e)}}const r=_sbPersist();if(!me||sbBooting)return r;
  (db.tasks||[]).filter(k=>k.sbId&&sbSnap.task[k.sbId]!==sbTaskKey(k)).forEach(k=>{sbSnap.task[k.sbId]=sbTaskKey(k);
    SB.from("project_task").update({status:k.status==="inprog"?"in progress":k.status,done_at:k.doneAt||null,done_by:k.doneBy||null,zoho_pct:Math.round(k.zohoPct||0)}).eq("id",k.sbId)
      .then(({error})=>{if(error){delete sbSnap.task[k.sbId];toast("Could not save task to Supabase")}})});
  (db.machines||[]).filter(x=>x.sbId&&sbSnap.mach[x.id]!==sbMachKey(x)).forEach(x=>{sbSnap.mach[x.id]=sbMachKey(x);
    SB.from("machine").update({state:["run","stopped","out"].includes(x.state)?x.state:"run",stop_reason:x.reason||null}).eq("id",x.sbId)
      .then(({error})=>{if(error){delete sbSnap.mach[x.id];toast("Could not save station state to Supabase")}})});
  /* only work orders of projects that exist in Supabase (stops old demo orders being uploaded) */
  (db.workorders||[]).filter(w=>sbSnap.wo[w.id]!==sbWoKey(w)&&(w.sbId||(by(db.projects,w.project)||{}).sbId)).forEach(sbQueueWO);
  sbSnap.ship=sbSnap.ship||{};(db.shipments||[]).filter(x=>sbSnap.ship[x.id]!==sbShipKey(x)).forEach(sbQueueShip);
  Object.keys(SB_LOGS).forEach(coll=>{sbSnap[coll]=sbSnap[coll]||{};(db[coll]||[]).filter(x=>sbSnap[coll][x.id]!==sbLogKey(x)).forEach(x=>sbQueueLog(coll,x))});
  return r};

async function sbProfileToMe(){
  const {data,error}=await SB.rpc("my_profile");
  if(error)return null;
  if(!data||!data.length)return false;
  const p=data[0];
  const {data:row}=await SB.from("app_user").select("workshop_ids,operator_id").eq("id",p.id).maybeSingle();
  return {id:p.id,name:p.full_name,email:p.email,role:SB_ROLE[p.role]||"operator",sbRole:p.role,wsIds:(row&&row.workshop_ids)||[],opId:row&&row.operator_id,ws:[],op:"",sb:true};
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
    const s6=await sbLoadLogs();
    const s7=await sbLoadShipments();
    u.ws=u.wsIds.map(id=>sbMap.ws[id]).filter(Boolean);u.op=u.opId?(sbMap.op[u.opId]||""):"";
    sbLastSync=new Date();
    db.syncLog=db.syncLog||[];db.syncLog.unshift({at:sbLastSync.toISOString(),dir:"in",msg:`Supabase: ${s3.w} workshops, ${s3.m} stations, ${s3.a} assets, ${s3.o} team leaders, ${s3.raw} raw materials · ${s2.p} project(s), ${s2.t} tasks, ${s2.d} dependencies · ${s4.n} products, ${s5.n} work orders · ${s6.executions} runs, ${s6.stops} stops, ${s6.consumption} material records · ${s7.n} shipments`});
    _sbPersist();
    me=u;sbBooting=false;if(!myViews().includes(view))view=myViews()[0];render();sbIdleReset();
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

/* ---- part 7: team leader tablet login (name + PIN on registered tablets) ---- */
const SB_TAB="dcmes_tablet",SB_IDLE_MIN=30;
const sbTabKey=()=>{try{return localStorage.getItem(SB_TAB)||""}catch(e){return""}};
const sbTabSet=k=>{try{k?localStorage.setItem(SB_TAB,k):localStorage.removeItem(SB_TAB)}catch(e){}};
async function sbFn(name,body){const {data,error}=await SB.functions.invoke(name,{body});if(error)return {ok:false,error:"Could not reach the server. Check the connection."};return data||{ok:false,error:"No answer from the server"}}
const _sbEmailLogin=loginScreen;
loginScreen=function(){
  const key=sbTabKey();
  if(!key||ui.sbEmailMode){_sbEmailLogin();
    if(key&&$("#sbStep1"))$("#sbStep1").insertAdjacentHTML("afterend",`<div style="text-align:center;margin-top:10px"><button class="btn sec sm" id="sbBackPin">← Team leader sign-in</button></div>`);
    const bb=$("#sbBackPin");if(bb)bb.onclick=()=>{ui.sbEmailMode=false;loginScreen()};return}
  document.body.classList.add("locked");
  const msg=ui.sbMsg||"";ui.sbMsg="";
  $("#main").innerHTML=`<div class="login"><div class="login-card" style="max-width:560px">
    <div class="login-brand">${document.querySelector(".logo")?document.querySelector(".logo").innerHTML:""}<h1 style="margin:6px 0 2px">${t("brand")}</h1><div class="muted" id="sbTabName">Loading…</div></div>
    <div id="sbPeople" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin:12px 0"></div>
    <div id="sbPin" style="display:none;text-align:center"></div>
    <div class="note" id="sbMsg" style="text-align:center;margin-top:10px;${msg?"color:var(--bad)":""}">${esc(msg)}</div>
    <div class="row" style="justify-content:center;margin-top:14px;gap:8px"><button class="btn sec sm" id="sbOffice">Office login (email)</button><button class="btn sec sm" id="langBtn2">${t("lang")}</button></div>
  </div></div>`;
  $("#sbOffice").onclick=()=>{ui.sbEmailMode=true;loginScreen()};$("#langBtn2").onclick=()=>{$("#langBtn").click()};
  const err=m=>{$("#sbMsg").textContent=m;$("#sbMsg").style.color="var(--bad)"};
  sbFn("tablet-login",{action:"list",device_key:key}).then(r=>{
    if(!r.ok){$("#sbTabName").textContent="Tablet not active";err(r.error);if(r.device===false)sbTabSet("");return}
    $("#sbTabName").textContent="📟 "+r.device+" · tap your name";
    if(!r.people.length){$("#sbPeople").innerHTML=`<div class="muted" style="grid-column:1/-1;text-align:center">No team leader has a PIN for this tablet yet. Ask your admin.</div>`;return}
    $("#sbPeople").innerHTML=r.people.map(p=>`<button class="btn sec big" data-pp="${p.id}" style="white-space:normal;line-height:1.2;padding:12px 8px"><b>${esc(p.name)}</b><br><span class="muted" style="font-size:11px">${esc(p.ws)}</span></button>`).join("");
    document.querySelectorAll("[data-pp]").forEach(b=>b.onclick=()=>pinPad(r.people.find(p=>p.id===b.dataset.pp)));
  });
  function pinPad(p){let pin="";$("#sbPeople").style.display="none";const box=$("#sbPin");box.style.display="";$("#sbMsg").textContent="";
    const draw=()=>{box.innerHTML=`<div style="font-size:18px;margin-bottom:6px"><b>${esc(p.name)}</b></div>
      <div style="font-size:30px;letter-spacing:14px;margin:6px 0 12px">${"●".repeat(pin.length)}${"○".repeat(4-pin.length)}</div>
      <div style="display:grid;grid-template-columns:repeat(3,72px);gap:8px;justify-content:center">${[1,2,3,4,5,6,7,8,9,"←",0,"✓"].map(k=>`<button class="btn ${k==="✓"?"":"sec"} big" data-k="${k}" style="height:60px;font-size:22px">${k}</button>`).join("")}</div>
      <div style="margin-top:12px"><button class="btn sec sm" id="sbNotMe">Not ${esc(p.name.split(" ")[0])}? Back</button></div>`;
      box.querySelectorAll("[data-k]").forEach(b=>b.onclick=()=>key_(b.dataset.k));$("#sbNotMe").onclick=()=>loginScreen()};
    const go=async()=>{if(pin.length!==4)return;box.querySelectorAll("button").forEach(b=>b.disabled=true);$("#sbMsg").style.color="";$("#sbMsg").textContent="Signing in…";
      const r=await sbFn("tablet-login",{action:"login",device_key:key,operator_id:p.id,pin});
      if(!r.ok){pin="";draw();err(r.error);return}
      const {error}=await SB.auth.verifyOtp({token_hash:r.token_hash,type:"magiclink"});
      if(error){pin="";draw();err("Could not sign in: "+error.message);return}
      $("#sbMsg").textContent="Welcome "+r.name;};
    const key_=k=>{if(k==="←")pin=pin.slice(0,-1);else if(k==="✓"){go();return}else if(pin.length<4)pin+=k;draw();if(pin.length===4)go()};
    draw();
    document.onkeydown=e=>{if(!$("#sbPin")||$("#sbPin").style.display==="none")return;if(/^\d$/.test(e.key))key_(e.key);else if(e.key==="Backspace")key_("←");else if(e.key==="Enter")key_("✓")};}
};
/* tablet sessions sign out after inactivity */
let sbIdleT=null;
const sbIsTablet=()=>!!(me&&me.sb&&me.sbRole==="team_leader");
function sbIdleReset(){if(!sbIsTablet())return;clearTimeout(sbIdleT);sbIdleT=setTimeout(async()=>{if(!sbIsTablet())return;me=null;ui.sbMsg="Signed out after "+SB_IDLE_MIN+" min without use.";try{await SB.auth.signOut({scope:"local"})}catch(e){}render()},SB_IDLE_MIN*60000)}
["pointerdown","keydown","touchstart"].forEach(ev=>document.addEventListener(ev,sbIdleReset,{passive:true}));
const _sbLogout7=logout;
logout=async function(){if(sbIsTablet()){me=null;clearTimeout(sbIdleT);try{await SB.auth.signOut({scope:"local"})}catch(e){}render();return}return _sbLogout7()};
/* Admin: tablets and team leader PINs, shown on the Users screen */
const _sbVUsers=typeof vUsers==="function"?vUsers:null;
if(_sbVUsers)vUsers=function(){_sbVUsers();if(!me||me.role!=="admin")return;
  $("#main").insertAdjacentHTML("beforeend",`<div id="sbTabAdmin"><div class="head" style="margin-top:22px"><h1 style="font-size:20px">Tablets & team leader PINs</h1></div><div class="card"><div class="muted">Loading…</div></div></div>`);
  sbTabAdmin()};
async function sbTabAdmin(){
  const box=$("#sbTabAdmin");if(!box)return;const r=await sbFn("tablet-admin",{action:"list"});
  if(!$("#sbTabAdmin"))return;
  if(!r.ok){box.querySelector(".card").innerHTML=`<div class="muted">${esc(r.error)}</div>`;return}
  const wsN=ids=>(ids||[]).length?ids.map(u=>wsName(sbMap.ws[u]||"")).join(", "):"All workshops";
  const here=sbTabKey(),fmt=d=>d?new Date(d).toLocaleString():"—";
  const pin=Object.fromEntries(r.pins.map(p=>[p.operator_id,p]));
  const tls=(db.operators||[]).filter(o=>o.sbId);
  box.querySelector(".card").outerHTML=`<div class="card"><h2 style="margin-top:0">Tablets</h2>
    <table><thead><tr><th>Name</th><th>Workshops</th><th>Status</th><th>Last used</th><th></th></tr></thead><tbody>
    ${r.devices.map(d=>`<tr><td><b>${esc(d.name)}</b></td><td>${esc(wsN(d.workshop_ids))}</td><td>${d.active?`<span class="pill p-ok">Active</span>`:`<span class="pill p-bad">Disabled</span>`}</td><td class="muted">${fmt(d.last_used_at)}${d.last_user?" · "+esc(d.last_user):""}</td>
      <td class="num"><button class="btn sec sm" data-dact="${d.id}" data-on="${d.active?0:1}">${d.active?"Disable":"Enable"}</button></td></tr>`).join("")||`<tr><td colspan="5" class="muted">No tablets registered yet.</td></tr>`}
    </tbody></table>
    <div class="row" style="margin-top:10px;gap:8px">${here?`<span class="muted">This device is registered as a tablet.</span><button class="btn sec sm" id="sbUnreg">Remove tablet key from this device</button>`:`<button class="btn" id="sbReg">📟 Register this device as a tablet</button>`}</div></div>
  <div class="card" style="margin-top:12px;padding:0;overflow:auto"><table><thead><tr><th>Team leader</th><th>Workshop</th><th>PIN</th><th>Set on</th><th></th></tr></thead><tbody>
    ${tls.map(o=>{const p=pin[o.sbId],lk=p&&p.locked_until&&new Date(p.locked_until)>new Date();return `<tr><td><b>${esc(o.name)}</b></td><td>${esc(wsName(o.ws))}</td>
      <td>${p?(lk?`<span class="pill p-bad">Locked</span>`:`<span class="pill p-ok">Set</span>`):`<span class="muted">Not set</span>`}</td><td class="muted">${p?fmt(p.set_at):"—"}</td>
      <td class="num" style="white-space:nowrap"><button class="btn sm" data-spin="${o.sbId}" data-nm="${esc(o.name)}">${p?"Reset PIN":"Set PIN"}</button>${lk?` <button class="btn sec sm" data-unl="${o.sbId}">Unlock</button>`:""}${p?` <button class="btn sec sm" data-rpin="${o.sbId}">Remove</button>`:""}</td></tr>`}).join("")}
  </tbody></table></div>
  <div class="note">Team leaders sign in on registered tablets with their name and a 4-digit PIN. Tell each team leader his PIN in person. 5 wrong PINs lock the account for 15 min. Tablets sign out after ${SB_IDLE_MIN} min without use.</div>`;
  const act=async(body,ok)=>{const x=await sbFn("tablet-admin",body);if(!x.ok){toast(x.error);return null}if(ok)toast(ok);sbTabAdmin();return x};
  box.querySelectorAll("[data-dact]").forEach(b=>b.onclick=()=>act({action:"set_device_active",id:b.dataset.dact,active:b.dataset.on==="1"},"Saved"));
  box.querySelectorAll("[data-unl]").forEach(b=>b.onclick=()=>act({action:"unlock_pin",operator_id:b.dataset.unl},"Unlocked"));
  box.querySelectorAll("[data-rpin]").forEach(b=>b.onclick=()=>{if(confirm("Remove this PIN? The team leader can no longer sign in."))act({action:"remove_pin",operator_id:b.dataset.rpin},"PIN removed")});
  box.querySelectorAll("[data-spin]").forEach(b=>b.onclick=()=>modal("PIN · "+b.dataset.nm,fld("New 4-digit PIN",`<input name="pin" required pattern="[0-9]{4}" maxlength="4" inputmode="numeric" autocomplete="off">`),
    f=>{act({action:"set_pin",operator_id:b.dataset.spin,pin:f.pin},"PIN saved for "+b.dataset.nm)}));
  const ub=$("#sbUnreg");if(ub)ub.onclick=()=>{if(confirm("Remove the tablet key from this device? It will show the email login again."))sbTabSet("");sbTabAdmin()};
  const rb=$("#sbReg");if(rb)rb.onclick=()=>modal("Register this device as a tablet",
    fld("Tablet name",`<input name="name" required placeholder="e.g. Carpentry tablet 1">`)+
    fld("Workshops (team leaders shown on this tablet)",`<div class="row" style="flex-wrap:wrap">${db.workshops.filter(w=>w.sbId).map(w=>`<label class="row" style="gap:4px"><input type="checkbox" name="ws_${w.id}"> ${esc(w.name)}</label>`).join("")}</div>`),
    async f=>{const ws=db.workshops.filter(w=>w.sbId&&f["ws_"+w.id]).map(w=>w.sbId);
      const x=await sbFn("tablet-admin",{action:"register_device",name:f.name,workshop_ids:ws});
      if(!x.ok){toast(x.error);return}sbTabSet(x.key);toast("This device is now a tablet. Sign out to see the team leader sign-in.");sbTabAdmin()});
}

const _sbRenderUser=renderUser;
renderUser=function(){_sbRenderUser();const e=$("#userBox");if(e&&sbLastSync&&!e.querySelector(".sbstat"))e.insertAdjacentHTML("beforeend",`<div class="sbstat" style="font-size:11px;margin-top:6px;opacity:.8">● Supabase · ${sbLastSync.toLocaleTimeString()}</div>`)};
SB.auth.onAuthStateChange((ev)=>{if(ev==="SIGNED_IN"&&!me)setTimeout(sbBoot,0);if(ev==="SIGNED_OUT"&&me){me=null;console.warn("[MES] signed out");setTimeout(render,0)}});
me=null;
sbBoot();
