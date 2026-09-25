import { CompletionTracker } from "/plugins/_chat_usage/webui/completion-tracker.mjs";
import { playFinalSound } from "/plugins/_chat_usage/webui/sound.mjs";

const tracker = new CompletionTracker();

export default function finalReplyNotification({ snapshot }) {
  if (tracker.accept(snapshot)) void playFinalSound();
}
