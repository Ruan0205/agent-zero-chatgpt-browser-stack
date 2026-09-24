'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {canCollectCompletedTurn,isDownloadTextCandidate,isCompletedEmptyTurn}=require('./completion-state');

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
test('installer download text inside an Agent Zero JSON code block is not an artifact response',()=>{
  const state={hasCodeBlock:true,text:'JSON\\n{"tool_name":"code_execution_tool","tool_args":{"code":"Download python-3.11.9-amd64.exe"}}'};
  assert.equal(isDownloadTextCandidate(state),false);
  assert.equal(isDownloadTextCandidate({hasCodeBlock:false,text:'Download report.pdf'}),true);
});
test('finished empty assistant turn is distinct from ongoing thinking',()=>{
  assert.equal(isCompletedEmptyTurn({isExpected:true,hasAssistant:true,final:true,busy:false,text:'',media:''}),true);
  assert.equal(isCompletedEmptyTurn({isExpected:true,hasAssistant:true,final:false,busy:true,text:'',media:''}),false);
  assert.equal(isCompletedEmptyTurn({isExpected:false,hasAssistant:true,final:true,busy:false,text:'',media:''}),false);
});
