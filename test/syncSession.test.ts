import assert from "node:assert/strict";
import test from "node:test";
import { freshState, installStorage, memoryDriver, trackChanges } from "../src/sync/storage.ts";
import { handle, recoverOpen } from "../src/background/handle.ts";

test("session recovery retains its checkpoint on a failed durable write and real-end retries reuse identity", async()=>{
  const id="https://example.com/recovery";
  const state=freshState({articles:{[id]:{id,url:id,title:"Recovery",totalWords:100,trackedWords:100,paragraphCount:1,
    wordsRead:0,readParagraphCount:0,sessionCount:0,totalMs:0,maxSessionMs:0,firstSeenTs:1000,lastSeenTs:1000,
    reachedBottom:false,finished:false,finishedTs:null}}});
  trackChanges(state,{},state.data,true);
  const driver=memoryDriver(state);
  let fail=true;
  installStorage({read:()=>driver.read(),update:fn=>{if(fail)return Promise.reject(new Error("disk full"));return driver.update(fn);}});
  const ephemeral:Record<string,unknown>={open:{"1":{id:"stable-session",tabId:1,articleId:id,url:id,title:"Recovery",startTs:1000,lastBeatTs:11_000,wordsRead:100}}};
  const prior=(globalThis as any).chrome;
  (globalThis as any).chrome={storage:{session:{
    get:async(key:string)=>structuredClone({[key]:ephemeral[key]}),
    set:async(values:Record<string,unknown>)=>{Object.assign(ephemeral,structuredClone(values));},
  }}};
  try {
    await assert.rejects(recoverOpen(1),/disk full/);
    assert.ok((ephemeral.open as any)["1"],"a failed commit must remain recoverable after the worker restarts");
    assert.equal((await driver.read()).data.sessions,undefined);
    fail=false;
    await recoverOpen(1);
    assert.deepEqual(ephemeral.open,{});
    assert.equal((await driver.read()).data.sessions[0].id,"stable-session");
    const message={type:"session:end" as const,articleId:id,startTs:1000,endTs:21_000,wordsRead:100,endReason:"hidden" as const,
      discard:false,reachedBottom:false,paragraphs:[{index:0,hash:"p1",words:100,firstSeenTs:2000,dwellMs:500}]};
    await handle(message,{tab:{id:1}});
    await handle(message,{tab:{id:1}});
    const final=await driver.read();
    assert.equal(final.data.sessions.length,1);
    assert.equal(final.data.sessions[0].id,"stable-session");
    assert.equal(final.data.sessions[0].endTs,21_000);
    assert.equal(final.data[`p:${id}`][0].dwellMs,500);
    assert.equal(final.data.articles[id].totalMs,20_000);
  }finally{if(prior===undefined)delete(globalThis as any).chrome;else(globalThis as any).chrome=prior;}
});
