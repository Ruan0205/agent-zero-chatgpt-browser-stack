'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {BrowserPool}=require('./browser-pool');

test('three fixed displays process three calls and queue a fourth without scaling',async()=>{
  const started=[];
  const releases=[];
  const pool=new BrowserPool({minSize:3,maxSize:3,onWarm:async()=>{},onStop:async()=>{}});
  await pool.start();
  try {
    const calls=Array.from({length:4},(_,index)=>pool.run(`chat-${index}`,{},slot=>new Promise(resolve=>{
      started.push(slot.id);
      releases.push(()=>resolve(slot.id));
    })));
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(started.length,3);
    assert.equal(new Set(started).size,3);
    assert.equal(pool.snapshot().length,3);
    releases[0]();
    await calls[0];
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(started.length,4);
    assert.equal(started[3],started[0]);
    for(const release of releases.slice(1)) release();
    await Promise.all(calls);
  } finally {
    for(const release of releases) release();
    await pool.shutdown();
  }
});

test('legacy dynamic assignments are remapped to fixed displays and same chat is serialized',async()=>{
  let saved=null;
  const pool=new BrowserPool({
    minSize:3,maxSize:3,onWarm:async()=>{},onStop:async()=>{},
    loadAssignments:()=>({'old-chat':'browser-7'}),saveAssignments:value=>{saved={...value};},
  });
  await pool.start();
  let releaseFirst;
  const first=pool.run('old-chat',{},slot=>new Promise(resolve=>{
    releaseFirst=()=>resolve(slot.id);
  }));
  await new Promise(resolve=>setImmediate(resolve));
  let secondStarted=false;
  const second=pool.run('old-chat',{},slot=>{secondStarted=true;return slot.id;});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(secondStarted,false);
  assert.match(saved['old-chat'],/^browser-[123]$/);
  releaseFirst();
  assert.equal(await first,await second);
  assert.equal(pool.snapshot().length,3);
  await pool.shutdown();
});
