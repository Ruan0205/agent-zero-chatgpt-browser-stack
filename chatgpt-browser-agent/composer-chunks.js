'use strict';

// Keep each DevTools Input.insertText event small enough that the rich-text
// editor never has to hydrate a very large single beforeinput transaction.
function composerChunks(text, maxUnits=1024) {
  if (!Number.isInteger(maxUnits) || maxUnits<2) throw new Error('Invalid composer chunk size');
  const result=[];
  let chunk='';
  for(const char of String(text)) {
    if(chunk.length+char.length>maxUnits) {result.push(chunk);chunk='';}
    chunk+=char;
  }
  if(chunk) result.push(chunk);
  return result;
}

// Contenteditable can represent a space at a chunk boundary as NBSP to keep
// it visible. The text is semantically identical; missing or reordered
// characters still fail the full-string verification.
function normalizeComposerText(text) {
  return String(text).replace(/\u00a0/g,' ').replace(/\r/g,'').replace(/\n+/g,'\n').trim();
}

module.exports={composerChunks,normalizeComposerText};
