from helpers.extension import Extension
from agent import LoopData
from extensions.python.message_loop_end._10_organize_history import (
    DATA_NAME_TASK,
    compress_history,
)
from helpers.defer import DeferredTask, THREAD_BACKGROUND
from helpers.history import Message, clear_responses_provider_state

MAX_SYNC_COMPRESSION_PASSES = 64
FALLBACK_KEEP_RECENT_MESSAGES = 12
FALLBACK_SUMMARY_CHAR_BUDGET = 12000
FALLBACK_ENTRY_CHAR_LIMIT = 240


class OrganizeHistoryWait(Extension):
    async def execute(self, loop_data: LoopData = LoopData(), **kwargs):
        if not self.agent:
            return

        # sync action only required if the history is too large, otherwise leave it in background
        passes = 0
        while self.agent.history.is_over_limit():
            passes += 1
            before_tokens = self.agent.history.get_tokens()

            # get task
            task: DeferredTask | None = self.agent.get_data(DATA_NAME_TASK)

            # Check if the task is already done
            if task:
                if not task.is_ready():
                    self.agent.context.log.set_progress("Compressing history...")

                # Wait for the task to complete
                compressed = bool(await task.result())

                # Clear the coroutine data after it's done
                self.agent.set_data(DATA_NAME_TASK, None)
            else:
                # no task was running, start and wait
                self.agent.context.log.set_progress("Compressing history...")
                compressed = await compress_history(self.agent)

            after_tokens = self.agent.history.get_tokens()
            if not compressed or after_tokens >= before_tokens:
                fallback_applied = self._apply_deterministic_fallback()
                fallback_tokens = self.agent.history.get_tokens()
                if fallback_applied and fallback_tokens < before_tokens:
                    self.agent.context.log.log(
                        type="info",
                        heading="History compacted with deterministic fallback",
                        content=(
                            "Model-based history compression did not reduce the "
                            f"prompt, so older turns were compacted locally. Tokens "
                            f"before: {before_tokens}; after: {fallback_tokens}."
                        ),
                    )
                    continue

                self._log_compression_stalled(before_tokens, fallback_tokens)
                break

            if passes >= MAX_SYNC_COMPRESSION_PASSES:
                self._log_compression_stalled(
                    before_tokens, after_tokens, max_passes=True
                )
                break

    def _apply_deterministic_fallback(self) -> bool:
        if not self.agent:
            return False

        history = self.agent.history
        required = ("all_messages", "bulks", "topics", "current")
        if any(not hasattr(history, attr) for attr in required):
            return False

        all_messages = list(history.all_messages())
        keep_count = min(FALLBACK_KEEP_RECENT_MESSAGES, len(all_messages))
        if len(all_messages) <= keep_count + 1:
            return False

        older = all_messages[:-keep_count]
        recent = all_messages[-keep_count:]
        lines = [
            "[Deterministic history fallback summary]",
            f"Compacted {len(older)} older messages; {len(recent)} recent messages remain verbatim.",
        ]
        used = sum(len(line) + 1 for line in lines)
        omitted = 0

        for message in older:
            try:
                text = " ".join(message.output_text().split())
            except Exception:
                text = "[unavailable message content]"
            role = "assistant" if getattr(message, "ai", False) else "user"
            sequence = int(getattr(message, "sequence", 0) or 0)
            excerpt = text[:FALLBACK_ENTRY_CHAR_LIMIT]
            line = f"{role}#{sequence}: {excerpt}"
            if used + len(line) + 1 > FALLBACK_SUMMARY_CHAR_BUDGET:
                omitted += 1
                continue
            lines.append(line)
            used += len(line) + 1

        if omitted:
            lines.append(
                f"[Omitted {omitted} additional older message excerpts due to summary budget.]"
            )

        first_sequence = int(getattr(older[0], "sequence", 0) or 0)
        summary = Message(
            ai=False,
            content="\n".join(lines),
            sequence=first_sequence,
        )
        history.bulks = []
        history.topics = []
        history.current.summary = ""
        history.current.messages = [summary, *recent]
        clear_responses_provider_state(self.agent)
        return True

    def _log_compression_stalled(
        self, before_tokens: int, after_tokens: int, max_passes: bool = False
    ) -> None:
        if not self.agent:
            return

        detail = (
            f"History compression stopped after {MAX_SYNC_COMPRESSION_PASSES} passes"
            if max_passes
            else "History compression could not reduce the prompt history further"
        )
        self.agent.context.log.log(
            type="warning",
            heading="History compression stalled",
            content=f"{detail}. Tokens before: {before_tokens}; after: {after_tokens}.",
        )
