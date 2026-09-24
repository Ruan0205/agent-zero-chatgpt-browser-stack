'use strict';

function canCollectCompletedTurn(state, stableMs, minimumMs) {
  if (!state?.isExpected || state.failed || stableMs < minimumMs) return false;
  // A quiet text buffer alone is not completion: reasoning or tool work may
  // continue without emitting tokens. A final action or idle generation is
  // required before collecting the response.
  return Boolean(state.final || !state.busy);
}

function isDownloadTextCandidate(state) {
  // A code block can mention "Download foo.whl" inside a tool command. It is
  // never evidence that ChatGPT produced a downloadable artifact.
  return Boolean(!state?.hasCodeBlock && /\bDownload\s+[^\n]+\.[a-z0-9.]{1,12}\b/i.test(state?.text || ''));
}

function isCompletedEmptyTurn(state) {
  return Boolean(state?.isExpected && state.hasAssistant && state.final
    && !state.busy && !state.text?.trim() && !state.media);
}

module.exports={canCollectCompletedTurn,isDownloadTextCandidate,isCompletedEmptyTurn};
