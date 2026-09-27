'use strict';

function canCollectCompletedTurn(state, stableMs, minimumMs) {
  if (!state?.isExpected || state.failed || stableMs < minimumMs) return false;
  // Never infer completion merely because the current UI no longer exposes a
  // known busy/streaming selector. ChatGPT may keep reasoning or running tools
  // for a long time without changing visible text. Require positive, turn-local
  // evidence that final response actions exist before collecting the response.
  return Boolean(state.final);
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
