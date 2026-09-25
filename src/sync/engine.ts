import { applyRemote, foldOutbox, hasSyncStorage, onLocalMutation, repairOutbox, syncDriver, notifyProjection } from "./storage.ts";
import type { SyncConfig } from "./storage.ts";
import { PROTOCOL_VERSION, object, recordKey, validateRecord } from "./protocol.ts";
import type { RecordType, SyncOperation, SyncRecord } from "./protocol.ts";

export interface SyncStatus {
  enabled:boolean; baseUrl:string; tokenSet:boolean; userId?:string; serverId?:string;
  deviceId:string; pending:number; lastSuccess:number|null; error:string|null; running:boolean;
  /** 过不了校验、留在队列里没发出去的记录数，和按原因归堆的说明（一堆一条）。都已经算在 pending 里。 */
  blocked:number; blockedReasons:string[];
  /** 这些记录分属几篇阅读材料。人是按「哪篇文章」想事情的，「207 项记录」对谁都没有意义。 */
  blockedMaterials:number;
}
/** 一篇阅读材料在同步上的处境。 */
export interface MaterialSync {
  /** synced 已在服务器上；pending 有改动等下一轮；blocked 有记录过不了校验；local 同步没开，或这类材料（书）本来就不上传。 */
  state:"synced"|"pending"|"blocked"|"local";
  /** 还在队列里的记录，按种类计数，如 [["专注时段",3],["段落",12]]。 */
  waiting:[string,number][];
  /** state 为 blocked 时：卡在哪。 */
  reasons:string[];
}
const LABEL:Record<RecordType,string>={article:"文章记录",session:"专注时段",paragraph:"段落",position:"阅读位置",snippet:"划词",card:"复习卡",
  reviewEvent:"复习记录",articleReview:"文章回顾",articleCard:"文章回顾卡",setting:"设置",articleText:"正文",archive:"离线存档"};
/** 校验函数和服务器共用，报的是英文；给人看之前把最常见的那一句说成人话。 */
const humanize=(reason:string):string=>reason.startsWith("Invalid article: ")?`文章记录的 ${reason.slice(17).split(", ").join("、")} 字段缺失或不合规`:reason;
/**
 * 一条记录归哪篇阅读材料。
 *
 * 划词在协议里**不**挂在文章名下——删文章留词是有意的（见 background/store.ts 的 deleteArticles），
 * 挂上去的话文章一删，词在所有设备上跟着没。但它确实是在那篇里划的，给人看的时候归过去。
 */
export function materialOf(record:SyncRecord|undefined):string|null {
  if(!record)return null;
  if(record.type==="article")return record.id;
  if(record.articleId)return record.articleId;
  const from=record.type==="snippet"?object(record.value).articleId:undefined;
  return typeof from==="string"?from:null;
}
// Capture WebView's real fetch before native.ts installs its text-only HTTP bridge.
// This retains redirect:'error', CORS and binary request bodies for the sync service.
const browserFetch = globalThis.fetch?.bind(globalThis);
let running:Promise<SyncStatus>|null=null;
let timer:ReturnType<typeof setTimeout>|undefined;
export function normalizeServerUrl(value:string):string {
  const url=new URL(value.trim());
  if(url.username||url.password||url.search||url.hash)throw new Error("服务器地址不能包含凭证、查询参数或片段");
  if(url.protocol!=="https:" && !(url.protocol==="http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname))) throw new Error("同步服务器需要 HTTPS；本机开发可使用 HTTP localhost");
  return url.href.replace(/\/+$/,"");
}
async function request(config:SyncConfig,path:string,init:RequestInit={}):Promise<Response> {
  const headers=new Headers(init.headers);headers.set("Authorization",`Bearer ${config.token}`);
  const response=await browserFetch(`${config.baseUrl}${path}`,{...init,headers,credentials:"omit",redirect:"error",signal:init.signal??AbortSignal.timeout(25_000)});
  if(!response.ok) {
    // error 只是大类（INVALID_REQUEST），message 才说得出是哪一条校验没过；两个都带上
    let detail="";try { const body=await response.json(); detail=[body.error,body.message].filter((v):v is string=>typeof v==="string"&&v.length>0).join(" · ").slice(0,250); }catch{}
    const error=new Error(response.status===401?"同步 Token 无效或已被吊销":`同步请求失败（${response.status}）${detail?`：${detail}`:""}`) as Error&{status?:number};error.status=response.status;throw error;
  }
  return response;
}
export async function syncRequest(path:string,init:RequestInit={}):Promise<Response> {
  const {config}=await syncDriver().read();
  if(!config.enabled||!config.token||!config.userId)throw new Error("请先在设置中启用同步");
  if(!path.startsWith("/v1/")||path.includes(".."))throw new Error("无效同步路径");
  return request(config,path,init);
}
export async function syncStatus():Promise<SyncStatus> {
  const s=await syncDriver().read();return {enabled:s.config.enabled,baseUrl:s.config.baseUrl,tokenSet:Boolean(s.config.token),userId:s.config.userId,serverId:s.config.serverId,
    deviceId:s.deviceId,pending:s.outbox.length+Object.keys(s.data.archivePending??{}).length,lastSuccess:s.lastSuccess,error:s.error,running:Boolean(running),
    // reason 是上一版存下的单条字符串，还没跑过新一轮同步的状态里只有它
    blocked:s.blocked?.count??0,blockedReasons:s.blocked?.reasons??(s.blocked?.reason?[s.blocked.reason]:[]),blockedMaterials:s.blocked?.materials??0};
}
/**
 * 把队列分成发得出去的和发不出去的。
 *
 * 服务器一批里有一条过不了 validateRecord 就整批 400，而重试发的还是同一批——一条坏记录
 * 能把后面几千条永远堵住。校验函数两端是同一份，所以先在本机过一遍：过不了的**留在队列里**
 * 但不发，别的照常走。不删，是因为坏的多半是老版本留下的形状，客户端修好之后下一轮自己就过了。
 *
 * 只有一种删：同一条记录后面还排着更新的操作。本机的值是累积的，后一条盖得住前一条，
 * 前一条再也用不上；不删的话一篇读着的坏文章每次心跳都往「无法同步」里添一条。
 *
 * 文章发不出去时，挂在它名下的记录也先不发，免得另一台设备上出现没有文章的片段和段落。
 * 看的是这篇文章排在**最后**的那条操作——前面坏过、后来好了，名下的记录就放行。
 */
const DEPENDENT="所属文章的记录无法同步";
type Blocked={op:SyncOperation;reason:string};
function triage(outbox:SyncOperation[],verdicts:Map<string,string|null>):{ready:SyncOperation[];blocked:Blocked[];superseded:string[]} {
  const verdictOf=(op:SyncOperation):string|null=>{
    let verdict=verdicts.get(op.opId);
    if(verdict===undefined) {
      try {validateRecord(op.record);verdict=null;}catch(error) {verdict=error instanceof Error?error.message:"Invalid sync record";}
      verdicts.set(op.opId,verdict);
    }
    return verdict;
  };
  // 队列里的东西过不了校验，就不能指望它有 type 和 id
  const keyOf=(op:SyncOperation):string=>JSON.stringify([op.record?.type,op.record?.id]);
  const last=new Map<string,number>();outbox.forEach((op,i)=>last.set(keyOf(op),i));
  const stuckArticles=new Set<string>();
  outbox.forEach((op,i)=>{if(op.record?.type==="article"&&last.get(keyOf(op))===i&&verdictOf(op)!==null)stuckArticles.add(op.record.id);});
  const ready:SyncOperation[]=[],blocked:Blocked[]=[],superseded:string[]=[];
  outbox.forEach((op,i)=>{
    const own=verdictOf(op);
    if(own!==null&&last.get(keyOf(op))!==i) {superseded.push(op.opId);return;}
    const parent=op.record?.articleId;
    const reason=own??(parent!==undefined&&stuckArticles.has(parent)?DEPENDENT:null);
    if(reason!==null)blocked.push({op,reason});else ready.push(op);
  });
  return {ready,blocked,superseded};
}
const tally=(ops:SyncOperation[]):[string,number][]=>{
  const counts=new Map<string,number>();
  for(const op of ops) {const label=LABEL[op.record?.type as RecordType]??"记录";counts.set(label,(counts.get(label)??0)+1);}
  return [...counts];
};
/** 说成了人话的那句里已经带着是哪种记录；原样的英文才在前面标一下种类。 */
const explain=(b:Blocked):string=>{const plain=humanize(b.reason);return plain!==b.reason?plain:`${LABEL[b.op.record?.type as RecordType]??"记录"}：${plain}`;};
const spell=(counts:[string,number][]):string=>counts.map(([label,n])=>`${n} 个${label}`).join("、");
/**
 * 按阅读材料说：哪篇卡住了、卡在哪、名下连带了什么。不挂在任何文章名下的（复习卡、设置）
 * 才按「种类：原因」归堆。要修的是自己有毛病的那些，被文章连累的只报种类和个数。
 */
function describe(stuck:Blocked[]):{reasons:string[];materials:number} {
  const byMaterial=new Map<string,Blocked[]>(),loose=new Map<string,{count:number;sample:string}>();
  for(const item of stuck) {
    const id=materialOf(item.op.record);
    if(id!==null) {byMaterial.set(id,[...(byMaterial.get(id)??[]),item]);continue;}
    const key=`${LABEL[item.op.record?.type as RecordType]??"记录"}：${humanize(item.reason)}`,group=loose.get(key);
    if(group)group.count++;else loose.set(key,{count:1,sample:String(item.op.record?.id).slice(0,160)});
  }
  const reasons:string[]=[];
  for(const [id,items] of [...byMaterial].slice(0,5)) {
    const own=items.filter(b=>b.reason!==DEPENDENT),dragged=items.filter(b=>b.reason===DEPENDENT);
    const title=String(object(items.find(b=>b.op.record?.type==="article")?.op.record?.value).title||"").slice(0,60);
    const why=[...new Set(own.map(explain))].join("；");
    reasons.push(`${title?`《${title}》`:""}${id.slice(0,160)}：${why||"名下有记录无法上传"}`+(dragged.length?`；名下 ${spell(tally(dragged.map(b=>b.op)))}一起留在本机`:""));
  }
  if(byMaterial.size>5)reasons.push(`另有 ${byMaterial.size-5} 篇阅读材料`);
  for(const [key,group] of [...loose].slice(0,3))reasons.push(`${key} ×${group.count}（如 ${group.sample}）`);
  if(loose.size>3)reasons.push(`另有 ${loose.size-3} 类原因`);
  return {reasons,materials:byMaterial.size};
}
/** 单篇阅读材料的同步处境，给文章详情用。每次现算：队列平时很短，展开一篇文章才问一次。 */
export async function materialSync(articleId:string):Promise<MaterialSync> {
  if(!hasSyncStorage())return {state:"local",waiting:[],reasons:[]};
  const s=await syncDriver().read();
  const known=Boolean(s.records[recordKey({type:"article",id:articleId})]);
  if(!s.config.enabled||!known)return {state:"local",waiting:[],reasons:[]};
  const mine=(op:SyncOperation):boolean=>materialOf(op.record)===articleId;
  const waiting=s.outbox.filter(mine);
  if(!waiting.length)return {state:"synced",waiting:[],reasons:[]};
  const stuck=triage(s.outbox,new Map()).blocked.filter(b=>mine(b.op));
  if(!stuck.length)return {state:"pending",waiting:tally(waiting),reasons:[]};
  const own=stuck.filter(b=>b.reason!==DEPENDENT);
  return {state:"blocked",waiting:tally(waiting),reasons:[...new Set(own.map(explain))]};
}
export async function testSync(baseUrl:string,token?:string):Promise<{serverId:string;userId:string;protocol:number}> {
  const {config}=await syncDriver().read();const url=normalizeServerUrl(baseUrl);
  const secret=token?.trim() || (url===config.baseUrl?config.token:"");
  if(!secret)throw new Error("请输入同步 Token");
  const info=await (await request({...config,baseUrl:url,token:secret},"/v1/info")).json();
  if(info.protocol!==PROTOCOL_VERSION||typeof info.serverId!=="string"||typeof info.userId!=="string")throw new Error("服务器同步协议不兼容");
  return info;
}
export async function configureSync(baseUrl:string,token:string|undefined,enabled:boolean):Promise<SyncStatus> {
  const before=await syncDriver().read();const url=normalizeServerUrl(baseUrl);
  if(!enabled && url===before.config.baseUrl && !token) {
    if(timer)clearTimeout(timer);
    await syncDriver().update(s=>{s.config.enabled=false;});return syncStatus();
  }
  const secret=token?.trim()||(url===before.config.baseUrl?before.config.token:"");
  const info=await testSync(url,secret);
  await syncDriver().update(s=>{
    if(s.config.userId && (s.config.userId!==info.userId||s.config.serverId!==info.serverId))throw new Error("本机数据已绑定另一个账号或服务器。请先导出备份，再清除此设备的数据后连接新账号。");
    s.config={baseUrl:url,token:secret,enabled,userId:info.userId,serverId:info.serverId};s.error=null;s.failures=0;s.retryAt=0;
  });
  if(enabled)scheduleSync(100);return syncStatus();
}
export async function disconnectSync():Promise<SyncStatus> {
  if(timer)clearTimeout(timer);
  await syncDriver().update(s=>{s.config.enabled=false;s.config.token="";s.error=null;});return syncStatus();
}
async function cycle():Promise<SyncStatus> {
  const initial=await syncDriver().read(); if(!initial.config.enabled)return syncStatus();
  const config=initial.config;
  const check=async()=>{const s=await syncDriver().read();if(!s.config.enabled||JSON.stringify(s.config)!==JSON.stringify(config))throw new Error("同步配置已改变，本轮已停止");};
  let succeeded=false;
  try {
    const info=await (await request(config,"/v1/info")).json();
    if(info.protocol!==PROTOCOL_VERSION||info.userId!==config.userId||info.serverId!==config.serverId)throw new Error("服务器身份或协议已变化，请检查同步设置");
    const stateBeforePull=await syncDriver().read();
    if(!stateBeforePull.initializedRemote && stateBeforePull.cursor===0) {
      for(let page=0;page<100;page++) {
        await check();const state=await syncDriver().read();const progress=state.snapshot;
        const query=progress?`?token=${encodeURIComponent(progress.token)}&cursor=${progress.cursor}&limit=200`:"?limit=200";
        let result;
        try {result=await (await request(config,`/v1/sync/snapshot${query}`)).json();}
        catch(error) {
          if(progress && [404,410].includes((error as {status?:number}).status??0))await syncDriver().update(s=>{delete s.snapshot;});
          throw error;
        }
        if(!Array.isArray(result.records)||typeof result.token!=="string"||!Number.isSafeInteger(result.head)||result.head<0||!Number.isSafeInteger(result.cursor)||result.cursor<0||typeof result.hasMore!=="boolean"
          || (progress&&(result.token!==progress.token||result.head!==progress.head||result.cursor<progress.cursor))
          || (result.hasMore&&result.cursor===(progress?.cursor??0)))throw new Error("无效的初始同步快照");
        await check();const altered=await applyRemote(syncDriver(),result.records.map(validateRecord),0,config);
        await syncDriver().update(s=>{
          if(JSON.stringify(s.config)!==JSON.stringify(config))throw new Error("同步配置已改变，本轮已停止");
          if(result.hasMore)s.snapshot={token:result.token,head:result.head,cursor:result.cursor};
          else {s.cursor=result.head;s.initializedRemote=true;delete s.snapshot;}
        });
        await notifyProjection(altered);
        if(!result.hasMore)break;
      }
      if(!(await syncDriver().read()).initializedRemote)throw new Error("初始下载已保存进度，稍后继续");
    }
    const pull=async()=>{
      for(let page=0;page<100;page++) {
        await check();const before=await syncDriver().read();
        const result=await (await request(config,`/v1/sync/pull?cursor=${before.cursor}&limit=200`)).json();
        if(!Array.isArray(result.records)||!Number.isSafeInteger(result.cursor)||result.cursor<before.cursor||typeof result.hasMore!=="boolean")throw new Error("无效的同步分页响应");
        if(result.hasMore && result.cursor===before.cursor)throw new Error("同步游标没有前进");
        await check();await notifyProjection(await applyRemote(syncDriver(),result.records.map(validateRecord),result.cursor,config));
        if(!result.hasMore)return;
      }
      throw new Error("本轮下载已达批次上限，稍后继续");
    };
    await pull();
    // 这一轮往服务器上放过东西，结尾才需要再下载一次；没放过，开头那次已经是最新的
    let uploaded=Object.keys(object((await syncDriver().read()).data.archivePending)).length>0;
    const {flushArchives}=await import("../archive/background.ts");
    await flushArchives();
    // 老版本留下的残缺文章先补齐再分拣；补不了的才轮到 triage 把它留下。补齐之后同一条记录的几次改动折成一条再发
    if(await syncDriver().update(s=>{if(JSON.stringify(s.config)!==JSON.stringify(config))throw new Error("同步配置已改变，本轮已停止");const repaired=repairOutbox(s);foldOutbox(s);return repaired;}))await notifyProjection();
    const verdicts=new Map<string,string|null>();let stuck:Blocked[]=[];
    for(let batch=0;batch<100;batch++) {
      await check();const state=await syncDriver().read();
      const plan=triage(state.outbox,verdicts);stuck=plan.blocked;
      if(plan.superseded.length) {
        const drop=new Set(plan.superseded);
        await syncDriver().update(s=>{if(JSON.stringify(s.config)!==JSON.stringify(config))throw new Error("同步配置已改变，本轮已停止");s.outbox=s.outbox.filter(op=>!drop.has(op.opId));});
      }
      if(!plan.ready.length)break;
      const operations=[];let bytes=0;
      for(const op of plan.ready.slice(0,100)) {
        const size=new TextEncoder().encode(JSON.stringify(op)).byteLength;
        if(operations.length && bytes+size>1_000_000)break;
        operations.push(op);bytes+=size;
      }
      const result=await (await request(config,"/v1/sync/push",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({deviceId:state.deviceId,operations})})).json();
      const ids=new Set(operations.map(op=>op.opId));
      if(!Array.isArray(result.accepted)||!result.accepted.length||result.accepted.some((id:unknown)=>typeof id!=="string"||!ids.has(id)))throw new Error("无效的同步确认响应");
      await check();const accepted=new Set<string>(result.accepted);
      await syncDriver().update(s=>{if(JSON.stringify(s.config)!==JSON.stringify(config))throw new Error("同步配置已改变，本轮已停止");s.outbox=s.outbox.filter(op=>!accepted.has(op.opId));});
      uploaded=true;
    }
    if(uploaded)await pull();
    await check();
    const blocked=stuck.length?{count:stuck.length,...describe(stuck)}:undefined;
    await syncDriver().update(s=>{if(JSON.stringify(s.config)!==JSON.stringify(config))throw new Error("同步配置已改变，本轮已停止");s.lastSuccess=Date.now();s.error=null;s.failures=0;s.retryAt=0;s.blocked=blocked;});
    succeeded=true;
  } catch(error) {
    await syncDriver().update(s=>{
      if(JSON.stringify(s.config)!==JSON.stringify(config))return;
      s.error=error instanceof Error?error.message:"同步失败";s.failures++;
      s.retryAt=Date.now()+Math.min(15*60_000,5_000*2**Math.min(s.failures,8));
      if((error as {status?:number}).status===401)s.config.enabled=false;
    });
  }
  if(succeeded)void uploadCounts(config,initial.deviceId);
  return syncStatus();
}
/**
 * 界面埋点的计数和诊断日志搭一轮成功的同步传上去（background/uiUsage.ts、background/logUpload.ts）。
 * 它们不是同步记录，传不上去不算同步失败，服务器比客户端旧、没有这个接口也一样。
 *
 * **不在周期里面，也没有人等它。**放在里面的话 `running` 要等它结束才清：网络差的时候这一个 POST 能挂满
 * 25 秒的超时，这期间任何 runSync() 拿到的都是这个卡着的周期——包括打开文章前等的那一轮（syncBefore），
 * 它会白等到上限，然后拿着旧位置去跳。计数晚几分钟到服务器无所谓，读位置晚不得。
 */
let counting=false;
async function uploadCounts(config:SyncConfig,deviceId:string):Promise<void> {
  if(counting)return;
  counting=true;
  try {
    const post=(path:string)=>(body:unknown)=>request(config,path,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const {uploadUiUsage}=await import("../background/uiUsage.ts");
    await uploadUiUsage(post("/v1/usage"),deviceId);
    const {uploadLogs}=await import("../background/logUpload.ts");
    await uploadLogs(post("/v1/logs"),deviceId);
  } catch { /* 见上：和同步的成败无关 */ }
  finally { counting=false; }
}
export function runSync():Promise<SyncStatus> {
  if(running)return running;
  const work=async()=>{
    if(typeof navigator!=="undefined"&&navigator.locks)return navigator.locks.request("focus-session-sync",()=>cycle());
    return cycle();
  };
  running=work().finally(()=>{running=null;});return running.then(s=>({...s,running:false}));
}
/**
 * 马上要用到「另一台设备刚写的东西」之前调：等一轮同步，但只等一小会儿。
 *
 * 现在只有续读位置用它。在电脑上读到一半、拿起手机打开同一篇——位置是几秒前才传到服务器的，
 * 而这台设备上一次拉取可能是一分钟前（扩展的定时器）、也可能还没发生（App 刚冷启动，头一轮排在一秒后）。
 * 不等的话读到的是旧位置，人会被放回上上次停下的地方，比不跳还糟。
 *
 * 刚同步过（freshMs 内）就不再跑；正在退避（服务器连不上）也不跑——这时候等只是白等。
 * 等不到就算了：超时之后那一轮照常在后台跑完，只是这一次用的是本机已有的位置。
 */
export async function syncBefore(maxWaitMs=2500,freshMs=10_000):Promise<void> {
  try {
    if(!hasSyncStorage())return;
    const s=await syncDriver().read();
    if(!s.config.enabled||s.retryAt>Date.now())return;
    if(!running&&s.lastSuccess!==null&&Date.now()-s.lastSuccess<freshMs)return;
    let timeout:ReturnType<typeof setTimeout>|undefined;
    await Promise.race([runSync(),new Promise<void>(resolve=>{timeout=setTimeout(resolve,maxWaitMs);})]).finally(()=>clearTimeout(timeout));
  } catch { /* 同步出不出错都不该拦着人打开文章 */ }
}
/**
 * 到点之后真正去跑的那一步。
 *
 * 到点时上一轮还没跑完：runSync() 只会把那一轮原样递回来，而它多半已经读过队列了，这之后写下的东西它带不走，
 * 也没有人再来催——要等下一个触发（一分钟后；关了屏的手机上是下次打开 App）。读着的时候每五秒一次心跳、
 * 一轮同步一两秒，关屏那一刻撞上的机会不小，撞上了丢的恰好是最后一段。所以等它完，队列里还有货就补一轮；
 * 没货说明它带走了，或者这次本来就只是想下载（定时、回到前台），那一轮已经够新，不多问服务器。
 * 等着的只留一个：一次结算连着好几笔写入，各催一次，补的那一轮一轮就够。
 */
let waiting=false;
async function kick():Promise<void> {
  if(!hasSyncStorage())return;
  const inFlight=running;
  if(inFlight) {
    if(waiting)return;
    waiting=true;
    try {await inFlight.catch(()=>undefined);} finally {waiting=false;}
    const left=await syncDriver().read();
    if(!left.outbox.length&&!Object.keys(object(left.data.archivePending)).length)return;
  }
  const s=await syncDriver().read();
  if(s.config.enabled&&s.retryAt<=Date.now())await runSync();
}
/** delay 为 0 时不经定时器、当场就跑：看不见的页面里定时器被浏览器压成一秒一跳，setTimeout(0) 也得等（见 mutationDelay）。 */
export function scheduleSync(delay=2000):void {
  if(timer) {clearTimeout(timer);timer=undefined;}
  if(delay<=0) {void kick().catch(()=>undefined);return;}
  timer=setTimeout(()=>{timer=undefined;void kick().catch(()=>undefined);},delay);
}
/**
 * 本机写了东西之后隔多久上传。平时攒 2 秒：一次结算是连着的好几笔写入，凑成一轮发。
 *
 * 页面已经看不见时不攒。手机上「关屏」就是读完的那一刻：最后一段专注和落点是 onPause 之后才写下的，
 * 而人接下来要做的是走到电脑前找这篇文章。屏幕一黑，这个进程还能跑多久、网还能通多久都说不准，
 * 早两秒发出去就少两秒悬着。看不见之后没有心跳，写入只剩结算这一串，几十毫秒内写完，
 * 而一轮同步先问身份、再下载、然后才读队列，轮到读的时候它们都在了——不用攒也凑得齐；
 * 真有漏在后面的，这一轮跑完之后会补一轮（见 kick）。是 0 而不是一个小数：看不见的页面里定时器被浏览器
 * 压成一秒一跳，模拟器上实测 150 毫秒的定时器要等 0.6 秒以上才响。
 *
 * 「看不见」先认宿主明说的（setHostVisible），再看 `document.visibilityState`。App 里宿主先通知网页、再暂停 WebView，
 * 两条消息走的不是一条路，先后没有保证（模拟器上实测 visibilitychange 晚到 2～22 毫秒）；结算就是被前一条触发的，
 * 认它不用赌后一条赶不赶得上。service worker 里两样都没有，走平时那条。
 */
let hostHidden=false;
/** App 的宿主切到后台 / 回到前台时调（app/boot.ts 接到 native.ts 的宿主回调上）。 */
export function setHostVisible(visible:boolean):void {hostHidden=!visible;}
export const mutationDelay=():number=>hostHidden||(typeof document!=="undefined"&&document.visibilityState==="hidden")?0:2000;
export function bootSync():void {
  onLocalMutation(()=>scheduleSync(mutationDelay()));scheduleSync(1000);
  if(typeof window!=="undefined") {
    window.addEventListener("online",()=>scheduleSync(100));
    document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")scheduleSync(100);});
    setInterval(()=>scheduleSync(100),60_000);
  }
}
