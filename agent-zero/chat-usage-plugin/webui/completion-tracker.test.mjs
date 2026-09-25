import assert from "node:assert/strict";
import { CompletionTracker } from "./completion-tracker.mjs";

const tracker = new CompletionTracker();
const snapshot = (context, logs, guid = "log-a") => ({ context, log_guid: guid, logs });
const response = (no, finished) => ({ no, type: "response", content: "Resposta", kvps: { finished } });

assert.equal(tracker.accept(snapshot("chat-a", [response(1, true)])), false, "history must be silent");
assert.equal(tracker.accept(snapshot("chat-a", [response(1, true)])), false, "replayed history must be silent");
assert.equal(tracker.accept(snapshot("chat-a", [response(2, false)])), false, "stream must be silent");
assert.equal(tracker.accept(snapshot("chat-a", [response(2, true)])), true, "final answer must notify");
assert.equal(tracker.accept(snapshot("chat-a", [response(2, true)])), false, "final answer must play once");
assert.equal(tracker.accept(snapshot("chat-b", [response(1, true)])), false, "switching chats must be silent");
assert.equal(tracker.accept(snapshot("chat-b", [response(2, true)])), true, "other chat's new answer must notify");
console.log("completion-tracker: OK");
