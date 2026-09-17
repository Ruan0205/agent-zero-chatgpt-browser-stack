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


let runtimeConfigPromise;


async function runtimeConfig() {
  if (!runtimeConfigPromise) {
    runtimeConfigPromise = fetch("/plugins/_agent_monitor/webui/vnc-runtime.json", {
      cache: "no-store",
      credentials: "same-origin",
    }).then((response) => {
      if (!response.ok) throw new Error(`Configuração VNC indisponível (${response.status}).`);
      return response.json();
    });
  }
  return runtimeConfigPromise;
}


async function monitorUrl(port) {
  const config = await runtimeConfig();
  if (!config.password) throw new Error("A credencial automática do VNC não foi configurada.");
  const url = new URL(window.location.href);
  url.port = String(port);
  url.pathname = "/vnc.html";
  url.search = "";
  url.hash = "";
  url.searchParams.set("autoconnect", "1");
  url.searchParams.set("reconnect", "1");
  url.searchParams.set("resize", "scale");
  url.searchParams.set("password", config.password);
  return url.toString();
}

let previewTimer;
let previewRequest = false;
async function syncPreview(root) {
  if (previewRequest) return;
  previewRequest = true;
  const frame = root.querySelector('.agent-monitor-frame');
  try {
    const contextId = String(getContext() || '').trim();
    if (!contextId) throw new Error('Selecione um chat.');
    const response = await globalThis.fetchApi('/plugins/_agent_monitor/preview_route', {
      method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({context_id:contextId}),
    });
    if (!response.ok) throw new Error(`Vínculo indisponível (${response.status}).`);
    const route = await response.json();
    if (contextId !== String(getContext() || '').trim()) return;
    if (route.status !== 'ready' || ![1,2,3].includes(route.slot)) {
      root.dataset.preview = 'waiting';
      if (frame?.src && frame.src !== 'about:blank') frame.src='about:blank';
      setStatus(root, route.status==='busy'?'loading':'offline',
        route.status==='busy'?'Navegador ocupado com outro chat…':'Aguardando este chat…');
      return;
    }
    const config=await runtimeConfig();
    const port=Number(config.ports?.[route.slot-1] || Number(config.port || 50081)+(route.slot-1)*2);
    const url=await monitorUrl(port);
    root.dataset.preview='ready';
    if (frame && frame.src !== url) frame.src=url;
    setStatus(root,'online',`VNC ${route.slot} · chat selecionado`);
  } catch(error) {
    root.dataset.preview='waiting';
    if (frame?.src && frame.src !== 'about:blank') frame.src='about:blank';
    setStatus(root,'offline',error.message || 'Vínculo indisponível');
  } finally { previewRequest=false; }
}


function setStatus(root, state, text) {
  const status = root.querySelector(".agent-monitor-status");
  const label = root.querySelector(".agent-monitor-status-text");
  if (status) status.dataset.state = state;
  if (label) label.textContent = text;
}


function wirePanel(root) {
  if (root.dataset.monitorWired === "true") return;
  root.dataset.monitorWired = "true";
  const frame = root.querySelector(".agent-monitor-frame");
  const refresh = root.querySelector(".agent-monitor-refresh");
  const popout = root.querySelector(".agent-monitor-popout");
  if (!frame) return;

  frame.addEventListener("load", () => setStatus(root, "online", "VNC carregado"));
  frame.addEventListener("error", () => setStatus(root, "offline", "Indisponível"));
  refresh?.addEventListener("click", async () => {
    setStatus(root, "loading", "Reconectando…");
    await syncPreview(root);
  });
  popout?.addEventListener("click", async () => {
    try {
      const route=await globalThis.fetchApi('/plugins/_agent_monitor/preview_route', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({context_id:String(getContext()||'')})}).then(r=>r.json());
      if(route.status!=='ready') throw new Error('O navegador deste chat ainda não está disponível.');
      const config=await runtimeConfig();
      window.open(await monitorUrl(Number(config.ports?.[route.slot-1] || Number(config.port||50081)+(route.slot-1)*2)), "_blank", "noopener");
    } catch (error) {
      setStatus(root, "offline", error.message || "Configuração indisponível");
    }
  });
}


export default async function registerAgentMonitorSurface(surfaces) {
  surfaces.registerSurface({
    id: "agent-monitor",
    title: "ChatGPT Browser (VNC)",
    icon: "desktop_windows",
    order: 26,
    modalPath: "/plugins/_agent_monitor/webui/main.html",
    async open() {
      const root = await waitForElement('[data-surface-id="agent-monitor"] .agent-monitor-surface');
      if (!root) throw new Error("O painel do ChatGPT Browser não foi montado.");
      wirePanel(root);
      await syncPreview(root);
      globalThis.clearInterval(previewTimer);
      previewTimer=globalThis.setInterval(()=>syncPreview(root),3000);
    },
    async close() { globalThis.clearInterval(previewTimer); previewTimer=null; },
  });
}
import { getContext } from "/index.js";
