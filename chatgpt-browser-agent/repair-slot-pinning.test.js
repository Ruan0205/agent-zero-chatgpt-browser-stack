const {test}=require('node:test');
const assert=require('node:assert/strict');
const {BrowserPool}=require('./browser-pool');

test('isolated repair keeps main and utility on separate permanent browsers',async()=>{
  const previous=process.env.REPAIR_SLOT_PINNING;
  process.env.REPAIR_SLOT_PINNING='true';
  const pool=new BrowserPool({minSize:2,maxSize:2,
    loadAssignments:()=>({'repair-main':'browser-2','utility-dedicated-chat-v1':'browser-1'}),
    saveAssignments:()=>{},
    onWarm:async()=>{},
  });
  try {
    const main=await pool._acquire('repair-main');
    const utility=await pool._acquire('utility-dedicated-chat-v1');
    assert.equal(main.id,'browser-1');
    assert.equal(utility.id,'browser-2');
    assert.equal(pool.assignments['repair-main'],'browser-1');
    assert.equal(pool.assignments['utility-dedicated-chat-v1'],'browser-2');
  } finally {
    await pool.shutdown();
    if(previous===undefined) delete process.env.REPAIR_SLOT_PINNING;
    else process.env.REPAIR_SLOT_PINNING=previous;
  }
});
