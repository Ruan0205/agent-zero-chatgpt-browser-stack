import { store as chatsStore } from "/components/sidebar/chats/chats-store.js";
import { store as chatInputStore } from "/components/chat/input/input-store.js";
import { store as sidebarStore } from "/components/sidebar/sidebar-store.js";
import { pruneActivity, sortRowsByActivity } from "/plugins/_browser_incidents/webui/chat-activity-order.mjs";

const ACTIVITY_KEY = "a0:chat-activity-order:v1";

function activityMap() {
  try { return JSON.parse(localStorage.getItem(ACTIVITY_KEY) || "{}"); }
  catch { return {}; }
}

function touchChat(id) {
  if (!id) return;
  const activity = pruneActivity(activityMap(), chatsStore.contexts, id);
  activity[id] = Date.now();
  localStorage.setItem(ACTIVITY_KEY, JSON.stringify(activity));
}

function installRecentChatOrdering() {
  if (globalThis.__a0RecentChatOrderingInstalled) return;
  globalThis.__a0RecentChatOrderingInstalled = true;
  sidebarStore.registerRowListExtension("chat", "recent-activity", {
    sort(rows) {
      return sortRowsByActivity(rows, chatsStore.contexts, activityMap());
    },
  });
  const originalSelect = chatsStore.selectChat;
  chatsStore.selectChat = async function recentSelect(id, ...args) {
    const result = await originalSelect.call(this, id, ...args);
    touchChat(id);
    return result;
  };
  const originalSend = chatInputStore.sendMessage;
  chatInputStore.sendMessage = async function recentSend(...args) {
    touchChat(chatsStore.getSelectedChatId());
    const result = await originalSend.call(this, ...args);
    // A first message can create the context inside originalSend.
    touchChat(chatsStore.getSelectedChatId());
    return result;
  };
}

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
  const result = await response.json();
  if(result?.success === false) throw new Error(result.error || "A auditoria recusou a solicitação.");
  return result;
}

function visible(element) {
  if (!element) return false;
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
}

function interfaceSnapshot() {
  const alerts = [...document.querySelectorAll('[role="alert"], .toast, .error, [class*="error"], dialog[open]')]
    .filter(visible)
    .map((element) => String(element.innerText || element.textContent || "").trim())
    .filter(Boolean)
    .slice(0, 100);
  return {
    captured_at: new Date().toISOString(),
    url: location.href,
    title: document.title,
    viewport: { width: innerWidth, height: innerHeight },
    selected_chat_id: chatsStore.getSelectedChatId(),
    selected_chat_name: chatsStore.displayName(chatsStore.getSelectedContext()),
    visible_alerts: alerts,
    visible_interface_text: String(document.body?.innerText || "").slice(0, 750000),
  };
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
  text(root.querySelector("[data-count='open']"), state.counts?.open ?? 0);
  text(root.querySelector("[data-count='total']"), state.counts?.total ?? 0);
  const active = Boolean(state.status?.active);
  const queued = Number(state.status?.queued || 0);
  text(root.querySelector(".incident-runtime-text"), active ? `Analisando ${state.status?.currentChatName || "chat"}` : queued ? `${queued} na fila` : "Auditoria manual disponível");
  root.querySelector(".incident-runtime")?.setAttribute("data-state", active ? "busy" : "ready");
  const selectedId = chatsStore.getSelectedChatId();
  const repair = state.repair_sessions?.[selectedId];
  const repairPanel = root.querySelector(".repair-panel");
  if (repairPanel) repairPanel.hidden = !repair;
  if (repair) {
    const labels = {
      diagnosing: "Analisando o histórico completo…", awaiting_approval: "Diagnóstico concluído · aguardando sua decisão",
      answering: "Respondendo na mesma conversa…", repairing: "Reparo autorizado em execução…",
      repaired: "Reparo encerrado · retomada do chat depende da sua autorização",
      declined: "Reparo recusado", resuming: "Retomando o chat original…",
      resumed: "Chat original retomado", error: "Falha no reparador", resume_error: "Falha ao retomar o chat",
    };
    text(root.querySelector(".repair-chat-name"), repair.chat_name || selectedId);
    text(root.querySelector(".repair-status"), labels[repair.phase] || repair.phase);
    text(root.querySelector(".repair-response"), repair.response || "Aguardando resposta do diagnóstico.");
    text(root.querySelector(".repair-error"), repair.error || "");
    root.querySelector(".repair-approve").hidden = repair.phase !== "awaiting_approval";
    root.querySelector(".repair-decline").hidden = repair.phase !== "awaiting_approval";
    root.querySelector(".repair-resume").hidden = repair.phase !== "repaired";
    root.querySelector(".repair-send").disabled = ["diagnosing", "repairing", "answering", "resuming"].includes(repair.phase);
    root.querySelector(".repair-vnc").href = `${location.protocol}//${location.hostname}:${state.repair_vnc_port || 50087}/vnc.html`;
  }

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
  root.querySelector(".incident-report-chat")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const previous = button.textContent;
    button.textContent = "Enviando para análise…";
    try {
      const contextId = chatsStore.getSelectedChatId();
      if (!contextId) throw new Error("Selecione um chat antes de solicitar o relatório.");
      const state = await api("diagnose_chat", {
        context_id: contextId,
        chat_name: chatsStore.displayName(chatsStore.getSelectedContext()),
        interface_snapshot: interfaceSnapshot(),
      });
      render(root, state);
    } catch (error) {
      root.classList.add("has-error");
      text(root.querySelector(".incident-runtime-text"), error?.message || "Falha ao solicitar relatório");
    } finally {
      button.disabled = false;
      button.textContent = previous;
    }
  });
  root.querySelector(".repair-send")?.addEventListener("click", async () => {
    const input = root.querySelector(".repair-composer");
    const message = input?.value?.trim();
    if (!message) return;
    try {
      render(root, await api("repair_message", { context_id: chatsStore.getSelectedChatId(), message }));
      input.value = "";
    } catch (error) { text(root.querySelector(".repair-error"), error?.message || error); }
  });
  root.querySelector(".repair-approve")?.addEventListener("click", async () => {
    if (!globalThis.confirm("Autorizar o reparador a modificar a stack e reiniciar serviços, se necessário?")) return;
    try { render(root, await api("approve_repair", { context_id: chatsStore.getSelectedChatId() })); }
    catch (error) { text(root.querySelector(".repair-error"), error?.message || error); }
  });
  root.querySelector(".repair-decline")?.addEventListener("click", async () => {
    try { render(root, await api("decline_repair", { context_id: chatsStore.getSelectedChatId() })); }
    catch (error) { text(root.querySelector(".repair-error"), error?.message || error); }
  });
  root.querySelector(".repair-resume")?.addEventListener("click", async () => {
    if (!globalThis.confirm("Autorizar uma nova mensagem no chat original para continuar a tarefa?")) return;
    try { render(root, await api("resume_source", { context_id: chatsStore.getSelectedChatId() })); }
    catch (error) { text(root.querySelector(".repair-error"), error?.message || error); }
  });
  root.querySelector(".incident-refresh")?.addEventListener("click", () => refresh(root));
  root.querySelector(".incident-clear")?.addEventListener("click", async () => render(root, await api("clear_all")));
}

let pollTimer = null;

export default async function registerBrowserIncidentsSurface(surfaces) {
  installRecentChatOrdering();
  surfaces.registerSurface({
    id: "browser-incidents",
    title: "Chats com erro",
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
