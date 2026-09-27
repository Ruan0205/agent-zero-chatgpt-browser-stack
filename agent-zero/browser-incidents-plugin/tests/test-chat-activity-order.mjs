import assert from 'node:assert/strict';
import test from 'node:test';
import { sortRowsByActivity } from '../webui/chat-activity-order.mjs';

const rows = [
  { id: 'old-pinned', created_at: '2026-01-01' },
  { id: 'recent', created_at: '2026-09-26' },
  { id: 'new-pinned', created_at: '2026-02-01' },
  { id: 'older', created_at: '2026-03-01' },
];

test('pinned chats stay above recent unpinned chats in pin order', () => {
  const result = sortRowsByActivity(rows, rows, { recent: 900, older: 800, 'old-pinned': 100 },
    { 'old-pinned': 1, 'new-pinned': 2 });
  assert.deepEqual(result.map(row => row.id), ['old-pinned', 'new-pinned', 'recent', 'older']);
});

test('unpinned chats continue to follow recent activity', () => {
  const result = sortRowsByActivity(rows, rows, { older: 1000, recent: 900 });
  assert.deepEqual(result.map(row => row.id), ['older', 'recent', 'new-pinned', 'old-pinned']);
});

test('unpinning restores activity order without stale priority', () => {
  const pinned = sortRowsByActivity(rows, rows, { recent: 900 }, { 'old-pinned': 1 });
  const unpinned = sortRowsByActivity(pinned, rows, { recent: 900 }, {});
  assert.equal(pinned[0].id, 'old-pinned');
  assert.equal(unpinned[0].id, 'recent');
});
