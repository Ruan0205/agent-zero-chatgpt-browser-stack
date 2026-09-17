'use strict';

// This function runs inside page.evaluate. A user can discuss a 429 or quote
// an old error in the conversation, so neither body.innerText nor conversation
// turns are evidence that the *current* request was rejected by the provider.
function activeProviderRejection() {
  const selectors = [
    '[role="alert"]',
    '[aria-live="assertive"]',
    '[data-testid*="toast"]',
    '[class*="toast"]',
    '[data-testid*="banner"]',
    '[class*="banner"]',
  ];
  const pattern = /(?:The message you submitted was too long|Please edit it and resubmit|A mensagem[^\n]{0,120}(?:muito longa|grande demais)|Your request is too large|Messages limit reached|You(?:'|’)ve reached your (?:message|usage) limit|Limite de mensagens (?:atingido|alcançado)|Too many requests|temporarily limited access to your conversations)[^\n]*/i;
  const candidates = [...new Set(selectors.flatMap(selector => [...document.querySelectorAll(selector)]))];
  for (const element of candidates) {
    if (element.getBoundingClientRect().height <= 0) continue;
    if (element.closest('[data-testid^="conversation-turn-"], [data-message-author-role], #prompt-textarea, [contenteditable="true"]')) continue;
    // A broad page container can contain both a legitimate banner and a user
    // turn. Do not search through user text or the editable draft indirectly.
    if (element.querySelector?.('[data-testid^="conversation-turn-"], [data-message-author-role], #prompt-textarea, [contenteditable="true"]')) continue;
    const text = (element.innerText || element.textContent || '').trim();
    if (!text || text.length > 1000) continue;
    const match = text.match(pattern);
    if (match) return match[0].trim().slice(0, 500);
  }
  return '';
}

module.exports = { activeProviderRejection };
