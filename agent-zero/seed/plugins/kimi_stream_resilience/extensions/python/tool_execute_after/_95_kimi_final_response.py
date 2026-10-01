"""Publish the final response for atomic, non-streaming Kimi turns."""

from helpers.extension import Extension


class KimiFinalResponse(Extension):
    async def execute(self, response=None, tool_name="", **kwargs):
        if tool_name != "response" or not self.agent or response is None:
            return
        params = getattr(getattr(self.agent, "loop_data", None), "params_temporary", None)
        if not isinstance(params, dict) or not params.get("kimi_native_turn"):
            return
        if params.get("log_item_response") is not None:
            return
        message = getattr(response, "message", None)
        if not isinstance(message, str) or not message.strip():
            return
        generating = params.get("log_item_generating")
        if generating is not None:
            params["log_item_response"] = generating
            generating.update(
                type="response", heading="", content=message,
                finished=True, update_progress="none",
            )
        else:
            params["log_item_response"] = self.agent.context.log.log(
                type="response", heading="", content=message,
                finished=True, update_progress="none",
            )
