import { open as openSurface } from "/js/surfaces.js";
import { cleanStepTitle, drawProcessStep } from "/js/messages.js";


export default async function registerVsCodeToolHandler(extData) {
  if (extData?.tool_name === "vscode") extData.handler = drawVsCodeTool;
}


function drawVsCodeTool({ id, heading, content, kvps = {}, ...rest }) {
  const log = arguments[0];
  const result = drawProcessStep({
    id,
    title: cleanStepTitle(heading),
    code: "VSC",
    classes: ["vscode-tool-step"],
    kvps,
    content,
    actionButtons: [],
    log,
    ...rest,
  });

  if (String(kvps.action || "").toLowerCase() === "open") {
    requestAnimationFrame(() => {
      void openSurface("vscode", {
        contextId: kvps.vscode_context_id || null,
      });
    });
  }
  return result;
}
