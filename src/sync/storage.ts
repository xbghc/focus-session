import type { Article, ArticleCard, BgToPage, FsrsState, ParagraphRecord, Session, StoredCard } from "../types.ts";
import { DEFAULT_SETTINGS } from "../types.ts";
import { gradeFsrs } from "../lib/review.ts";
import { summarizeSpeed } from "../lib/readingTime.ts";
import { mergeEpisodes } from "../lib/stats.ts";
import { isFinished } from "../lib/finish.ts";
import { normalizeUrl } from "../lib/url.ts";
import { compareStamp, mergeRecord, object, recordKey, validateRecord } from "./protocol.ts";
import type { SyncOperation, SyncRecord, RecordType } from "./protocol.ts";

export interface SyncConfig { enabled: boolean; baseUrl: string; token: string; serverId?: string; userId?: string }
export interface SyncState {
  data: Record<string, any>; records: Record<string, SyncRecord>; outbox: SyncOperation[];
  deviceId: string; counter: number; cursor: number; config: SyncConfig;
  lastSuccess: number | null; error: string | null; failures: number; retryAt: number;
  initializedRemote?: boolean;
  snapshot?: {token:string;head:number;cursor:number};
  /** 上一轮里过不了校验、留在 outbox 没发的记录（见 engine.ts 的 triage）。 */
  blocked?: {count:number;reasons?:string[];reason?:string;materials?:number};
}
export interface StateDriver {
  read(): Promise<SyncState>;
  update<T>(fn: (state: SyncState) => T): Promise<T>;
}
let dataQueue:Promise<unknown>=Promise.resolve();
/** Shared by domain read-modify-write operations and remote application, including other WebView contexts. */
export function withDataLock<T>(fn:()=>Promise<T>):Promise<T> {
  const work=async():Promise<T> => {
    if(typeof navigator!=="undefined"&&navigator.locks)return await navigator.locks.request("focus-session-data",fn);
    return await fn();
  };
  const next=dataQueue.then(work,work);dataQueue=next.catch(()=>undefined);return next;
}
export const freshState = (data: Record<string, unknown> = {}): SyncState => ({
  data: structuredClone(data), records: {}, outbox: [], deviceId: crypto.randomUUID(), counter: 0, cursor: 0,
  config: { enabled: false, baseUrl: "", token: "" }, lastSuccess: null, error: null, failures: 0, retryAt: 0,
  initializedRemote:false,snapshot:undefined,
});
export function memoryDriver(initial = freshState()): StateDriver {
  let state = structuredClone(initial);
  return { async read() { return structuredClone(state); }, async update(fn) {
    const next = structuredClone(state); const result = fn(next); state = next; return structuredClone(result);
  } };
}
/** One IDB transaction commits business data, sync versions and outbox together. */
export function indexedDriver(seed: () => Promise<Record<string, unknown>>, name = "focus-session-sync-v1"): StateDriver {
  let opening: Promise<IDBDatabase> | undefined;
  const open = () => opening ??= new Promise<IDBDatabase>((resolve,reject) => {
    const r = indexedDB.open(name,1);
    r.onupgradeneeded = () => r.result.createObjectStore("state");
    r.onsuccess = () => {r.result.onversionchange=()=>{r.result.close();opening=undefined;};resolve(r.result);};
    r.onerror = () => {opening=undefined;reject(r.error);};
  });
  let initialized: Promise<void> | undefined;
  const ensure = () => initialized ??= (async () => {
    const db=await open();
    const exists=await new Promise<boolean>((resolve,reject)=>{
      const tx=db.transaction("state","readonly"),r=tx.objectStore("state").get("root");let found=false;
      r.onsuccess=()=>{found=r.result!==undefined;};tx.oncomplete=()=>resolve(found);tx.onerror=tx.onabort=()=>reject(tx.error);
    });
    if(exists)return;
    const original = await seed();
    await new Promise<void>((resolve,reject) => {
      const tx = db.transaction("state","readwrite"), store = tx.objectStore("state"), r = store.get("root");
      r.onsuccess = () => { if (!r.result) { const state = freshState(original); trackChanges(state,{},state.data,true); store.put(state,"root"); } };
      tx.oncomplete = () => resolve(); tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("本地数据库初始化失败"));
    });
  })().catch(error=>{initialized=undefined;throw error;});
  const run = async <T>(mode: IDBTransactionMode, fn: (state: SyncState) => T): Promise<T> => {
    await ensure(); const db = await open();
    return new Promise<T>((resolve,reject) => {
      const tx = db.transaction("state", mode), store = tx.objectStore("state"), r = store.get("root"); let result: T; let error: unknown;
      r.onsuccess = () => { try { const state = r.result as SyncState; result = fn(state); if (mode === "readwrite") store.put(state,"root"); } catch (e) { error = e; tx.abort(); } };
      tx.oncomplete = () => resolve(structuredClone(result)); tx.onerror = tx.onabort = () => reject(error ?? tx.error ?? new Error("本地数据保存失败"));
    });
  };
  return { read: () => run("readonly",s => s), update: fn => run("readwrite",fn) };
}

type Entry = { type: RecordType; id: string; value: any; articleId?: string };
/**
 * 只有网页上的阅读材料出门。
 *
 * 书是用户自己从手机里拿来的文件，正文多半有版权，不该上传；同步协议本身也只认
 * http(s) 的文章标识（见 protocol.ts 的 validateRecord），`epub:` 开头的记录推上去
 * 会被服务端整批拒掉，连带把别的改动也卡住。所以在这儿就拦住，不进 outbox。
 * 书的阅读记录因此是**本机的**：换一台设备要重新导入，进度不跟着走。
 */
const syncable = (id: unknown): boolean => typeof id === "string" && /^https?:\/\//i.test(id);
/**
 * 把一篇文章补成同步协议认的形状。
 *
 * 本机的文章不都是 upsertArticleMeta 写出来的：导入合并只看 `id` 和 `lastSeenTs`
 * （见 lib/merge.ts 的 isArticle），老导出文件里没有的字段就原样缺着进了库；界面上到处
 * `?? 0` 看不出来，推上去服务器却不收。缺的按「没读过」补——和 upsertArticleMeta 给新文章的
 * 默认值是同一套，不编造进度。已经齐全的记录原样返回，不多出一次改动。
 */
export function normalizeArticle(id: string, raw: unknown): Record<string, any> {
  const v = { ...object(raw) };
  const count = (n: unknown): number => typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : 0;
  for (const key of ["totalWords","trackedWords","paragraphCount","firstSeenTs","lastSeenTs"]) v[key] = count(v[key]);
  if (typeof v.title !== "string") v.title = "";
  try { if (!/^https?:$/.test(new URL(String(v.url)).protocol)) v.url = id; } catch { v.url = id; }
  v.finished = v.finished === true;
  v.reachedBottom = v.reachedBottom === true;
  return v;
}
/**
 * 修队列里已经排着的坏文章。entries() 补的是以后的改动；已经入队的操作里是当时的原样，
 * 而一篇很久没再打开的文章不会再产生新操作，不修就永远卡着。换一个 opId：内容变了，
 * 不能让服务器当成同一个操作的重发。返回修了几条。
 */
export function repairOutbox(state: SyncState): number {
  let repaired = 0;
  state.outbox = state.outbox.map(op => {
    const record = op.record;
    if (record?.type !== "article" || record.deleted) return op;
    try { validateRecord(record); return op; } catch { /* 下面试着补 */ }
    const fixed = { ...record, value: normalizeArticle(record.id, record.value) };
    try { validateRecord(fixed); } catch { return op; }
    const key = recordKey(fixed), held = state.records[key];
    if (held && !held.deleted && compareStamp(held.stamp, record.stamp) === 0) state.records[key] = { ...held, value: normalizeArticle(held.id, held.value) };
    repaired++;
    return { opId: crypto.randomUUID(), record: fixed };
  });
  if (repaired) projectRecords(state);
  return repaired;
}
/**
 * 同一条记录排着的几次改动折成一条再发。
 *
 * 阅读位置几秒存一次、段落停留边读边涨；每次改动都单独排队的话，离线几天的设备连上后会把
 * 同一条记录传上几百遍，服务器的变更日志和操作回执也永久多出这么多；从没开过同步的设备，
 * 队列更是只涨不消。折叠用的就是 mergeRecord——本机的 records 和服务器都是拿它一条条并的，
 * 所以「先并好再发」和「一条条发」落到服务器上是同一个结果。只留最后一条则不是：读完标记、
 * 片段结束时间这类只增不减的字段会被后一条盖回去，本机和服务器就此分叉。
 *
 * 过不了校验的操作不参与折叠：后面还排着同一条记录的操作，它就作废（和 engine.ts 的 triage
 * 同一条规则）；它排在最后，就原样留着等 triage 报给用户。折出来的内容变了，换新的 opId——
 * 原来那条要是正在上传也不要紧，合并是幂等的，服务器再收一次折好的不会多出什么。
 * keys 给了就只动这几条记录，不给就把整个队列过一遍。返回少了几条。
 */
export function foldOutbox(state: SyncState, keys?: Set<string>): number {
  // 队列里的东西过不了校验，就不能指望它有 type 和 id
  const keyOf = (op: SyncOperation): string => JSON.stringify([op.record?.type, op.record?.id]);
  const valid = (record: unknown): boolean => { try { validateRecord(record); return true; } catch { return false; } };
  const last = new Map<string, number>();
  state.outbox.forEach((op, i) => { const key = keyOf(op); if (!keys || keys.has(key)) last.set(key, i); });
  const slot = new Map<string, number>(), next: SyncOperation[] = [];
  state.outbox.forEach((op, i) => {
    const key = keyOf(op), final = last.get(key) === i;
    // 不归这次管的，和独一条的，原样过：后者占绝大多数，省掉一次校验
    if (!last.has(key) || (final && !slot.has(key))) { next.push(op); return; }
    if (!valid(op.record)) { if (final) next.push(op); return; }
    const at = slot.get(key);
    if (at === undefined) { slot.set(key, next.length); next.push(op); return; }
    const merged = mergeRecord(next[at]!.record, op.record);
    if (valid(merged)) next[at] = { opId: crypto.randomUUID(), record: merged };
    else next.push(op);
  });
  const removed = state.outbox.length - next.length;
  state.outbox = next;
  return removed;
}
function entries(data: Record<string, any>): Map<string, Entry> {
  const result = new Map<string, Entry>();
  const add = (type: RecordType,id: string,value: any,articleId?: string) => { const e = {type,id,value,articleId}; result.set(recordKey(e),e); };
  for (const [id,a] of Object.entries(object(data.articles))) {
    if (!syncable(id)) continue;
    const v = normalizeArticle(id, a);
    for (const key of ["wordsRead","readParagraphCount","sessionCount","totalMs","maxSessionMs","episodeCount","maxEpisodeMs","readingMs"]) delete v[key];
    add("article",id,v);
  }
  for (const s of data.sessions ?? []) if (syncable(s.articleId)) add("session", s.id,s,s.articleId);
  const shareable = new Set<string>();
  for (const s of data.snippets ?? []) if (syncable(s.articleId)) { shareable.add(s.id); add("snippet",s.id,s); }
  for (const c of data.cards ?? []) {
    // 只在书里遇到过的词，卡片跟着留在本机；两边都遇到过的词照常同步，出处只报网页那几个
    const sources = (c.snippetIds ?? []).filter((id: string) => shareable.has(id));
    if (sources.length > 0) add("card",c.key,{ id:c.id,key:c.key,snippetIds:sources,base:object(data.reviewBases)[`word:${c.key}`] ?? c });
  }
  for (const c of data.articleCards ?? []) if (syncable(c.articleId)) add("articleCard",c.articleId,{articleId:c.articleId,base:object(data.reviewBases)[`article:${c.articleId}`] ?? c},c.articleId);
  for (const e of data.reviewEvents ?? []) {
    if (e.kind === "article" && !syncable(e.cardKey)) continue;
    add("reviewEvent",e.id,e,e.kind === "article" ? e.cardKey : undefined);
  }
  for (const [id,v] of Object.entries(object(data.archives))) add("archive",id,v,id);
  for (const [id,v] of Object.entries(object(data.settings))) {
    // 翻译白名单暂不同步：同步协议的设置项是白名单制，服务器和旧版客户端都认不得这一项——推上去整批 400，
    // 旧客户端拉到了也会整轮失败。每台设备按自己的阅读记录种一份（见 store.ts 的 seedTranslationAllowlist）。
    if (id in DEFAULT_SETTINGS && id !== "excludedDomains" && id !== "translationAllowedUrls") add("setting",id,v);
  }
  for (const [k,v] of Object.entries(data)) {
    if (k.startsWith("p:") && Array.isArray(v)) { if (syncable(k.slice(2))) for (const p of v) add("paragraph",JSON.stringify([k.slice(2),p.hash]),p,k.slice(2)); }
    else if (k.startsWith("pos:")) { if (syncable(k.slice(4))) add("position",k.slice(4),v,k.slice(4)); }
    else if (k.startsWith("r:")) { if (syncable(k.slice(2))) add("articleReview",k.slice(2),v,k.slice(2)); }
    else if (k.startsWith("t:")) { if (syncable(k.slice(2))) add("articleText",k.slice(2),v,k.slice(2)); }
  }
  return result;
}
const equal = (a: unknown,b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** Called inside the same transaction as local set/remove, never for remote application. */
export function trackChanges(state: SyncState, before: Record<string, any>, after: Record<string, any>, legacy = false): void {
  const prev = entries(before), next = entries(after);
  for(const id of Object.keys(object(after.deletedArticles)).filter(syncable)) {
    const key=recordKey({type:"article",id});
    if(!object(before.deletedArticles)[id]&&!prev.has(key)&&!next.has(key))prev.set(key,{type:"article",id,value:{id}});
  }
  const queued = new Set<string>();
  const keys = [...new Set([...prev.keys(),...next.keys()])];
  keys.sort((a,b) => (next.get(a)?.type === "article" || prev.get(a)?.type === "article" ? -1:0) - (next.get(b)?.type === "article" || prev.get(b)?.type === "article" ? -1:0));
  for (const key of keys) {
    const old = prev.get(key), item = next.get(key), existing = state.records[key];
    if (old && item && equal(old.value,item.value)) continue;
    const e = item ?? old!;
    // Card existence is derived from surviving sources/finished state. A local empty list
    // must not erase an independently added source or its review history on another device.
    if(!item && (e.type==="card"||e.type==="articleCard"))continue;
    const stamp = {counter:legacy ? 0 : ++state.counter, deviceId:state.deviceId};
    let generation = existing?.generation ?? "initial";
    if (item && existing?.deleted) generation = `${state.deviceId}:${stamp.counter}`;
    if (e.articleId) generation = state.records[recordKey({type:"article",id:e.articleId})]?.generation ?? generation;
    let value = item?.value ?? null;
    if (item && e.type === "paragraph") {
      const dwell = { ...object(object(existing?.value).dwell) };
      const delta = Math.max(0,Number(value.dwellMs ?? 0) - Number(old?.value.dwellMs ?? 0));
      const origin = legacy ? "legacy" : state.deviceId;
      dwell[origin] = old ? Number(dwell[origin] ?? 0) + delta : Math.max(Number(dwell[origin] ?? 0),delta);
      value = { ...value,dwell }; delete value.dwellMs;
    }
    if (item && e.type === "article" && value.manualFinished?.pending) {
      value = {...value,manualFinished:{value:value.manualFinished.value,stamp}};
      after.articles[e.id].manualFinished=value.manualFinished;
    }
    const record: SyncRecord = {type:e.type,id:e.id,value,stamp,deleted:!item,generation,...(e.articleId?{articleId:e.articleId}:{})};
    state.records[key] = mergeRecord(existing,record);
    if(e.type === "archive" && !record.deleted && after.archivePending?.[e.id]?.version===object(record.value).version) {
      after.archivePendingRecords = {...object(after.archivePendingRecords),[e.id]:record};
    }
    // Archive metadata only publishes after its files have been uploaded.
    if (e.type !== "archive" || record.deleted) { state.outbox.push({opId:crypto.randomUUID(),record}); queued.add(key); }
  }
  if (queued.size) foldOutbox(state,queued);
  // 操作比记录还多，说明队列里压着折叠上线之前攒下的重复；没开同步的设备只有这儿能清
  if (state.outbox.length > Object.keys(state.records).length) foldOutbox(state);
}

export function projectRecords(state: SyncState): void {
  const data = state.data;
  for (const k of Object.keys(data)) if (/^(p:|pos:|r:|t:)/.test(k)) delete data[k];
  const articles: Record<string,Article> = {}, sessions:Session[] = [], snippets:any[] = [], cards:StoredCard[] = [], articleCards:ArticleCard[] = [], events:any[] = [];
  const bases: Record<string,FsrsState> = {}, archives:Record<string,unknown> = {}, deleted:Record<string,number> = {};
  const paragraphs = new Map<string,ParagraphRecord[]>();
  const active = Object.values(state.records).filter(r => {
    if (r.deleted) {
      if(r.type === "article") deleted[r.id] = r.stamp.counter || 1;
      if(r.type === "setting" && data.settings)delete data.settings[r.id];
      return false;
    }
    if (!r.articleId) return true;
    const parent = state.records[recordKey({type:"article",id:r.articleId})];
    return !parent || (!parent.deleted && parent.generation === r.generation);
  });
  for (const r of active) {
    const v = structuredClone(object(r.value));
    switch(r.type) {
      case "article": articles[r.id] = v as Article; break;
      case "session": sessions.push(v as Session); break;
      case "snippet": snippets.push(v); break;
      case "paragraph": {
        const list = paragraphs.get(r.articleId!) ?? [];
        list.push({...v,dwellMs:Object.values(object(v.dwell)).reduce((n:number,x) => n+Number(x),0)} as ParagraphRecord); paragraphs.set(r.articleId!,list); break;
      }
      case "position": data[`pos:${r.id}`] = v; break;
      case "articleReview": data[`r:${r.id}`] = v; break;
      case "articleText": data[`t:${r.id}`] = v; break;
      case "archive": archives[r.id] = v; break;
      case "reviewEvent": events.push({...v,_stamp:r.stamp}); break;
      case "card": bases[`word:${r.id}`] = v.base; cards.push({...v.base,id:v.id,key:r.id,snippetIds:v.snippetIds}); break;
      case "articleCard": bases[`article:${r.id}`] = v.base; articleCards.push({...v.base,articleId:r.id}); break;
      case "setting": data.settings = {...object(data.settings),[r.id]:r.value}; break;
    }
  }
  // A Lamport order preserves each device's observed review order; wall time feeds FSRS only.
  events.sort((a,b) => compareStamp(a._stamp,b._stamp) || a.id.localeCompare(b.id));
  for (const e of events) {
    const list = e.kind === "article" ? articleCards : cards;
    const at = list.findIndex(c => "key" in c ? c.key === e.cardKey : c.articleId === e.cardKey);
    if (at < 0) continue;
    const card = list[at]!;
    list[at] = gradeFsrs(card,e.grade,Math.max(e.ts,card.lastReview ?? 0));
  }
  const snippetById = new Map(snippets.map(s => [s.id,s]));
  for (const c of cards) {
    // Sources are resolved from surviving snippets so deletion cannot be undone by a card union.
    c.snippetIds = c.snippetIds.filter(id => snippetById.has(id));
    for (const id of c.snippetIds) snippetById.get(id)!.cardId = c.id;
  }
  const settings = {...DEFAULT_SETTINGS,...object(data.settings)};
  for(const [key,cached] of Object.entries(data))if(key.startsWith("rh:")&&[object(cached).url,object(cached).finalUrl].some(url=>typeof url==="string"&&deleted[normalizeUrl(url)]))delete data[key];
  for (const [id,list] of paragraphs) { list.sort((a,b)=>a.index-b.index); data[`p:${id}`] = list; }
  sessions.sort((a,b)=>a.startTs-b.startTs || a.id.localeCompare(b.id));
  for (const a of Object.values(articles)) {
    const mine = sessions.filter(s=>s.articleId===a.id), read = (paragraphs.get(a.id) ?? []).filter(p=>p.firstSeenTs>0);
    a.wordsRead = read.reduce((n,p)=>n+p.words,0); a.readParagraphCount=read.length;
    a.sessionCount=mine.length; a.totalMs=mine.reduce((n,s)=>n+s.endTs-s.startTs,0); a.maxSessionMs=mine.reduce((n,s)=>Math.max(n,s.endTs-s.startTs),0);
    a.readingMs=mine.filter(s=>s.wordsRead>0).reduce((n,s)=>n+s.endTs-s.startTs,0);
    const episodes=mergeEpisodes(mine,settings.episodeGapMs); a.episodeCount=episodes.length; a.maxEpisodeMs=episodes.reduce((n,e)=>Math.max(n,e.activeMs),0);
    const manual=object((a as unknown as Record<string,unknown>).manualFinished);
    if(typeof manual.value === "boolean") {a.finished=manual.value; if(!a.finished)a.finishedTs=null;}
    else if(!a.finished && isFinished({...a,finishRatio:settings.finishRatio})) {a.finished=true;a.finishedTs=a.lastSeenTs;}
  }
  Object.assign(data,{articles,sessions,snippets,cards:cards.filter(c=>c.snippetIds.length>0),articleCards:articleCards.filter(c=>articles[c.articleId]?.finished!==false),reviewBases:bases,
    reviewEvents:events.map(({_stamp,...e})=>e),archives,deletedArticles:deleted,speed:summarizeSpeed(sessions,Date.now())});
}

/**
 * 返回这批记录有没有让本机的数据变样。自己刚传上去的那几条会在收尾的下载里原样回来，
 * 合并之后和本机已有的一模一样——这种不算，开着的页面用不着为它重画（见 notifyProjection）。
 */
export async function applyRemote(driver:StateDriver, records:SyncRecord[], cursor:number, expectedConfig?:SyncConfig):Promise<boolean> {
  return withDataLock(()=>driver.update(state=>{
    if(expectedConfig && JSON.stringify(state.config)!==JSON.stringify(expectedConfig))throw new Error("同步配置已改变，本轮已停止");
    let altered=false;
    for(const raw of records) {
      const r=validateRecord(raw);state.counter=Math.max(state.counter,r.stamp.counter); const key=recordKey(r);
      const merged=mergeRecord(state.records[key],r);
      if(!altered&&JSON.stringify(merged)!==JSON.stringify(state.records[key]))altered=true;
      state.records[key]=merged;
    }
    // Records already contain local optimistic operations; merging never removes the outbox.
    projectRecords(state); state.cursor=Math.max(state.cursor,cursor);
    return altered;
  }));
}
let installed: chrome.storage.StorageArea | undefined;
let driver:StateDriver | undefined;
let changed:()=>void=()=>{};
let mirrorProjection:((data:Record<string,unknown>)=>Promise<void>)|undefined;
let clearLegacy:(()=>Promise<void>)|undefined;
/**
 * 同步让本机数据变了样之后：把设置和速度镜像出去，再告诉开着的页面「该重新取一次了」。
 *
 * 页面在哪儿取决于宿主。App 里同步就跑在页面自己的上下文里，派一个 window 事件；扩展里同步跑在
 * service worker，首页和弹窗在别的上下文，只能经 runtime 广播（`sync:updated`）——不通知的话，
 * 手机上刚读的文章早就拉到本机了，开着的首页却还是打开那一刻的样子，得手动刷新才看得见。
 *
 * altered=false（这一页什么都没拉到，或拉到的只是自己刚传上去的）只镜像、不通知：
 * 每分钟一轮的空转不该让页面每分钟重画一次。
 */
export async function notifyProjection(altered=true):Promise<void> {
  const s=await syncDriver().read();
  if(mirrorProjection)await mirrorProjection({settings:s.data.settings??DEFAULT_SETTINGS,speed:s.data.speed??null});
  if(!altered)return;
  if(typeof window!=="undefined") {window.dispatchEvent(new CustomEvent("focus-sync-updated"));return;}
  // 没有页面开着时 sendMessage 会拒绝（Receiving end does not exist），正常
  try {void (chrome.runtime.sendMessage({type:"sync:updated"} satisfies BgToPage) as Promise<unknown>|undefined)?.catch?.(()=>undefined);} catch { /* 不在扩展里（测试），或扩展正在重载 */ }
}
export const localStorage = ():chrome.storage.StorageArea => installed ?? chrome.storage.local;
export const syncDriver = ():StateDriver => {if(!driver)throw new Error("本地同步数据库尚未就绪");return driver;};
export const hasSyncStorage = ():boolean => Boolean(driver);
export function onLocalMutation(fn:()=>void):void {changed=fn;}
export function installStorage(stateDriver:StateDriver, mirror?: (data:Record<string,unknown>)=>Promise<void>, cleanupLegacy?:()=>Promise<void>):void {
  driver=stateDriver;
  mirrorProjection=mirror;
  clearLegacy=cleanupLegacy;
  const notify=async()=>{changed(); if(mirror) {const state=await stateDriver.read(); await mirror({settings:state.data.settings??DEFAULT_SETTINGS,speed:state.data.speed??null}).catch(()=>undefined);}};
  installed={
    async get(keys:string|string[]|Record<string,unknown>|null=null) {
      const {data}=await stateDriver.read(); if(keys===null)return structuredClone(data);
      const list=typeof keys === "string"?[keys]:Array.isArray(keys)?keys:Object.keys(keys);
      return structuredClone(Object.fromEntries(list.flatMap(k=>data[k]!==undefined?[[k,data[k]]]: typeof keys === "object"&&!Array.isArray(keys)?[[k,keys[k]]]:[])));
    },
    async set(items:Record<string,unknown>) {await stateDriver.update(state=>{const before=structuredClone(state.data);Object.assign(state.data,structuredClone(items));trackChanges(state,before,state.data);projectRecords(state);});await notify();},
    async remove(keys:string|string[]) {await stateDriver.update(state=>{const before=structuredClone(state.data);for(const k of Array.isArray(keys)?keys:[keys])delete state.data[k];trackChanges(state,before,state.data);projectRecords(state);});await notify();},
    async clear() {await resetLocal();},
  } as unknown as chrome.storage.StorageArea;
}
export async function resetLocal():Promise<void> {
  await syncDriver().update(s=>{
    const keep={settings:s.data.settings,llm:s.data.llm}; Object.assign(s,freshState(keep));trackChanges(s,{},s.data);
  });
  await clearLegacy?.();
  await notifyProjection();
}
