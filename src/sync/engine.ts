import { applyRemote, hasSyncStorage, onLocalMutation, repairOutbox, syncDriver, notifyProjection } from "./storage.ts";
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
        await check();await applyRemote(syncDriver(),result.records.map(validateRecord),0,config);
        await syncDriver().update(s=>{
          if(JSON.stringify(s.config)!==JSON.stringify(config))throw new Error("同步配置已改变，本轮已停止");
          if(result.hasMore)s.snapshot={token:result.token,head:result.head,cursor:result.cursor};
          else {s.cursor=result.head;s.initializedRemote=true;delete s.snapshot;}
        });
        await notifyProjection();
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
        await check();await applyRemote(syncDriver(),result.records.map(validateRecord),result.cursor,config);
        await notifyProjection();
        if(!result.hasMore)return;
      }
      throw new Error("本轮下载已达批次上限，稍后继续");
    };
    await pull();
    const {flushArchives}=await import("../archive/background.ts");
    await flushArchives();
    // 老版本留下的残缺文章先补齐再分拣；补不了的才轮到 triage 把它留下
    if(await syncDriver().update(s=>{if(JSON.stringify(s.config)!==JSON.stringify(config))throw new Error("同步配置已改变，本轮已停止");return repairOutbox(s);}))await notifyProjection();
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
    }
    await pull();await check();
    const blocked=stuck.length?{count:stuck.length,...describe(stuck)}:undefined;
    await syncDriver().update(s=>{if(JSON.stringify(s.config)!==JSON.stringify(config))throw new Error("同步配置已改变，本轮已停止");s.lastSuccess=Date.now();s.error=null;s.failures=0;s.retryAt=0;s.blocked=blocked;});
  } catch(error) {
    await syncDriver().update(s=>{
      if(JSON.stringify(s.config)!==JSON.stringify(config))return;
      s.error=error instanceof Error?error.message:"同步失败";s.failures++;
      s.retryAt=Date.now()+Math.min(15*60_000,5_000*2**Math.min(s.failures,8));
      if((error as {status?:number}).status===401)s.config.enabled=false;
    });
  }
  return syncStatus();
}
export function runSync():Promise<SyncStatus> {
  if(running)return running;
  const work=async()=>{
    if(typeof navigator!=="undefined"&&navigator.locks)return navigator.locks.request("focus-session-sync",()=>cycle());
    return cycle();
  };
  running=work().finally(()=>{running=null;});return running.then(s=>({...s,running:false}));
}
export function scheduleSync(delay=2000):void {
  if(timer)clearTimeout(timer);
  timer=setTimeout(()=>{timer=undefined;void (async()=>{
    if(!hasSyncStorage())return;const s=await syncDriver().read();
    if(s.config.enabled&&s.retryAt<=Date.now())await runSync();
  })().catch(()=>undefined);},delay);
}
export function bootSync():void {
  onLocalMutation(()=>scheduleSync());scheduleSync(1000);
  if(typeof window!=="undefined") {
    window.addEventListener("online",()=>scheduleSync(100));
    document.addEventListener("visibilitychange",()=>{if(document.visibilityState==="visible")scheduleSync(100);});
    setInterval(()=>scheduleSync(100),60_000);
  }
}
