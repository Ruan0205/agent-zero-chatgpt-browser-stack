import { callJsonApi } from '/js/api.js';
import { BUDGETS_BRL, DEFAULT_PRICING, DEFAULT_WEEKLY_TOKENS, elapsedMonths, tokenQuotaPercent, usageCards, weeklyTokenReferences } from './pricing.mjs';

const STORAGE_KEY = 'a0-usage-budget-pricing-v1';
const WEEKLY_STORAGE_KEY = 'a0-usage-weekly-token-reference-v2';
const LEGACY_WEEKLY_STORAGE_KEY = 'a0-usage-weekly-token-reference-v1';

function savedPricing() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    return { ...DEFAULT_PRICING, ...Object.fromEntries(
      Object.entries(data).filter(([key, value]) => key in DEFAULT_PRICING && Number.isFinite(Number(value)) && Number(value) >= 0)
    ) };
  } catch {
    return { ...DEFAULT_PRICING };
  }
}

function savedWeeklyTokens() {
  try {
    const current = localStorage.getItem(WEEKLY_STORAGE_KEY);
    if (current !== null) return weeklyTokenReferences(JSON.parse(current));
    return weeklyTokenReferences(JSON.parse(localStorage.getItem(LEGACY_WEEKLY_STORAGE_KEY) || '{}'), { legacy: true });
  } catch {
    return { ...DEFAULT_WEEKLY_TOKENS };
  }
}

export function createUsageDashboard() {
  return {
    buckets: {},
    monthlyBuckets: {},
    period: '',
    trackedSince: '',
    inferredLegacyTokens: 0,
    chatsCounted: 0,
    unreadableChats: 0,
    loading: false,
    error: '',
    lastRefresh: 0,
    pricing: savedPricing(),
    weeklyTokens: savedWeeklyTokens(),
    budgets: BUDGETS_BRL,
    get monthsTracked() { return elapsedMonths(this.trackedSince, this.period); },
    get monthlyCards() { return usageCards(this.monthlyBuckets, this.pricing); },
    get lifetimeCards() { return usageCards(this.buckets, this.pricing); },
    get scopes() { return [
      { id: 'month', title: `Mês atual · ${this.periodLabel}`, subtitle: 'Zera automaticamente no dia 1º (horário de São Paulo)', cards: this.monthlyCards, months: 1 },
      { id: 'lifetime', title: 'Desde o início da contagem', subtitle: `${this.monthsTracked} mês(es) de referência · primeiro chat contabilizado em ${this.trackedSince || 'data desconhecida'}`, cards: this.lifetimeCards, months: this.monthsTracked },
    ]; },
    get periodLabel() {
      if (!/^\d{4}-\d{2}$/.test(this.period)) return 'Mês atual';
      const [year, month] = this.period.split('-').map(Number);
      return new Date(year, month - 1, 1).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    },
    get unattributed() { return this.buckets.unattributed || {}; },
    formatTokens(value) { return Number(value || 0).toLocaleString('pt-BR'); },
    formatMoney(value) { return Number(value || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); },
    formatPercent(value) { return `${value.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`; },
    quotaPercent(tokens, budget, months = 1) { return tokenQuotaPercent(tokens, this.weeklyTokens[budget], months); },
    quotaText(tokens, budget, months = 1) {
      const value = this.quotaPercent(tokens, budget, months);
      return value === null ? 'Definir' : this.formatPercent(value);
    },
    barWidth(tokens, budget, months = 1) {
      return `${Math.min(100, this.quotaPercent(tokens, budget, months) || 0)}%`;
    },
    quotaLabel(budget, months = 1) {
      const weekly = Number(this.weeklyTokens[budget] || 0);
      return weekly > 0 ? `≈ ${this.formatTokens(weekly * 4 * months)} tokens · referência ilustrativa` : 'Sem referência semanal configurada';
    },
    savePricing() { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.pricing)); },
    saveWeeklyTokens() {
      for (const budget of BUDGETS_BRL) {
        this.weeklyTokens[budget] = Math.max(0, Number(this.weeklyTokens[budget]) || 0);
      }
      localStorage.setItem(WEEKLY_STORAGE_KEY, JSON.stringify(this.weeklyTokens));
    },
    async refreshIfStale() {
      if (!this.loading && Date.now() - this.lastRefresh > 30_000) await this.refresh();
    },
    async refresh() {
      if (this.loading) return;
      this.loading = true;
      this.error = '';
      try {
        const result = await callJsonApi('/plugins/_chat_usage/usage_totals', {});
        if (!result?.buckets) throw new Error('Resumo de tokens indisponível');
        this.buckets = result.buckets;
        this.monthlyBuckets = result.monthly_buckets || {};
        this.period = result.period || '';
        this.trackedSince = result.tracked_since || '';
        this.inferredLegacyTokens = Number(result.inferred_legacy_tokens || 0);
        this.chatsCounted = Number(result.chats_counted || 0);
        this.unreadableChats = Number(result.unreadable_chats || 0);
        this.lastRefresh = Date.now();
      } catch (error) {
        this.error = String(error?.message || error);
      } finally {
        this.loading = false;
      }
    },
  };
}
