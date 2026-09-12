/** Versioned, host-independent sync wire protocol. Never contains credentials. */
export const PROTOCOL_VERSION = 1;
export const RECORD_TYPES = ["article", "session", "paragraph", "position", "snippet", "card", "reviewEvent", "articleReview", "articleCard", "setting", "articleText", "archive"] as const;
export type RecordType = typeof RECORD_TYPES[number];
export interface Stamp { counter: number; deviceId: string }
export interface SyncRecord {
  type: RecordType;
  id: string;
  value: unknown;
  stamp: Stamp;
  deleted: boolean;
  generation: string;
  articleId?: string;
}
export interface SyncOperation { opId: string; record: SyncRecord }
export const recordKey = (r: Pick<SyncRecord, "type" | "id">): string => JSON.stringify([r.type, r.id]);
export function compareStamp(a: Stamp, b: Stamp): number {
  return a.counter - b.counter || (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0);
}
export function object(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
const lexical = (a:string,b:string):number => a<b?-1:a>b?1:0;
function compareGeneration(a:string,b:string):number {
  const parse=(v:string):Stamp=>{const at=v.lastIndexOf(":");return at>0 && /^\d+$/.test(v.slice(at+1)) ? {counter:Number(v.slice(at+1)),deviceId:v.slice(0,at)}:{counter:0,deviceId:v};};
  return compareStamp(parse(a),parse(b));
}
const first = (a: unknown, b: unknown): number => {
  const n = [a, b].filter((v): v is number => typeof v === "number" && v > 0);
  return n.length ? Math.min(...n) : 0;
};
/** Deterministic merge. A tombstone dominates writes in the SAME lifecycle. */
export function mergeRecord(current: SyncRecord | undefined, incoming: SyncRecord): SyncRecord {
  if (!current) return structuredClone(incoming);
  if (recordKey(current) !== recordKey(incoming)) throw new Error("Record identity mismatch");
  const order = compareStamp(current.stamp, incoming.stamp) || lexical(canonical(current),canonical(incoming));
  const winner = order >= 0 ? current : incoming;
  if (current.generation !== incoming.generation) return structuredClone(compareGeneration(current.generation,incoming.generation)>=0?current:incoming);
  if (current.deleted || incoming.deleted) {
    return structuredClone(current.deleted && incoming.deleted ? winner : current.deleted ? current : incoming);
  }
  const a = object(current.value), b = object(incoming.value);
  let value: unknown = winner.value;
  if (incoming.type === "session") {
    value = (Number(a.endTs) - Number(b.endTs)) > 0 ? a : (Number(a.endTs) - Number(b.endTs)) < 0 ? b : winner.value;
  } else if (incoming.type === "paragraph") {
    // Per-device cumulative components: max within an origin, sum across origins.
    const dwell = { ...object(a.dwell) };
    for (const [device, amount] of Object.entries(object(b.dwell))) dwell[device] = Math.max(Number(dwell[device] ?? 0), Number(amount));
    value = { ...object(winner.value), dwell, firstSeenTs: first(a.firstSeenTs, b.firstSeenTs) };
  } else if (incoming.type === "card") {
    const av = object(a.base), bv = object(b.base);
    const baseOrder = Number(av.lastReview ?? -1) - Number(bv.lastReview ?? -1) || Number(av.reps ?? 0) - Number(bv.reps ?? 0) || lexical(canonical(av),canonical(bv));
    value = { ...object(winner.value), base: baseOrder >= 0 ? av : bv,
      snippetIds: [...new Set([...(a.snippetIds ?? []), ...(b.snippetIds ?? [])])].sort() };
  } else if (incoming.type === "articleCard") {
    const av = object(a.base), bv = object(b.base);
    const cmp = Number(av.lastReview ?? -1) - Number(bv.lastReview ?? -1) || Number(av.reps ?? 0) - Number(bv.reps ?? 0) || lexical(canonical(av),canonical(bv));
    value = { ...object(winner.value), base: cmp >= 0 ? av : bv };
  } else if (incoming.type === "article") {
    const manualA = object(a.manualFinished), manualB = object(b.manualFinished);
    let manual = a.manualFinished ?? b.manualFinished;
    if (manualA.stamp && manualB.stamp) manual = compareStamp(manualA.stamp, manualB.stamp) >= 0 ? a.manualFinished : b.manualFinished;
    value = { ...object(winner.value), firstSeenTs: first(a.firstSeenTs,b.firstSeenTs),
      lastSeenTs: Math.max(Number(a.lastSeenTs ?? 0),Number(b.lastSeenTs ?? 0)),
      reachedBottom: Boolean(a.reachedBottom || b.reachedBottom), finished: Boolean(a.finished || b.finished),
      finishedTs: first(a.finishedTs,b.finishedTs) || null, ...(manual ? { manualFinished: manual } : {}) };
  }
  return structuredClone({ ...winner, value });
}

export function validateRecord(input: unknown): SyncRecord {
  const r = object(input), s = object(r.stamp);
  const validText = (v: unknown, max = 4096): v is string => typeof v === "string" && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/.test(v);
  if (!RECORD_TYPES.includes(r.type) || !validText(r.id) || !validText(r.generation,128) || !validText(s.deviceId,128)
      || !Number.isSafeInteger(s.counter) || s.counter < 0 || typeof r.deleted !== "boolean"
      || (r.articleId !== undefined && !validText(r.articleId))) throw new Error("Invalid sync record");
  if (r.type === "setting" && !["idleTimeoutMs","stallTimeoutMs","minSessionMs","maxQuietMs","paragraphDwellMs","readFraction","episodeGapMs","articleExcludedUrls","translationExcludedUrls","translateEnabled","minSelectionChars","maxAutoSelectionWords","contextChars","explainVocab","finishRatio","restorePositionEnabled","articleReviewEnabled"].includes(r.id)) throw new Error("Unsupported synchronized setting");
  if (JSON.stringify(input).length > 512_000) throw new Error("Sync record too large");
  if (!r.deleted) {
    const v = object(r.value);
    const finite=(n:unknown)=>typeof n==="number"&&Number.isFinite(n)&&n>=0;
    const texts=(a:unknown)=>Array.isArray(a)&&a.length<=10000&&a.every(x=>validText(x));
    const url=(s:unknown)=>{try{const u=new URL(String(s));return ["http:","https:"].includes(u.protocol)&&!u.username&&!u.password;}catch{return false;}};
    const fsrs=(base:unknown)=>{const f=object(base);return ["due","stability","difficulty","elapsed_days","scheduled_days","learning_steps","reps","lapses","state"].every(k=>finite(f[k])) && [0,1,2,3].includes(f.state) && (f.lastReview===null||finite(f.lastReview));};
    if (r.type !== "setting" && (!r.value || typeof r.value !== "object" || Array.isArray(r.value))) throw new Error("Invalid entity value");
    if (["article","session","snippet","reviewEvent"].includes(r.type)&&v.id!==r.id)throw new Error("Entity identity mismatch");
    if (["article","position","articleReview","articleCard","articleText","archive"].includes(r.type)&&!url(r.id))throw new Error("Invalid article identity");
    if (r.articleId!==undefined && !url(r.articleId))throw new Error("Invalid parent article");
    if (["session","position","articleReview","articleCard","articleText","archive"].includes(r.type)&&v.articleId!==r.articleId)throw new Error("Parent identity mismatch");
    if (r.type==="article" && (![v.totalWords,v.trackedWords,v.paragraphCount,v.firstSeenTs,v.lastSeenTs].every(finite)||typeof v.title!=="string"||!url(v.url)||typeof v.finished!=="boolean"||typeof v.reachedBottom!=="boolean"))throw new Error("Invalid article");
    if (r.type==="card" && (v.key!==r.id||!validText(v.id)||!texts(v.snippetIds)||!fsrs(v.base)))throw new Error("Invalid review card");
    if (r.type==="articleCard" && !fsrs(v.base))throw new Error("Invalid article review card");
    if(r.type==="position"&&(!validText(v.hash)||![v.index,v.paragraphCount,v.savedTs].every(finite)||typeof v.offset!=="number"||!Number.isFinite(v.offset)))throw new Error("Invalid reading position");
    if(r.type==="snippet"&&(!url(v.articleId)||!["word","phrase","sentence"].includes(v.kind)||!["text","context","translation","contextNote","articleTitle"].every(k=>typeof v[k]==="string")||!finite(v.createdTs)||(v.vocab!==undefined&&!Array.isArray(v.vocab))))throw new Error("Invalid snippet");
    if(r.type==="setting") {
      const booleans=["translateEnabled","explainVocab","restorePositionEnabled","articleReviewEnabled"];
      const lists=["articleExcludedUrls","translationExcludedUrls"];
      if(booleans.includes(r.id)?typeof r.value!=="boolean":lists.includes(r.id)?!texts(r.value):!finite(r.value))throw new Error("Invalid setting value");
    }
    if (r.type === "session" && (![v.startTs,v.endTs,v.wordsRead].every(n => typeof n === "number" && Number.isFinite(n) && n >= 0) || v.endTs < v.startTs || !validText(v.articleId))) throw new Error("Invalid session");
    if (r.type === "reviewEvent" && (!["word","article"].includes(v.kind)||![1,2,3,4].includes(v.grade) || !Number.isFinite(v.ts) || v.ts < 0 || !validText(v.cardKey) || v.algorithm !== "fsrs-5-default-v1")) throw new Error("Invalid review event");
    if (r.type === "paragraph" && (!validText(v.hash)||![v.index,v.words,v.firstSeenTs].every(finite)||Object.values(object(v.dwell)).some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0))) throw new Error("Invalid paragraph duration");
    if(r.type==="articleText" && typeof v.text!=="string")throw new Error("Invalid article text");
    if(r.type==="articleReview" && (!texts(v.outline)||!texts(v.questions)||!finite(v.generatedTs)||typeof v.model!=="string"))throw new Error("Invalid article review");
    if(r.type==="archive" && (!/^[a-f0-9]{64}$/.test(v.htmlHash)||!validText(v.version)||!Array.isArray(v.resources)||!Array.isArray(v.missingResources)||typeof v.title!=="string"||!url(v.url)))throw new Error("Invalid archive");
  }
  return structuredClone({ type:r.type,id:r.id,value:r.value ?? null,stamp:{counter:s.counter,deviceId:s.deviceId},deleted:r.deleted,generation:r.generation,...(r.articleId ? {articleId:r.articleId}:{}) }) as SyncRecord;
}
