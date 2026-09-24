'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {composerChunks,normalizeComposerText}=require('./composer-chunks');

test('long initial prompt is transmitted losslessly in bounded chunks',()=>{
  const prompt=('Windows\r\nGodot 🎮 estrutura\n').repeat(900);
  const chunks=composerChunks(prompt,1024);
  assert.ok(chunks.length>10);
  assert.ok(chunks.every(chunk=>chunk.length<=1024));
  assert.equal(chunks.join(''),prompt);
});

test('empty prompt has no chunks and invalid sizes are refused',()=>{
  assert.deepEqual(composerChunks(''),[]);
  assert.throws(()=>composerChunks('abc',1));
});

test('contenteditable NBSP is equivalent to a boundary space but missing text is not',()=>{
  assert.equal(normalizeComposerText('segment\u00a0already present'),normalizeComposerText('segment already present'));
  assert.notEqual(normalizeComposerText('segment already'),normalizeComposerText('segment already present'));
});
