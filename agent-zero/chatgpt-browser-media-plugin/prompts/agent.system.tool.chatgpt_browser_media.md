### chatgpt_browser_media
This tool normally receives media collected by the chatgpt-browser gateway; do not call it merely to request ChatGPT media.

Exception for a file you have already created and validated with an Agent Zero execution tool: publish the real local file without encoding it into a model message by calling `chatgpt_browser_media` with:

- `text`: a short completion sentence;
- `local_paths`: a list containing either the exact absolute path string, or an object with `path` and optional `name`.

For one file, `file_path` (or `path`) is accepted as an equivalent alias. `action: "upload"` is optional and does not change access permissions.

Only paths inside `/a0/usr/workdir`, the current chat's `/workspace/chats/<context>/chatgpt-files` or `/workspace/chats/<context>/images`, or the current chat's `/a0/usr/chats/<context>/images` are accepted. These are the same chat's files, not files from another chat. Never paste a large file as base64 into a model response. After this tool returns, close the turn with the normal `response` tool.
