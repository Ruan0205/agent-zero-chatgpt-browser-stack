import registerMedia from "/plugins/_chatgpt_browser_media/extensions/webui/get_tool_message_handler/chatgpt-browser-media-handler.js";

export default async function register(extData) {
  if (extData?.tool_name !== "chatgpt_browser_image") return;
  // Reuse the existing gallery/download renderer, without changing the real
  // log's tool identity or falsely recording a second publication call.
  const media = { ...extData, tool_name: "chatgpt_browser_media" };
  await registerMedia(media);
  if (media.handler) extData.handler = media.handler;
}
