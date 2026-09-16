'use strict';

function finalResponseText(answer) {
  try {
    const parsed=JSON.parse(answer);
    if(parsed?.tool_name==='response' && typeof parsed?.tool_args?.text==='string')
      return parsed.tool_args.text;
  } catch {}
  return null;
}

module.exports={finalResponseText};
