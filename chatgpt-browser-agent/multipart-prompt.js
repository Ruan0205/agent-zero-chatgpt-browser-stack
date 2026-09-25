'use strict';

const crypto=require('crypto');
const {composerChunks}=require('./composer-chunks');

// This is a browser-editor threshold, not a model-context or file-size limit.
// ChatGPT's editor was observed discarding input after 18,412 characters.
const DEFAULT_SINGLE_MESSAGE_CHARS=12_000;
const PART_BODY_CHARS=10_500;

function planMultipartPrompt(prompt, singleMessageChars=DEFAULT_SINGLE_MESSAGE_CHARS) {
  const source=String(prompt);
  if(source.length<=singleMessageChars) return null;
  const id=crypto.createHash('sha256').update(source).digest('hex').slice(0,16);
  const chunks=composerChunks(source,PART_BODY_CHARS);
  const total=chunks.length;
  const announcement=`[Agent Zero multipart request ${id}]\nThe complete request is too long for one browser-editor message. I will send it in ${total} numbered parts in this same conversation. Treat the parts as one continuous request, preserving their exact order. Do not execute the task, call tools, produce files, or give a final answer until part ${total}/${total} arrives. For this announcement and each non-final part, reply only ACK ${id} and the part number.`;
  const parts=chunks.map((chunk,index)=>{
    const number=index+1;
    const remaining=total-number;
    const header=`[Agent Zero multipart request ${id}: part ${number}/${total}; ${remaining} part(s) remaining]\nThe text between the BEGIN and END markers is a verbatim segment of ONE request. Preserve it in order.\nBEGIN PART ${number}/${total}\n`;
    const footer=remaining
      ? `\nEND PART ${number}/${total}\n${remaining} part(s) remain. Do not act yet. Reply only ACK ${id} ${number}/${total}.`
      : `\nEND PART ${number}/${total}\nThis was the final part. Now use all ${total} parts, in order, as the complete Agent Zero request. Perform the task and return its required final answer. Do not answer with an ACK.`;
    return header+chunk+footer;
  });
  if(parts.some(part=>part.length>=singleMessageChars)) throw new Error('Multipart part exceeds browser-editor safety size');
  return {id,total,announcement,parts,source};
}

module.exports={planMultipartPrompt,DEFAULT_SINGLE_MESSAGE_CHARS};
