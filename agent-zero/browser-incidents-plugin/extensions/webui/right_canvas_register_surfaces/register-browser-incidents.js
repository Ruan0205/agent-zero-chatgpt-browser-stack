import { store as chatsStore } from "/components/sidebar/chats/chats-store.js";
import { store as chatInputStore } from "/components/chat/input/input-store.js";
import { store as sidebarStore } from "/components/sidebar/sidebar-store.js";
import { store as pinStore } from "/plugins/_pin_to_top/webui/pin-to-top-store.js";
import { pruneActivity, sortRowsByActivity } from "/plugins/_browser_incidents/webui/chat-activity-order.mjs";

const ACTIVITY_KEY = "a0:chat-activity-order:v1";
let unreadChats = new Set();

function decorateCompletedChats() {
  const list = document.querySelector(".chats-config-list");
  if (!list) return;
  const topRows = list.querySelectorAll(":scope > .chat-tree-item");
  chatsStore.topLevelContexts().forEach((context, index) => {
    const row = topRows[index];
    row?.querySelector(":scope > .chat-container .project-color-ball")?.classList.toggle("a0-chat-completed-unread", unreadChats.has(context.id));
    const children = row?.querySelectorAll(":scope > .chat-child-list > li") || [];
    chatsStore.childContexts(context.id).forEach((child, childIndex) => {
      children[childIndex]?.querySelector(".project-color-ball")?.classList.toggle("a0-chat-completed-unread", unreadChats.has(child.id));
    });
  });
}

function setUnread(ids) {
  unreadChats = new Set(Array.isArray(ids) ? ids : []);
  requestAnimationFrame(decorateCompletedChats);
}

function installCompletionIndicators() {
  if (globalThis.__a0CompletionIndicatorsInstalled) return;
  globalThis.__a0CompletionIndicatorsInstalled = true;
  const style = document.createElement("style");
  style.textContent = ".chats-list-container .project-color-ball.a0-chat-completed-unread{background:#398dff!important;border:1px solid #89bdff!important;box-shadow:0 0 0 2px #398dff38,0 0 10px #398dff!important;animation:none!important}";
  document.head.append(style);
  const poll = async () => {
    try { setUnread((await api("unread_only")).unread_completed_chats); }
    catch (error) { console.warn("Indicador de chat concluído indisponível:", error); }
  };
  void poll();
  globalThis.setInterval(() => { void poll(); }, 6000);
  globalThis.setInterval(decorateCompletedChats, 1500);
}

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
      return sortRowsByActivity(rows, chatsStore.contexts, activityMap(), pinStore.pins.chat);
    },
  });
  const originalSelect = chatsStore.selectChat;
  chatsStore.selectChat = async function recentSelect(id, ...args) {
    const result = await originalSelect.call(this, id, ...args);
    touchChat(id);
    if (id) {
      unreadChats.delete(id);
      decorateCompletedChats();
      try { setUnread((await api("mark_read", { context_id: id })).unread_completed_chats); }
      catch (error) { console.warn("Falha ao marcar chat como lido:", error); }
    }
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
  const shortcuts = root.querySelector(".vnc-shortcuts");
  if (shortcuts) {
    shortcuts.replaceChildren();
    for (const slot of state.vnc_slots || []) {
      const link = document.createElement("a");
      link.className = "vnc-shortcut";
      link.href = "#";
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.dataset.port = String(slot.port);
      link.dataset.state = slot.status;
      link.title = `${slot.label}: ${slot.status === "ready" ? "disponível" : slot.status === "busy" ? "em uso" : "indisponível"}`;
      const icon = document.createElement("span");
      icon.className = "material-symbols-outlined";
      icon.textContent = "desktop_windows";
      const label = document.createElement("span");
      label.textContent = slot.label;
      const dot = document.createElement("span");
      dot.className = "vnc-shortcut-dot";
      link.append(icon, label, dot);
      shortcuts.append(link);
    }
  }
  text(root.querySelector("[data-count='open']"), state.counts?.open ?? 0);
  text(root.querySelector("[data-count='total']"), state.counts?.total ?? 0);
  const active = Boolean(state.status?.active);
  const queued = Number(state.status?.queued || 0);
  text(root.querySelector(".incident-runtime-text"), active ? `Analisando ${state.status?.currentChatName || "chat"}` : queued ? `${queued} na fila` : "Auditoria manual disponível");
  root.querySelector(".incident-runtime")?.setAttribute("data-state", active ? "busy" : "ready");
  const selectedId = chatsStore.getSelectedChatId();
  const activeRepairId = root.dataset.activeRepairId && state.repair_sessions?.[root.dataset.activeRepairId]
    ? root.dataset.activeRepairId : selectedId;
  const repair = state.repair_sessions?.[activeRepairId];
  for (const link of root.querySelectorAll(".repair-vnc")) link.dataset.port = String(state.repair_vnc_port || 50087);
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
    text(root.querySelector(".repair-chat-name"), repair.chat_name || activeRepairId);
    text(root.querySelector(".repair-current-error"), repair.error_description || "");
    text(root.querySelector(".repair-status"), labels[repair.phase] || repair.phase);
    text(root.querySelector(".repair-response"), repair.response || "Aguardando resposta do diagnóstico.");
    text(root.querySelector(".repair-error"), repair.error || "");
    root.querySelector(".repair-approve").hidden = repair.phase !== "awaiting_approval";
    root.querySelector(".repair-decline").hidden = repair.phase !== "awaiting_approval";
    root.querySelector(".repair-resume").hidden = repair.phase !== "repaired" || repair.type === "improvement";
    const repairChatLink = root.querySelector(".repair-chat-link");
    if (repairChatLink) {
      const repairContext = /^[A-Za-z0-9_-]{1,160}$/.test(String(repair.context_id || "")) ? repair.context_id : "";
      repairChatLink.hidden = !repairContext;
      if (repairContext) {
        const repairUrl = new URL(location.href);
        repairUrl.port = "50086";
        repairUrl.pathname = "/";
        repairUrl.search = "";
        repairUrl.hash = "";
        repairUrl.searchParams.set("ctxid", repairContext);
        repairChatLink.href = repairUrl.toString();
      }
    }
    text(root.querySelector(".repair-approve"), repair.type === "improvement" ? "Autorizar melhoria" : "Autorizar reparo");
    root.querySelector(".repair-send").disabled = ["diagnosing", "repairing", "answering", "resuming"].includes(repair.phase);
  }

  const list = root.querySelector(".incident-list");
  const empty = root.querySelector(".incident-empty");
  const template = root.querySelector(".incident-card-template");
  if (!list || !template) return;
  list.replaceChildren();
  const incidents = Array.isArray(state.incidents) ? state.incidents : [];
  const repairs = Object.entries(state.repair_sessions || {});
  empty?.classList.toggle("is-visible", incidents.length === 0 && repairs.length === 0);
  for (const [chatId, session] of repairs) {
    const card = document.createElement("article");
    card.className = "incident-card";
    const title = document.createElement("div");
    title.className = "incident-card-title";
    title.textContent = session.chat_name || chatId;
    const meta = document.createElement("div");
    meta.className = "incident-card-meta";
    meta.textContent = `Chat ${chatId} · ${session.phase || "diagnóstico"} · ${prettyTime(session.updated_at)}`;
    const summary = document.createElement("p");
    summary.className = "incident-summary";
    summary.textContent = session.error_description || session.error || "Auditoria deste chat";
    const actions = document.createElement("div");
    actions.className = "incident-card-actions";
    const open = document.createElement("button");
    open.className = "incident-button";
    open.textContent = session.type === "improvement" ? "Abrir plano" : "Abrir chat";
    open.addEventListener("click", () => {
      root.dataset.activeRepairId = chatId;
      if (session.type !== "improvement") void chatsStore.selectChat(chatId);
      render(root, state);
    });
    const remove = document.createElement("button");
    remove.className = "incident-button";
    remove.textContent = "Apagar auditoria";
    remove.disabled = ["diagnosing", "answering", "repairing", "resuming"].includes(session.phase);
    if (remove.disabled) remove.title = "Aguarde o processo em andamento terminar.";
    remove.addEventListener("click", async () => {
      if (!globalThis.confirm(`Apagar somente a auditoria do chat ${session.chat_name || chatId}?`)) return;
      try { render(root, await api("remove_audit", { context_id: chatId })); }
      catch (error) { text(root.querySelector(".incident-runtime-text"), error?.message || error); }
    });
    actions.append(open, remove);
    card.append(title, meta, summary, actions);
    list.append(card);
  }
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
    card.querySelector(".incident-remove")?.addEventListener("click", async () => {
      try { render(root, await api("remove", { id: item.id })); }
      catch (error) { text(root.querySelector(".incident-runtime-text"), error?.message || error); }
    });
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

async function openVnc(root, link) {
  const popup = window.open("about:blank", "_blank");
  try {
    const response = await fetch("/plugins/_agent_monitor/webui/vnc-runtime.json", {cache:"no-store",credentials:"same-origin"});
    if (!response.ok) throw new Error("Credencial automática da VNC indisponível.");
    const config = await response.json();
    if (!config.password) throw new Error("Credencial automática da VNC não configurada.");
    const url = new URL(location.href);
    url.port = link.dataset.port || "50087";
    url.pathname = "/vnc.html";
    url.search = "";
    url.hash = "";
    for (const [key,value] of Object.entries({autoconnect:"1",reconnect:"1",resize:"scale",password:config.password})) url.searchParams.set(key,value);
    if (!popup) throw new Error("Permita a abertura da aba da VNC no navegador.");
    popup.location.href = url.toString();
  } catch (error) {
    popup?.close();
    text(root.querySelector(".repair-error"), error?.message || "Não foi possível abrir a VNC.");
  }
}

function currentRepairId(root) {
  return root.dataset.activeRepairId || chatsStore.getSelectedChatId();
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
      const errorDescription = root.querySelector(".incident-description")?.value?.trim() || "";
      if (!errorDescription) throw new Error("Descreva o erro atual antes de iniciar a análise.");
      const state = await api("diagnose_chat", {
        context_id: contextId,
        chat_name: chatsStore.displayName(chatsStore.getSelectedContext()),
        error_description: errorDescription,
        interface_snapshot: interfaceSnapshot(),
      });
      root.dataset.activeRepairId = contextId;
      render(root, state);
    } catch (error) {
      root.classList.add("has-error");
      text(root.querySelector(".incident-runtime-text"), error?.message || "Falha ao solicitar relatório");
    } finally {
      button.disabled = false;
      button.textContent = previous;
    }
  });
  root.querySelector(".incident-improvement-toggle")?.addEventListener("click", () => {
    const form = root.querySelector(".improvement-form");
    form.hidden = !form.hidden;
    if (!form.hidden) form.querySelector("textarea")?.focus();
  });
  root.querySelector(".incident-improvement-submit")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const description = root.querySelector(".improvement-description")?.value?.trim();
    if (!description) { text(root.querySelector(".incident-runtime-text"), "Descreva a melhoria desejada."); return; }
    button.disabled = true;
    try {
      const state = await api("request_improvement", {context_id: chatsStore.getSelectedChatId() || "", description});
      const latest = Object.entries(state.repair_sessions || {})
        .filter(([, session]) => session.type === "improvement")
        .sort((a,b) => String(b[1].updated_at).localeCompare(String(a[1].updated_at)))[0];
      if (latest) root.dataset.activeRepairId = latest[0];
      root.querySelector(".improvement-form").hidden = true;
      root.querySelector(".improvement-description").value = "";
      render(root, state);
    } catch (error) { text(root.querySelector(".incident-runtime-text"), error?.message || error); }
    finally { button.disabled = false; }
  });
  root.querySelector(".repair-send")?.addEventListener("click", async () => {
    const input = root.querySelector(".repair-composer");
    const message = input?.value?.trim();
    if (!message) return;
    try {
      render(root, await api("repair_message", { context_id: currentRepairId(root), message }));
      input.value = "";
    } catch (error) { text(root.querySelector(".repair-error"), error?.message || error); }
  });
  root.querySelector(".repair-approve")?.addEventListener("click", async () => {
    if (!globalThis.confirm("Autorizar o reparador a modificar a stack e reiniciar serviços, se necessário?")) return;
    try { render(root, await api("approve_repair", { context_id: currentRepairId(root) })); }
    catch (error) { text(root.querySelector(".repair-error"), error?.message || error); }
  });
  root.querySelector(".repair-decline")?.addEventListener("click", async () => {
    try { render(root, await api("decline_repair", { context_id: currentRepairId(root) })); }
    catch (error) { text(root.querySelector(".repair-error"), error?.message || error); }
  });
  root.querySelector(".repair-resume")?.addEventListener("click", async () => {
    if (!globalThis.confirm("Autorizar uma nova mensagem no chat original para continuar a tarefa?")) return;
    try { render(root, await api("resume_source", { context_id: currentRepairId(root) })); }
    catch (error) { text(root.querySelector(".repair-error"), error?.message || error); }
  });
  for (const link of root.querySelectorAll(".repair-vnc")) link.addEventListener("click", async (event) => {
    event.preventDefault();
    await openVnc(root, link);
  });
  root.querySelector(".vnc-shortcuts")?.addEventListener("click", (event) => {
    const link = event.target.closest(".vnc-shortcut");
    if (!link) return;
    event.preventDefault();
    void openVnc(root, link);
  });
  root.querySelector(".incident-refresh")?.addEventListener("click", () => refresh(root));
  root.querySelector(".incident-hard-reload")?.addEventListener("click", async event => {
    const button=event.currentTarget;
    if(!globalThis.confirm("Recarregar sem cache todas as páginas do ChatGPT? Navegadores ocupados serão recarregados somente após terminarem a tarefa atual.")) return;
    button.disabled=true;
    text(button,"Recarregando…");
    try {
      const result=await api("hard_reload_browsers");
      const items=result.reload_results.flatMap(bridge=>bridge.slots||[]);
      const done=items.filter(item=>item.status==="reloaded").length;
      const queued=items.filter(item=>item.status==="queued").length;
      const failed=items.filter(item=>item.status==="error").length;
      const offline=result.reload_results.filter(bridge=>bridge.success===false).length;
      text(root.querySelector(".incident-runtime-text"), `${done} recarregado(s), ${queued} agendado(s), ${failed} falha(s), ${offline} ponte(s) desligada(s).`);
      if(failed) globalThis.alert(items.filter(item=>item.status==="error").map(item=>`${item.slot}: ${item.error}`).join("\n"));
    } catch(error) { text(root.querySelector(".incident-runtime-text"),error?.message||error); }
    finally { button.disabled=false; text(button,"Recarregar navegadores"); }
  });
  root.querySelector(".incident-clear")?.addEventListener("click", async () => {
    if (!globalThis.confirm("Apagar todas as auditorias concluídas e relatórios? Auditorias em execução precisam terminar antes.")) return;
    try {
      const result = await api("clear_all");
      render(root, result);
      if (result.preserved_active_audits) text(root.querySelector(".incident-runtime-text"), `${result.preserved_active_audits} auditoria(s) ainda em execução foram preservadas.`);
    }
    catch (error) { text(root.querySelector(".incident-runtime-text"), error?.message || error); }
  });
}

let pollTimer = null;

export default async function registerBrowserIncidentsSurface(surfaces) {
  installRecentChatOrdering();
  installCompletionIndicators();
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
