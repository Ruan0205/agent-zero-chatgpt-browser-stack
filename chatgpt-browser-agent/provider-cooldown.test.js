'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {ProviderCooldown}=require('./provider-cooldown');

test('too many requests blocks every next browser submission for at least 30 seconds',async()=>{
  let now=1_000;
  const waits=[];
  const cooldown=new ProviderCooldown({delayMs:5_000,now:()=>now,sleep:async ms=>{waits.push(ms);now+=ms;}});
  cooldown.block();
  await cooldown.wait();
  assert.deepEqual(waits,[30_000]);
  now+=2_000;
  cooldown.block();
  await cooldown.wait();
  assert.deepEqual(waits,[30_000,30_000]);
});

test('main and utility gateways share the same 30-second account cooldown',async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'a0-provider-cooldown-'));
  try {
    let now=5_000;
    const first=new ProviderCooldown({directory,now:()=>now});
    const waits=[];
    const second=new ProviderCooldown({directory,now:()=>now,sleep:async ms=>{waits.push(ms);now+=ms;}});
    first.block();
    await second.wait();
    assert.deepEqual(waits,[30_000]);
  } finally {fs.rmSync(directory,{recursive:true,force:true});}
});
