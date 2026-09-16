'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {splitText,compactUtilityBody}=require('./utility-compactor');
const {buildPrompt}=require('./bridge-core');

test('splitText covers the complete source with no omitted bytes',()=>{
  const source=Array.from({length:12000},(_,index)=>`line ${index}: requirement-${index}\n`).join('');
  assert.equal(splitText(source,34000).join(''),source);
});

test('small utility request is unchanged',async()=>{
  const body={messages:[{role:'system',content:'Return JSON.'},{role:'user',content:'Summarize A.'}]};
  const result=await compactUtilityBody(body,()=>{throw new Error('must not summarize')});
  assert.equal(result.compacted,false);
  assert.equal(result.body,body);
});

test('oversized utility request is semantically compacted before final prompt',async()=>{
  const source=Array.from({length:8000},(_,index)=>`fact-${index}: preserve the server decision and file path /workspace/${index}\n`).join('');
  const seen=[];
  const body={messages:[{role:'system',content:'Return only a concise factual summary.'},{role:'user',content:source}]};
  const result=await compactUtilityBody(body,async prompt=>{
    seen.push(prompt);
    return `Relevant facts from chunk ${seen.length}: server decision, /workspace/${seen.length}.`;
  });
  assert.equal(result.compacted,true);
  assert.ok(result.chunks>1);
  const submitted=seen.map(prompt=>prompt.split('\n\nCHUNK:\n')[1]).join('');
  assert.equal(submitted,`[MESSAGE 1 ROLE=system]\nReturn only a concise factual summary.\n\n[MESSAGE 2 ROLE=user]\n${source}`);
  assert.ok(result.body.messages[1].content.includes('Relevant facts from chunk 1'));
  const final=buildPrompt(result.body,180000,null,null,{callScope:'utility:0:v3',preserveUtilityContext:true});
  assert.ok(final.length<64000);
  assert.doesNotMatch(final,/utility context compacted by transport/);
});

test('very large utility history is reduced in bounded semantic levels',async()=>{
  const body={messages:[{role:'user',content:'alpha\n'.repeat(200000)}]};
  let sourceCalls=0;
  let summaryCalls=0;
  const result=await compactUtilityBody(body,async prompt=>{
    if(prompt.includes('of a TRANSCRIPT message')) sourceCalls++;
    else if(prompt.includes('of a SUMMARY message')) summaryCalls++;
    return `Relevant facts retained from semantic pass ${sourceCalls+summaryCalls}: `+'fact '.repeat(600);
  });
  assert.equal(sourceCalls,result.chunks);
  assert.ok(summaryCalls>0);
  assert.ok(result.body.messages[1].content.length<42000);
});
