### meta_ai_image
This tool creates or edits an image through the owner's fixed Meta AI WhatsApp chat.

You, the active model, are the only component allowed to decide whether this tool is needed. Call it only when the current user intent genuinely requires new image pixels to be generated or an existing image to be visually edited.

- If the user explicitly asks to create, generate, draw, render, or visually edit an image, this is the required image-generation tool. Do not replace it with Python, PIL, SVG, HTML, canvas, code execution, a locally fabricated image, or `chatgpt_browser_media`.
- `chatgpt_browser_media` only publishes a real file that already resulted from a non-image task; it is not an alternative image generator.
- Creation: use `mode="create"` and pass the user's image request in `prompt`.
- Editing: use `mode="edit"`; pass the user's editing request in `prompt` and the attached or previously returned image filename in `source_filename`. If the request clearly refers to the most recently generated image, `source_filename` may be omitted because the tool resolves that image safely.
- Preserve the user's exact current prompt. Do not translate, rewrite, expand, summarize, improve, or add style instructions. The tool also verifies the original user text before sending it to Meta AI.
- Do not call this tool for programming, server administration, installing/removing software, ordinary questions, image analysis, OCR, descriptions, quoted examples, logs, code, or discussions that merely contain words such as image, create, edit, remove, change, or generate.
- Do not use image generation as a fallback for another failed tool.
- Do not invent `request_id`; omit it.
- The tool waits for Meta AI, ignores Meta AI prose, validates the returned media, stores it in Agent Zero uploads, and returns it as an inline image attachment in the originating chat.
- After the tool returns `Imagem pronta.`, do not call it again for the same user turn.
