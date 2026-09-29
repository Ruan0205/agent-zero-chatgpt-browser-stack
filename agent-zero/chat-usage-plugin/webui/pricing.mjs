export const DEFAULT_PRICING = Object.freeze({
  usdBrl: 5.206,
  browserInput: 5,
  browserOutput: 30,
  kimiInput: 3,
  kimiOutput: 15,
});

export const BUDGETS_BRL = [100, 500, 1000];
// Illustrative workload, NOT a prediction of subscription entitlement.
// 55 local messages/window (midpoint of 10–100), 20k input+output/message,
// one active 5h window/day, seven days/week. Weekly caps are NOT inferred.
export const TOKEN_REFERENCE_SCENARIO = Object.freeze({
  messagesPerWindow: 55, tokensPerMessage: 20_000, windowsPerWeek: 7,
});
const baseWeekly = TOKEN_REFERENCE_SCENARIO.messagesPerWindow
  * TOKEN_REFERENCE_SCENARIO.tokensPerMessage * TOKEN_REFERENCE_SCENARIO.windowsPerWeek;
export const DEFAULT_WEEKLY_TOKENS = Object.freeze({ 100: baseWeekly, 500: baseWeekly * 5, 1000: baseWeekly * 20 });

export function weeklyTokenReferences(data, { legacy = false } = {}) {
  return Object.fromEntries(BUDGETS_BRL.map(budget => {
    const raw = data?.[budget];
    const value = Number(raw);
    const valid = raw !== null && raw !== '' && raw !== undefined
      && Number.isFinite(value) && (legacy ? value > 0 : value >= 0);
    return [budget, valid ? value : DEFAULT_WEEKLY_TOKENS[budget]];
  }));
}

export function nonnegative(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

export function tokenCostBrl(usage, inputUsdPerMillion, outputUsdPerMillion, usdBrl) {
  return ((nonnegative(usage?.input) * nonnegative(inputUsdPerMillion)
    + nonnegative(usage?.output) * nonnegative(outputUsdPerMillion)) / 1_000_000)
    * nonnegative(usdBrl);
}

export function budgetPercent(costBrl, budgetBrl) {
  const budget = nonnegative(budgetBrl);
  return budget > 0 ? (nonnegative(costBrl) / budget) * 100 : 0;
}

export function elapsedMonths(first, current) {
  if (!/^\d{4}-\d{2}$/.test(first || '') || !/^\d{4}-\d{2}$/.test(current || '')) return 1;
  const [firstYear, firstMonth] = first.split('-').map(Number);
  const [currentYear, currentMonth] = current.split('-').map(Number);
  return Math.max(1, (currentYear - firstYear) * 12 + currentMonth - firstMonth + 1);
}

export function tokenQuotaPercent(tokens, weeklyTokens, months = 1) {
  const quota = nonnegative(weeklyTokens) * 4 * Math.max(1, Math.floor(nonnegative(months)));
  return quota > 0 ? nonnegative(tokens) / quota * 100 : null;
}

export function usageCards(buckets, pricing) {
  const data = buckets || {};
  const browser = tokenCostBrl(data.browser, pricing.browserInput, pricing.browserOutput, pricing.usdBrl);
  const kimi = tokenCostBrl(data.kimi, pricing.kimiInput, pricing.kimiOutput, pricing.usdBrl);
  const unknownAsKimi = tokenCostBrl(data.unattributed, pricing.kimiInput, pricing.kimiOutput, pricing.usdBrl);
  const unknownAsBrowser = tokenCostBrl(data.unattributed, pricing.browserInput, pricing.browserOutput, pricing.usdBrl);
  const knownCost = kimi + browser;
  const hasRange = nonnegative(data.unattributed?.input) + nonnegative(data.unattributed?.output) > 0;
  return [
    { id: 'kimi', title: 'Kimi-K3', caption: 'Chamadas atribuídas ao Kimi', usage: data.kimi || {}, cost: kimi, costLabel: 'Equivalente API estimado' },
    { id: 'browser', title: 'ChatGPT Browser', caption: 'Tokens estimados da ponte', usage: data.browser || {}, cost: browser, costLabel: 'Equivalente API estimado' },
    { id: 'all', title: 'Uso geral', caption: 'Todos os chats · inclui histórico sem modelo', usage: data.all || {},
      cost: knownCost, costMin: knownCost + Math.min(unknownAsKimi, unknownAsBrowser),
      costMax: knownCost + Math.max(unknownAsKimi, unknownAsBrowser), hasRange,
      costLabel: hasRange ? 'Cenários hipotéticos de API' : 'Equivalente API estimado' },
  ];
}
