'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { activeProviderRejection } = require('./provider-rejection');

function candidate(text, {conversation=false, containsConversation=false, visible=true}={}) {
  return {
    innerText:text,
    getBoundingClientRect:()=>({height:visible?24:0}),
    closest:()=>conversation ? {} : null,
    querySelector:()=>containsConversation ? {} : null,
  };
}
function evaluate(elements) {
  const previous=global.document;
  global.document={querySelectorAll:selector=>elements.filter(item=>item.selectors.includes(selector)).map(item=>item.element)};
  try { return activeProviderRejection(); }
  finally { global.document=previous; }
}
test('a user prompt mentioning too many requests is not a provider rejection',()=>{
  const user=candidate('Corrija o erro too many requests e confirme a resposta', {conversation:true});
  assert.equal(evaluate([{selectors:['[role="alert"]'],element:user}]),'');
});
test('a broad banner wrapping a user turn cannot launder its text into an error',()=>{
  const wrapper=candidate('Corrija o erro too many requests', {containsConversation:true});
  assert.equal(evaluate([{selectors:['[class*="banner"]'],element:wrapper}]),'');
});
test('a visible provider toast is recognized without scanning the conversation',()=>{
  const toast=candidate('Too many requests. Try again later.');
  assert.equal(evaluate([{selectors:['[data-testid*="toast"]'],element:toast}]),'Too many requests. Try again later.');
});
test('hidden historical notices are ignored',()=>{
  const notice=candidate('Messages limit reached', {visible:false});
  assert.equal(evaluate([{selectors:['[role="alert"]'],element:notice}]),'');
});
