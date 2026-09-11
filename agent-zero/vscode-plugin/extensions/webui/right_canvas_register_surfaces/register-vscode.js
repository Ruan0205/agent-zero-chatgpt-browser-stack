import { getContext } from "/index.js";


function waitForElement(selector, timeoutMs = 5000) {
  const found = document.querySelector(selector);
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const timeout = globalThis.setTimeout(() => {
      observer.disconnect();
      resolve(null);
    }, timeoutMs);
    const observer = new MutationObserver(() => {
      const element = document.querySelector(selector);
      if (!element) return;
      globalThis.clearTimeout(timeout);
      observer.disconnect();
      resolve(element);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}


function vscodeUrl(contextId) {
  const url = new URL(window.location.href);
  url.port = "50082";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  url.searchParams.set("folder", `/workspace/chats/${contextId}`);
  return url.toString();
}


export default async function registerVsCodeSurface(surfaces) {
  surfaces.registerSurface({
    id: "vscode",
    title: "VS Code",
    icon: "code",
    order: 25,
    modalPath: "/plugins/_vscode/webui/main.html",
    async open(payload = {}) {
      const panel = await waitForElement('[data-surface-id="vscode"] .vscode-frame');
      if (!panel) throw new Error("VS Code surface panel did not mount.");
      const contextId = String(payload.contextId || payload.context_id || getContext() || "").trim();
      if (!contextId) throw new Error("No active chat for VS Code.");
      const nextUrl = vscodeUrl(contextId);
      if (panel.src !== nextUrl) panel.src = nextUrl;
    },
    async close() {},
  });
}
