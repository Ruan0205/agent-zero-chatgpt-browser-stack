'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {retryProviderRejection}=require('./retry-policy');

test('active thinking or a safety timeout never authorizes resubmission',()=>{
  assert.equal(retryProviderRejection(new Error('Timed out waiting for ChatGPT to publish its assistant turn after visible processing'),0,2),false);
  assert.equal(retryProviderRejection(new Error('ChatGPT browser request timed out'),0,2),false);
  assert.equal(retryProviderRejection(new Error('Prompt submission was not acknowledged'),0,2),false);
});
test('a verified provider 429 retains at most two retry opportunities',()=>{
  const error=new Error('ChatGPT rejected the request: Too many requests');
  assert.equal(retryProviderRejection(error,0,2),true);
  assert.equal(retryProviderRejection(error,1,2),true);
  assert.equal(retryProviderRejection(error,2,2),false);
});
