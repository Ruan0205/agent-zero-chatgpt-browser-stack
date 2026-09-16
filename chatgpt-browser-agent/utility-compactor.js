'use strict';

// Utility calls can contain an entire Agent Zero history. Never shorten that
// history with head/tail slicing: ask the dedicated browser model to condense
// every chunk before it receives the final utility task.
const crypto=require('crypto');

function contentText(content) {
  if(typeof content==='string') return content;
  if(Array.isArray(content)) return content.map(part=>typeof part==='string'?part:String(part?.text||'')).join('\n');
  return JSON.stringify(content??'');
}

function splitText(text,maxChars=34000) {
  const chunks=[];
  let cursor=0;
  while(cursor<text.length) {
    let end=Math.min(text.length,cursor+maxChars);
    if(end<text.length) {
      const newline=text.lastIndexOf('\n',end);
      if(newline>cursor+Math.floor(maxChars*0.65)) end=newline+1;
    }
    chunks.push(text.slice(cursor,end));
    cursor=end;
  }
  return chunks;
}

function summaryRequest(role,index,total,chunk) {
  const digest=crypto.createHash('sha256').update(chunk).digest('hex');
  return `You are preparing context for a separate utility operation. This is chunk ${index+1}/${total} of a ${role.toUpperCase()} message. Do NOT answer the operation yet. Semantically compact this entire chunk to at most 3500 characters. Preserve concrete facts, identifiers, paths, commands, errors, decisions, active requirements, open work, and exact values needed later. For a SYSTEM chunk, preserve operational instructions and output format. Mark uncertainty rather than inventing or silently dropping relevant information. Return ONLY the compacted notes as plain text. Source SHA-256: ${digest}\n\nCHUNK:\n${chunk}`;
}

async function compactUtilityBody(body,summarize,options={}) {
  const maxInputChars=Math.max(12000,Number(options.maxInputChars)||42000);
  const chunkChars=Math.max(6000,Number(options.chunkChars)||34000);
  const messages=Array.isArray(body?.messages)?body.messages:[];
  const inputChars=messages.reduce((sum,message)=>sum+contentText(message.content).length,0);
  if(inputChars<=maxInputChars) return {body,compacted:false,inputChars,chunks:0};

  // Group small adjacent messages as well as oversize individual messages.
  // No part of the source is discarded before the browser has read it.
  const source=messages.map((message,index)=>`[MESSAGE ${index+1} ROLE=${message.role}]\n${contentText(message.content)}`).join('\n\n');
  const chunks=splitText(source,chunkChars);
  const summaries=[];
  for(let index=0;index<chunks.length;index++) {
    const result=String(await summarize(summaryRequest('transcript',index,chunks.length,chunks[index]))||'').trim();
    if(!result || result.length>8000) throw new Error(`Utility context chunk ${index+1}/${chunks.length} was not compacted into a usable summary`);
    summaries.push(`[CHUNK ${index+1}/${chunks.length}]\n${result}`);
  }
  let combined=summaries.join('\n\n');
  for(let level=0;combined.length>maxInputChars;level++) {
    if(level>=8) throw new Error('Utility context semantic reduction exceeded eight levels');
    const parts=splitText(combined,chunkChars);
    const reduced=[];
    for(let index=0;index<parts.length;index++) {
      const result=String(await summarize(summaryRequest('summary',index,parts.length,parts[index]))||'').trim();
      if(!result || result.length>8000)
        throw new Error(`Utility context summary ${index+1}/${parts.length} was not compacted into usable notes`);
      reduced.push(`[SUMMARY LEVEL ${level+1} PART ${index+1}/${parts.length}]\n${result}`);
    }
    const next=reduced.join('\n\n');
    if(next.length>=combined.length) throw new Error('Utility context semantic reduction did not shrink');
    combined=next;
  }
  const system=messages.filter(message=>message.role==='system').map(message=>contentText(message.content)).join('\n\n');
  // Preserve short instructions verbatim; long system text was already read
  // and condensed above. The latest task is represented in the notes too.
  const retainedSystem=system.length<=8000?system:'Follow the current utility task and requested output format using the complete semantically compacted context below.';
  const compactedBody={...body,messages:[
    {role:'system',content:retainedSystem},
    {role:'user',content:`SEMANTICALLY COMPACTED CALLER CONTEXT (all ${chunks.length} chunks were read by the browser; source characters=${inputChars}):\n${combined}\n\nNow perform the original utility operation. Return only its requested output.`},
  ]};
  return {body:compactedBody,compacted:true,inputChars,chunks:chunks.length};
}

module.exports={splitText,summaryRequest,compactUtilityBody};
