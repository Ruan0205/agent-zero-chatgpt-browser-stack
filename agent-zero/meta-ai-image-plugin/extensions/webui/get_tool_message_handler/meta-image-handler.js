import { store as attachmentsStore } from "/components/chat/attachments/attachmentsStore.js";
import {
  cleanStepTitle,
  drawProcessStep,
} from "/js/messages.js";

const STYLE_ID = "meta-ai-image-tool-style";

export default async function registerMetaAiImageHandler(extData) {
  if (extData?.tool_name === "meta_ai_image") {
    ensureStyles();
    extData.handler = drawMetaAiImageTool;
  }
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .meta-ai-image-results {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 520px));
      gap: 0.75rem;
      padding: 0.75rem 0;
    }
    .meta-ai-image-preview {
      display: block;
      width: 100%;
      max-width: 520px;
      max-height: 70vh;
      object-fit: contain;
      border-radius: 0.75rem;
      cursor: zoom-in;
      background: rgba(255, 255, 255, 0.04);
    }
  `;
  document.head.appendChild(style);
}

function drawMetaAiImageTool({
  id,
  heading,
  content,
  kvps = {},
  ...rest
}) {
  const log = arguments[0];
  const displayKvps = { ...kvps };
  const attachments = Array.isArray(displayKvps.attachments)
    ? displayKvps.attachments.filter((item) => typeof item === "string")
    : [];

  delete displayKvps._tool_name;
  delete displayKvps.attachments;
  delete displayKvps.media_paths;

  const result = drawProcessStep({
    id,
    title: cleanStepTitle(heading),
    code: "IMG",
    classes: ["meta-ai-image-step"],
    kvps: displayKvps,
    content,
    actionButtons: [],
    log,
    ...rest,
  });

  let gallery = result.detail.querySelector(":scope > .meta-ai-image-results");
  if (!gallery) {
    gallery = document.createElement("div");
    gallery.className = "meta-ai-image-results";
    result.detail.appendChild(gallery);
  }
  gallery.replaceChildren();

  for (const attachment of attachments) {
    const displayInfo = attachmentsStore.getAttachmentDisplayInfo(attachment);
    if (!displayInfo.isImage) continue;
    const image = document.createElement("img");
    image.className = "meta-ai-image-preview";
    image.src = displayInfo.previewUrl;
    image.alt = displayInfo.filename;
    image.loading = "eager";
    image.addEventListener("click", displayInfo.clickHandler);
    gallery.appendChild(image);
  }

  if (!gallery.childElementCount) gallery.remove();
  return result;
}
