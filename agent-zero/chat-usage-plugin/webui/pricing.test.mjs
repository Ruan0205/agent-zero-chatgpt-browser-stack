import test from 'node:test';
import assert from 'node:assert/strict';

import { budgetPercent, DEFAULT_WEEKLY_TOKENS, TOKEN_REFERENCE_SCENARIO, elapsedMonths, tokenCostBrl, tokenQuotaPercent, usageCards, weeklyTokenReferences } from './pricing.mjs';

test('illustrative reference follows the declared workload and 1x/5x/20x ratios', () => {
  const scenario = TOKEN_REFERENCE_SCENARIO;
  assert.equal(scenario.messagesPerWindow * scenario.tokensPerMessage * scenario.windowsPerWeek, 7_700_000);
  assert.deepEqual(DEFAULT_WEEKLY_TOKENS, {100: 7_700_000, 500: 38_500_000, 1000: 154_000_000});
  assert.equal(tokenQuotaPercent(30_800_000, DEFAULT_WEEKLY_TOKENS[100]), 100);
  assert.equal(tokenQuotaPercent(308_000_000, DEFAULT_WEEKLY_TOKENS[500], 2), 100);
});

test('first visit gets estimates and old unconfigured zeros migrate without losing custom values', () => {
  assert.deepEqual(weeklyTokenReferences({}), DEFAULT_WEEKLY_TOKENS);
  assert.deepEqual(weeklyTokenReferences({100: 0, 500: 1234, 1000: 0}, {legacy: true}),
    {100: 7_700_000, 500: 1234, 1000: 154_000_000});
});

test('new saved references preserve explicit zero and reject invalid values', () => {
  assert.deepEqual(weeklyTokenReferences({100: 0, 500: -1, 1000: 'NaN'}),
    {100: 0, 500: 38_500_000, 1000: 154_000_000});
  assert.deepEqual(weeklyTokenReferences(null), DEFAULT_WEEKLY_TOKENS);
  assert.deepEqual(weeklyTokenReferences({100: null, 500: '', 1000: Infinity}), DEFAULT_WEEKLY_TOKENS);
});

test('token cost uses distinct input and output prices', () => {
  assert.equal(tokenCostBrl({ input: 1_000_000, output: 1_000_000 }, 3, 15, 5), 90);
  assert.equal(budgetPercent(90, 100), 90);
  assert.equal(budgetPercent(90, 0), 0);
});

test('weekly token reference is multiplied by four and by elapsed months', () => {
  assert.equal(tokenQuotaPercent(4000, 1000), 100);
  assert.equal(tokenQuotaPercent(8000, 1000, 2), 100);
  assert.equal(tokenQuotaPercent(1000, 0), null);
  assert.equal(elapsedMonths('2026-09', '2026-09'), 1);
  assert.equal(elapsedMonths('2026-09', '2026-10'), 2);
});

test('Kimi, Browser, and overall views remain distinct', () => {
  const cards = usageCards({
    kimi: { input: 1_000_000, output: 0, total: 1_000_000 },
    browser: { input: 0, output: 1_000_000, total: 1_000_000 },
    unattributed: { input: 500_000, output: 0, total: 500_000 },
    all: { input: 1_500_000, output: 1_000_000, total: 2_500_000 },
  }, { kimiInput: 3, kimiOutput: 15, browserInput: 5, browserOutput: 30, usdBrl: 5 });
  assert.deepEqual(cards.map(card => card.id), ['kimi', 'browser', 'all']);
  assert.deepEqual(cards.map(card => card.cost), [15, 150, 165]);
  assert.equal(cards[2].usage.total, 2_500_000);
  assert.equal(cards[2].costMin, 172.5);
  assert.equal(cards[2].costMax, 177.5);
});
