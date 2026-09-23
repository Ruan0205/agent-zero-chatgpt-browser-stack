'use strict';

const IMAGE_EXTENSIONS=new Set(['.png','.jpg','.jpeg','.webp','.gif','.bmp','.avif']);

function imageUploadCount(paths, pathModule=require('path')) {
  return (paths||[]).filter(value=>IMAGE_EXTENSIONS.has(pathModule.extname(String(value)).toLowerCase())).length;
}

function imageUploadReady(state, expectedImages) {
  return expectedImages>0
    && state.previewCount>=expectedImages
    && state.loadedCount>=expectedImages
    && state.pendingCount===0
    && state.sendEnabled===true;
}

function imageUploadTimeoutMs(count, perImageMs=180_000) {
  return Math.max(0,count)*perImageMs;
}

function isImageUploadTimeout(error) {
  return /IMAGE_UPLOAD_TIMEOUT: a imagem não carregou/.test(String(error?.message||error));
}

function imageUploadFailureAnswer() {
  return {
    thoughts:['O envio da imagem ficou pendente por três minutos; o rascunho e o anexo foram removidos sem enviar a mensagem.'],
    headline:'Imagem não carregada',
    tool_name:'response',
    tool_args:{text:'a imagem não carregou'},
  };
}

function failedUploadChatUrl(mappedUrl, requestUrl) {
  // A fresh chat with no submitted turn has no safe URL to bind. Never use
  // the browser slot's last session, which may belong to another chat.
  return mappedUrl || requestUrl || null;
}

function uploadedAttachmentsForTurn(state, turnId) {
  return turnId && state?.attachmentTurnId===turnId && Array.isArray(state.uploadedAttachments)
    ? state.uploadedAttachments : [];
}

module.exports={imageUploadCount,imageUploadReady,imageUploadTimeoutMs,isImageUploadTimeout,imageUploadFailureAnswer,failedUploadChatUrl,uploadedAttachmentsForTurn};
