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


async function monitorUrl() {
  const config = await runtimeConfig();
  if (!config.password) throw new Error("A credencial automática do VNC não foi configurada.");
  const url = new URL(window.location.href);
  url.port = "50081";
  url.pathname = "/vnc.html";
  url.search = "";
  url.hash = "";
  url.searchParams.set("autoconnect", "1");
  url.searchParams.set("reconnect", "1");
  url.searchParams.set("resize", "scale");
  url.searchParams.set("password", config.password);
  return url.toString();
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
    try {
      frame.src = await monitorUrl();
    } catch (error) {
      setStatus(root, "offline", error.message || "Configuração indisponível");
    }
  });
  popout?.addEventListener("click", async () => {
    try {
      window.open(await monitorUrl(), "_blank", "noopener");
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
      const frame = root.querySelector(".agent-monitor-frame");
      if (frame && (!frame.src || frame.src === "about:blank")) {
        try {
          frame.src = await monitorUrl();
        } catch (error) {
          setStatus(root, "offline", error.message || "Configuração indisponível");
          throw error;
        }
      }
    },
    async close() {},
  });
}
