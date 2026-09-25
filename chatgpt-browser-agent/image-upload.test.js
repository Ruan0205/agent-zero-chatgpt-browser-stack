'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {imageUploadCount,imageUploadReady,imageUploadTimeoutMs,isImageUploadTimeout,imageUploadFailureAnswer,failedUploadChatUrl,uploadedAttachmentsForTurn,isSameActiveRequest}=require('./image-upload');
const {attachmentInputs,attachmentTurnIdentity}=require('./bridge-core');

test('only image attachments receive the image-specific wait',()=>{
  assert.equal(imageUploadCount(['/tmp/a.png','/tmp/b.JPG','/tmp/c.pdf']),2);
  assert.equal(imageUploadCount(['/tmp/a.pdf']),0);
  assert.equal(imageUploadTimeoutMs(2),360_000);
});

test('enabled send button cannot hide a broken or still-loading preview',()=>{
  const state={previewCount:1,loadedCount:0,pendingCount:1,sendEnabled:true};
  assert.equal(imageUploadReady(state,1),false);
  assert.equal(imageUploadReady({...state,loadedCount:1},1),false);
  assert.equal(imageUploadReady({...state,loadedCount:1,pendingCount:0},1),true);
});

test('all image previews must finish before a multi-image request is sent',()=>{
  assert.equal(imageUploadReady({previewCount:2,loadedCount:1,pendingCount:0,sendEnabled:true},2),false);
  assert.equal(imageUploadReady({previewCount:2,loadedCount:2,pendingCount:0,sendEnabled:true},2),true);
});

test('upload timeout becomes a final Agent Zero response, not a retried tool call',()=>{
  assert.equal(isImageUploadTimeout(new Error('[ERROR] IMAGE_UPLOAD_TIMEOUT: a imagem não carregou')),true);
  assert.equal(isImageUploadTimeout(new Error('Prompt submission was not acknowledged')),false);
  assert.deepEqual(imageUploadFailureAnswer().tool_args,{text:'a imagem não carregou'});
  assert.equal(imageUploadFailureAnswer().tool_name,'response');
});

test('failed first upload never inherits another conversation from the browser slot',()=>{
  assert.equal(failedUploadChatUrl(null,null),null);
  assert.equal(failedUploadChatUrl('https://chatgpt.com/c/current',null),'https://chatgpt.com/c/current');
  assert.equal(failedUploadChatUrl(null,'https://chatgpt.com/c/request'),'https://chatgpt.com/c/request');
});

test('completed uploads are remembered only within their own human message',()=>{
  const state={attachmentTurnId:'message-1',uploadedAttachments:['/a0/usr/uploads/a.png']};
  assert.deepEqual(uploadedAttachmentsForTurn(state,'message-1'),['/a0/usr/uploads/a.png']);
  assert.deepEqual(uploadedAttachmentsForTurn(state,'message-2'),[]);
  assert.deepEqual(uploadedAttachmentsForTurn({uploadedAttachments:state.uploadedAttachments},'message-2'),[]);
});

test('legacy position-based upload records migrate only for the same prior user message',()=>{
  const message={role:'user',content:'{"user_message":"Analyze","attachments":["/a0/usr/uploads/a.png"]}'};
  const hash=require('./bridge-core').messageHashes({messages:[message]})[0];
  const old={attachmentTurnId:'old-position-hash',uploadedAttachments:['/a0/usr/uploads/a.png'],messageHashes:[hash]};
  assert.deepEqual(uploadedAttachmentsForTurn(old,'new-stable-hash',hash),old.uploadedAttachments);
  assert.deepEqual(uploadedAttachmentsForTurn(old,'new-stable-hash','different-message'),[]);
  assert.deepEqual(uploadedAttachmentsForTurn({...old,attachmentIdentityVersion:2},'new-stable-hash',hash),[]);
});

test('a successful image upload is not repeated after a tool response',()=>{
  const human={role:'user',content:JSON.stringify({user_message:'Use as imagens',attachments:['/a0/usr/uploads/a.png','/a0/usr/uploads/b.png']})};
  const first={messages:[human]};
  const later={messages:[
    human,
    {role:'assistant',content:'{"tool_name":"vscode","tool_args":{}}'},
    {role:'user',content:'{"tool_result":"Workspace pronto"}'},
  ]};
  const state={attachmentTurnId:attachmentTurnIdentity(first),uploadedAttachments:attachmentInputs(first)};
  const alreadyUploaded=new Set(uploadedAttachmentsForTurn(state,attachmentTurnIdentity(later)));
  const pathsToUpload=attachmentInputs(later).filter(ref=>!alreadyUploaded.has(ref));
  assert.deepEqual(pathsToUpload,[]);
});

test('a tool follow-up retains an uploaded image when Agent Zero removes transient EXTRAS',()=>{
  const ref='/a0/usr/uploads/screenshot.png';
  const original={role:'user',content:JSON.stringify({user_message:'Inspect screenshot',attachments:[ref]})+' [EXTRAS] {"current_datetime":"now"}'};
  const normalized={role:'user',content:JSON.stringify({user_message:'Inspect screenshot',attachments:[ref]})};
  const first={messages:[original]};
  const later={messages:[normalized,{role:'assistant',content:'{"tool_name":"code_execution_tool"}'},{role:'user',content:'{"tool_result":"done"}'}]};
  const state={attachmentIdentityVersion:2,attachmentTurnId:attachmentTurnIdentity(first),uploadedAttachments:[ref]};
  assert.notEqual(attachmentTurnIdentity(first),attachmentTurnIdentity(later));
  assert.deepEqual(uploadedAttachmentsForTurn(state,attachmentTurnIdentity(later),null,true),[ref]);
  assert.deepEqual(uploadedAttachmentsForTurn(state,attachmentTurnIdentity(later),null,false),[]);
  const pending=attachmentInputs(later).filter(path=>!uploadedAttachmentsForTurn(state,attachmentTurnIdentity(later),null,true).includes(path));
  assert.deepEqual(pending,[]);
});

test('a compacted active request retains its completed upload without attaching it twice',()=>{
  const state={activeUserTextHash:'task-1',activeUserOccurrence:1,uploadedAttachments:['/a0/usr/uploads/a.png']};
  assert.equal(isSameActiveRequest(state,'task-1',1,false),true);
  assert.equal(isSameActiveRequest(state,'task-1',1,true),true);
  assert.equal(isSameActiveRequest(state,'task-2',1,true),false);
  assert.equal(isSameActiveRequest(state,'task-1',2,false),false);
});
