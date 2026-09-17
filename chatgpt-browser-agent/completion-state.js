'use strict';

function canCollectCompletedTurn(state, stableMs, minimumMs) {
  if (!state?.isExpected || state.failed || stableMs < minimumMs) return false;
  // A quiet text buffer alone is not completion: reasoning or tool work may
  // continue without emitting tokens. A final action or idle generation is
  // required before collecting the response.
  return Boolean(state.final || !state.busy);
}

module.exports={canCollectCompletedTurn};
