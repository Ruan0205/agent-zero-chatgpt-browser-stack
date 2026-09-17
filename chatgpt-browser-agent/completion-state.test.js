'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {canCollectCompletedTurn}=require('./completion-state');

test('unchanged text is not final while the model is visibly still thinking',()=>{
  assert.equal(canCollectCompletedTurn({isExpected:true,busy:true,final:false},120_000,2_000),false);
});
test('a finished turn is collected promptly without a fixed long wait',()=>{
  assert.equal(canCollectCompletedTurn({isExpected:true,busy:false,final:true},2_000,2_000),true);
  assert.equal(canCollectCompletedTurn({isExpected:true,busy:false,final:false},2_000,2_000),true);
});
test('a stale busy control is outweighed only by a final response action',()=>{
  assert.equal(canCollectCompletedTurn({isExpected:true,busy:true,final:true},2_000,2_000),true);
});
test('a different or failed turn cannot be returned',()=>{
  assert.equal(canCollectCompletedTurn({isExpected:false,busy:false,final:true},120_000,2_000),false);
  assert.equal(canCollectCompletedTurn({isExpected:true,failed:true,busy:false,final:true},120_000,2_000),false);
});
