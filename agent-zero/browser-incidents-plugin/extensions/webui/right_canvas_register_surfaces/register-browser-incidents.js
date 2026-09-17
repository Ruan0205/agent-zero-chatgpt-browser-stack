function waitForElement(selector, timeoutMs = 5000) {
  const found = document.querySelector(selector);
  if (found) return Promise.resolve(found);
  return new Promise((resolve) => {
    const timeout = globalThis.setTimeout(() => { observer.disconnect(); resolve(null); }, timeoutMs);
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

async function api(action = "get", extra = {}) {
  const response=await globalThis.fetchApi("/plugins/_browser_incidents/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
  });
  if(!response?.ok) throw new Error(`Auditoria indisponível (${response?.status || 'sem resposta'}).`);
  return response.json();
}

function text(element, value) {
  if (element) element.textContent = value == null ? "" : String(value);
}

function prettyTime(value) {
  if (!value) return "horário indisponível";
  try { return new Intl.DateTimeFormat("pt-BR", { dateStyle: "short", timeStyle: "medium" }).format(new Date(value)); }
  catch { return String(value); }
}

function render(root, state) {
  root.dataset.enabled = state.enabled ? "true" : "false";
  const toggle = root.querySelector(".incident-toggle");
  toggle?.setAttribute("aria-checked", String(Boolean(state.enabled)));
  text(root.querySelector(".incident-toggle-label"), state.enabled ? "Auditoria ligada" : "Auditoria desligada");
  text(root.querySelector("[data-count='open']"), state.counts?.open ?? 0);
  text(root.querySelector("[data-count='total']"), state.counts?.total ?? 0);
  const active = Boolean(state.status?.active);
  const queued = Number(state.status?.queued || 0);
  text(root.querySelector(".incident-runtime-text"), active ? `Analisando ${state.status?.currentChatName || "interação"}` : queued ? `${queued} na fila` : "Auditor disponível");
  root.querySelector(".incident-runtime")?.setAttribute("data-state", active ? "busy" : state.enabled ? "ready" : "off");

  const list = root.querySelector(".incident-list");
  const empty = root.querySelector(".incident-empty");
  const template = root.querySelector(".incident-card-template");
  if (!list || !template) return;
  list.replaceChildren();
  const incidents = Array.isArray(state.incidents) ? state.incidents : [];
  empty?.classList.toggle("is-visible", incidents.length === 0);
  for (const item of incidents) {
    const card = template.content.firstElementChild.cloneNode(true);
    card.dataset.severity = item.severity || "medium";
    card.classList.toggle("is-resolved", Boolean(item.resolved));
    text(card.querySelector(".incident-card-title"), item.title || "Problema detectado");
    text(card.querySelector(".incident-card-chat"), item.chatName || item.chatId || "Chat desconhecido");
    text(card.querySelector(".incident-card-time"), prettyTime(item.createdAt));
    text(card.querySelector(".incident-card-severity"), item.severity || "medium");
    text(card.querySelector(".incident-summary"), item.summary || "Sem resumo.");
    text(card.querySelector(".incident-cause"), item.cause || "Causa ainda não determinada.");
    text(card.querySelector(".incident-recommendation"), item.recommendation || "Revisar os registros da interação.");
    text(card.querySelector(".incident-question"), item.question || "");
    text(card.querySelector(".incident-response"), item.response || item.interactionError || "");
    const evidence = card.querySelector(".incident-evidence");
    for (const value of item.evidence || []) {
      const li = document.createElement("li");
      li.textContent = String(value);
      evidence?.append(li);
    }
    const resolve = card.querySelector(".incident-resolve");
    text(resolve, item.resolved ? "Reabrir" : "Marcar como resolvido");
    resolve?.addEventListener("click", async () => render(root, await api("resolve", { id: item.id, resolved: !item.resolved })));
    card.querySelector(".incident-copy")?.addEventListener("click", () => navigator.clipboard?.writeText(JSON.stringify(item, null, 2)));
    card.querySelector(".incident-remove")?.addEventListener("click", async () => render(root, await api("remove", { id: item.id })));
    list.append(card);
  }
}

async function refresh(root) {
  try {
    render(root, await api());
    root.classList.remove("has-error");
  } catch (error) {
    root.classList.add("has-error");
    text(root.querySelector(".incident-runtime-text"), error?.message || "Falha ao carregar auditoria");
  }
}

function wire(root) {
  if (root.dataset.wired === "true") return;
  root.dataset.wired = "true";
  root.querySelector(".incident-toggle")?.addEventListener("click", async () => {
    const enabled = root.dataset.enabled !== "true";
    render(root, await api("set_enabled", { enabled }));
  });
  root.querySelector(".incident-refresh")?.addEventListener("click", () => refresh(root));
  root.querySelector(".incident-clear")?.addEventListener("click", async () => render(root, await api("clear_all")));
}

let pollTimer = null;

export default async function registerBrowserIncidentsSurface(surfaces) {
  surfaces.registerSurface({
    id: "browser-incidents",
    title: "Auditoria de respostas",
    icon: "fact_check",
    order: 27,
    modalPath: "/plugins/_browser_incidents/webui/main.html",
    async open() {
      const root = await waitForElement('[data-surface-id="browser-incidents"] .browser-incidents-surface');
      if (!root) throw new Error("O painel de auditoria não foi montado.");
      wire(root);
      await refresh(root);
      globalThis.clearInterval(pollTimer);
      pollTimer = globalThis.setInterval(() => refresh(root), 6000);
    },
    async close() {
      globalThis.clearInterval(pollTimer);
      pollTimer = null;
    },
  });
}
