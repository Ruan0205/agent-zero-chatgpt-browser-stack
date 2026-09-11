"""Intercept response tool in WhatsApp sessions for attachments and break_loop."""

from helpers.extension import Extension
from helpers.print_style import PrintStyle
from helpers.tool import Response
from plugins._whatsapp_integration.helpers.handler import CTX_WA_CHAT_ID, CTX_WA_ATTACHMENTS, CTX_WA_REPLY_TO


CTX_WA_RESPONSE_OVERRIDE = "_wa_response_override"
CTX_WA_RESPONSE_OVERRIDE_SET = "_wa_response_override_set"


class WhatsAppResponseIntercept(Extension):

    async def execute(
        self, tool_name: str = "", response: Response | None = None, **kwargs,
    ):
        if not self.agent:
            return
        context = self.agent.context
        if not context.data.get(CTX_WA_CHAT_ID):
            return

        # Tools such as meta_ai_image return files through Response.additional
        # and finish the chain themselves. Preserve both the attachment and
        # this tool's own message; otherwise process_chain_end reuses a stale
        # response from the previous WhatsApp turn and silently loses the file.
        if response and isinstance(response.additional, dict):
            additional_attachments = response.additional.get("attachments", [])
            if isinstance(additional_attachments, list) and additional_attachments:
                context.data[CTX_WA_ATTACHMENTS] = additional_attachments
                # The tool needs a non-empty internal result so Agent Zero ends
                # the turn, but WhatsApp should receive only the image.
                context.data[CTX_WA_RESPONSE_OVERRIDE] = ""
                context.data[CTX_WA_RESPONSE_OVERRIDE_SET] = True

        if tool_name != "response":
            return

        tool = self.agent.loop_data.current_tool
        if not tool:
            return

        # Capture attachments and reply_to for later (process_chain_end) or inline send
        attachments = tool.args.get("attachments", [])
        if attachments:
            context.data[CTX_WA_ATTACHMENTS] = attachments
        reply_to = tool.args.get("reply_to", "")
        if reply_to:
            context.data[CTX_WA_REPLY_TO] = reply_to

        # Check break_loop arg from agent
        agent_break = tool.args.get("break_loop", True)
        if agent_break is False and response:
            await self._send_inline(context, tool, response)

    async def _send_inline(
        self, context, tool, response: Response,
    ):
        from plugins._whatsapp_integration.helpers.handler import send_wa_reply

        agent = self.agent
        assert agent is not None

        text = tool.args.get("text", tool.args.get("message", ""))
        attachments = context.data.pop(CTX_WA_ATTACHMENTS, [])
        reply_to = context.data.pop(CTX_WA_REPLY_TO, "")

        if attachments:
            PrintStyle.info(f"WhatsApp: sending update with {len(attachments)} attachment(s)")

        error = await send_wa_reply(context, text, attachments or None, reply_to=reply_to, keep_typing=True)

        if error:
            result = agent.read_prompt("fw.wa.update_error.md", error=error)
        else:
            result = agent.read_prompt("fw.wa.update_ok.md")

        # Override response: don't break loop, add result to history
        response.break_loop = False
        response.message = result
        agent.hist_add_tool_result("response", result)
