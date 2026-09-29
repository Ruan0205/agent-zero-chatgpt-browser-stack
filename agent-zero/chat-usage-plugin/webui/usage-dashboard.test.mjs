import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_WEEKLY_TOKENS } from './pricing.mjs';

// Exercise the production dashboard without a browser or authenticated API.
const source = readFileSync(new URL('./usage-dashboard.mjs', import.meta.url), 'utf8')
  .replace("import { callJsonApi } from '/js/api.js';", 'const callJsonApi = async () => ({});')
  .replace("from './pricing.mjs'", `from '${new URL('./pricing.mjs', import.meta.url).href}'`);
const { createUsageDashboard } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const key = 'a0-usage-weekly-token-reference-v2';
const oldKey = 'a0-usage-weekly-token-reference-v1';

function withStorage(values, run) {
  const previous = globalThis.localStorage;
  const data = new Map(Object.entries(values));
  globalThis.localStorage = {
    getItem: name => data.get(name) ?? null,
    setItem: (name, value) => data.set(name, value),
  };
  try { run(data); } finally { globalThis.localStorage = previous; }
}

test('dashboard starts with populated estimates and monthly percentages', () => withStorage({}, () => {
  const dashboard = createUsageDashboard();
  assert.deepEqual(dashboard.weeklyTokens, DEFAULT_WEEKLY_TOKENS);
  assert.equal(dashboard.quotaText(30_800_000, 100), '100%');
  assert.match(dashboard.quotaLabel(100), /30\.800\.000.*ilustrativa/);
}));

test('dashboard migrates old blank references, saves custom edits and reloads them', () => withStorage({
  [oldKey]: JSON.stringify({100: 0, 500: 1234, 1000: 0}),
}, data => {
  const dashboard = createUsageDashboard();
  assert.equal(dashboard.weeklyTokens[100], 7_700_000);
  assert.equal(dashboard.weeklyTokens[500], 1234);
  dashboard.weeklyTokens[100] = 42;
  dashboard.weeklyTokens[1000] = 0;
  dashboard.saveWeeklyTokens();
  assert.equal(JSON.parse(data.get(key))[100], 42);
  assert.equal(createUsageDashboard().weeklyTokens[100], 42);
  assert.equal(createUsageDashboard().quotaText(1, 1000), 'Definir');
}));

test('corrupt saved data falls back to estimates', () => withStorage({[key]: 'broken'}, () => {
  assert.deepEqual(createUsageDashboard().weeklyTokens, DEFAULT_WEEKLY_TOKENS);
}));

test('historical comparison scales by elapsed months without changing token counts', () => withStorage({}, () => {
  const dashboard = createUsageDashboard();
  dashboard.trackedSince = '2026-08';
  dashboard.period = '2026-09';
  dashboard.buckets = {all: {input: 50_000_000, output: 11_600_000, total: 61_600_000}};
  dashboard.monthlyBuckets = {all: {input: 25_000_000, output: 5_800_000, total: 30_800_000}};
  assert.equal(dashboard.scopes.length, 2);
  assert.equal(dashboard.monthsTracked, 2);
  assert.equal(dashboard.quotaText(dashboard.lifetimeCards[2].usage.total, 100, 2), '100%');
  assert.equal(dashboard.quotaText(dashboard.monthlyCards[2].usage.total, 100), '100%');
  assert.equal(dashboard.buckets.all.total, 61_600_000);
}));
