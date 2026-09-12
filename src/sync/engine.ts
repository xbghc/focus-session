import { applyRemote, hasSyncStorage, onLocalMutation, syncDriver, notifyProjection } from "./storage.ts";
import type { SyncConfig } from "./storage.ts";
import { PROTOCOL_VERSION, validateRecord } from "./protocol.ts";

export interface SyncStatus {
  enabled:boolean; baseUrl:string; tokenSet:boolean; userId?:string; serverId?:string;
  deviceId:string; pending:number; lastSuccess:number|null; error:string|null; running:boolean;
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
    let detail="";try { const body=await response.json(); if(typeof body.error==="string")detail=body.error.slice(0,250); }catch{}
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
    deviceId:s.deviceId,pending:s.outbox.length+Object.keys(s.data.archivePending??{}).length,lastSuccess:s.lastSuccess,error:s.error,running:Boolean(running)};
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
    for(let batch=0;batch<100;batch++) {
      await check();const state=await syncDriver().read();if(!state.outbox.length)break;
      const operations=[];let bytes=0;
      for(const op of state.outbox.slice(0,100)) {
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
    await syncDriver().update(s=>{if(JSON.stringify(s.config)!==JSON.stringify(config))throw new Error("同步配置已改变，本轮已停止");s.lastSuccess=Date.now();s.error=null;s.failures=0;s.retryAt=0;});
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
