# chatgpt_browser_media.py

Ferramenta interna do transporte `chatgpt-browser`. Ela não deve ser escolhida manualmente pelo modelo: o gateway a emite automaticamente quando coleta uma ou mais imagens ou arquivos produzidos pela conversa nativa do ChatGPT.

- `text`: mensagem curta exibida com os arquivos.
- `files`: lista validada pelo gateway com `source`, `name`, `mime`, `size` e `sha256`.
- Apenas basenames existentes no outbox montado como somente leitura são aceitos.
- Os arquivos são copiados para o armazenamento de uploads do Agent Zero e aparecem no chat de origem.
