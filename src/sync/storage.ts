import type { Article, ArticleCard, FsrsState, ParagraphRecord, Session, StoredCard } from "../types.ts";
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
function entries(data: Record<string, any>): Map<string, Entry> {
  const result = new Map<string, Entry>();
  const add = (type: RecordType,id: string,value: any,articleId?: string) => { const e = {type,id,value,articleId}; result.set(recordKey(e),e); };
  for (const [id,a] of Object.entries(object(data.articles))) {
    const v = { ...object(a) };
    for (const key of ["wordsRead","readParagraphCount","sessionCount","totalMs","maxSessionMs","episodeCount","maxEpisodeMs","readingMs"]) delete v[key];
    add("article",id,v);
  }
  for (const s of data.sessions ?? []) add("session", s.id,s,s.articleId);
  for (const s of data.snippets ?? []) add("snippet",s.id,s);
  for (const c of data.cards ?? []) add("card",c.key,{ id:c.id,key:c.key,snippetIds:c.snippetIds,base:object(data.reviewBases)[`word:${c.key}`] ?? c });
  for (const c of data.articleCards ?? []) add("articleCard",c.articleId,{articleId:c.articleId,base:object(data.reviewBases)[`article:${c.articleId}`] ?? c},c.articleId);
  for (const e of data.reviewEvents ?? []) add("reviewEvent",e.id,e,e.kind === "article" ? e.cardKey : undefined);
  for (const [id,v] of Object.entries(object(data.archives))) add("archive",id,v,id);
  for (const [id,v] of Object.entries(object(data.settings))) {
    if (id in DEFAULT_SETTINGS && id !== "excludedDomains") add("setting",id,v);
  }
  for (const [k,v] of Object.entries(data)) {
    if (k.startsWith("p:") && Array.isArray(v)) for (const p of v) add("paragraph",JSON.stringify([k.slice(2),p.hash]),p,k.slice(2));
    else if (k.startsWith("pos:")) add("position",k.slice(4),v,k.slice(4));
    else if (k.startsWith("r:")) add("articleReview",k.slice(2),v,k.slice(2));
    else if (k.startsWith("t:")) add("articleText",k.slice(2),v,k.slice(2));
  }
  return result;
}
const equal = (a: unknown,b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
/** Called inside the same transaction as local set/remove, never for remote application. */
export function trackChanges(state: SyncState, before: Record<string, any>, after: Record<string, any>, legacy = false): void {
  const prev = entries(before), next = entries(after);
  for(const id of Object.keys(object(after.deletedArticles))) {
    const key=recordKey({type:"article",id});
    if(!object(before.deletedArticles)[id]&&!prev.has(key)&&!next.has(key))prev.set(key,{type:"article",id,value:{id}});
  }
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
    if (e.type !== "archive" || record.deleted) state.outbox.push({opId:crypto.randomUUID(),record});
  }
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

export async function applyRemote(driver:StateDriver, records:SyncRecord[], cursor:number, expectedConfig?:SyncConfig):Promise<void> {
  await withDataLock(()=>driver.update(state=>{
    if(expectedConfig && JSON.stringify(state.config)!==JSON.stringify(expectedConfig))throw new Error("同步配置已改变，本轮已停止");
    for(const raw of records) {const r=validateRecord(raw);state.counter=Math.max(state.counter,r.stamp.counter); const key=recordKey(r);state.records[key]=mergeRecord(state.records[key],r);}
    // Records already contain local optimistic operations; merging never removes the outbox.
    projectRecords(state); state.cursor=Math.max(state.cursor,cursor);
  }));
}
let installed: chrome.storage.StorageArea | undefined;
let driver:StateDriver | undefined;
let changed:()=>void=()=>{};
let mirrorProjection:((data:Record<string,unknown>)=>Promise<void>)|undefined;
let clearLegacy:(()=>Promise<void>)|undefined;
export async function notifyProjection():Promise<void> {
  const s=await syncDriver().read();
  if(mirrorProjection)await mirrorProjection({settings:s.data.settings??DEFAULT_SETTINGS,speed:s.data.speed??null});
  if(typeof window!=="undefined")window.dispatchEvent(new CustomEvent("focus-sync-updated"));
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
