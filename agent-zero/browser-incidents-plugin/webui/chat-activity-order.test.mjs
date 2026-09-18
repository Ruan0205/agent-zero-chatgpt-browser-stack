import test from "node:test";
import assert from "node:assert/strict";
import { pruneActivity, sortRowsByActivity } from "./chat-activity-order.mjs";

test("recently used chat moves to the top and remains there", () => {
  const rows = [
    { id: "new", created_at: "2026-09-17T12:00:00Z" },
    { id: "used", created_at: "2026-09-16T12:00:00Z" },
  ];
  assert.deepEqual(sortRowsByActivity(rows, rows, { used: 200, new: 100 }).map((row) => row.id), ["used", "new"]);
});

test("activity in a child chat moves its parent group to the top", () => {
  const parent = { id: "parent", created_at: "2026-09-15T12:00:00Z" };
  const other = { id: "other", created_at: "2026-09-17T12:00:00Z" };
  const child = { id: "child", parent_context_id: "parent" };
  assert.deepEqual(
    sortRowsByActivity([other, parent], [other, parent, child], { child: 300 }).map((row) => row.id),
    ["parent", "other"],
  );
});

test("deleted chats are removed from persistent activity", () => {
  assert.deepEqual(pruneActivity({ kept: 2, deleted: 1 }, [{ id: "kept" }]), { kept: 2 });
});
