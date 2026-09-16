'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {finalResponseText}=require('./audit-eligibility');

test('auditor receives only Agent Zero final response envelopes',()=>{
  assert.equal(finalResponseText(JSON.stringify({tool_name:'response',tool_args:{text:'Resposta final.'}})),'Resposta final.');
  assert.equal(finalResponseText(JSON.stringify({tool_name:'code_execution_tool',tool_args:{code:'print(1)'}})),null);
  assert.equal(finalResponseText(JSON.stringify({tool_name:'chatgpt_browser_media',tool_args:{files:['a.png']}})),null);
  assert.equal(finalResponseText('Erro 429'),null);
  assert.equal(finalResponseText('{malformed'),null);
});
