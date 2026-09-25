'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {planMultipartPrompt}=require('./multipart-prompt');

test('short prompt remains a single browser message',()=>{
  assert.equal(planMultipartPrompt('hello'),null);
});

test('large prompt announces count and reconstructs exact Unicode text',()=>{
  const prompt='A😀\r\n'.repeat(11000);
  const plan=planMultipartPrompt(prompt);
  assert.ok(plan.total>1);
  assert.match(plan.announcement,new RegExp(`${plan.total} numbered parts`));
  assert.equal(plan.parts.length,plan.total);
  const recovered=plan.parts.map((part,index)=>{
    assert.match(part,new RegExp(`part ${index+1}/${plan.total}`));
    assert.match(part,new RegExp(`${plan.total-index-1} part\\(s\\) remaining`));
    assert.ok(part.length<12000);
    return part.split(`BEGIN PART ${index+1}/${plan.total}\n`)[1].split(`\nEND PART ${index+1}/${plan.total}`)[0];
  }).join('');
  assert.equal(recovered,prompt);
  assert.match(plan.parts.at(-1),/Now use all/);
  assert.doesNotMatch(plan.parts.at(-1),/Reply only ACK/);
});
