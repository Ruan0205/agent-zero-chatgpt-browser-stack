'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {imageUploadCount,imageUploadReady,imageUploadTimeoutMs,isImageUploadTimeout,imageUploadFailureAnswer,failedUploadChatUrl,uploadedAttachmentsForTurn}=require('./image-upload');

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
