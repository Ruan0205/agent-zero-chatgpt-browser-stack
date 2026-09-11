# meta_ai_image.py

Ferramenta de geração e edição de imagens escolhida pelo modelo ativo.

- É exposta ao modelo como uma ferramenta normal; nenhum roteador por palavras-chave força sua execução.
- O modelo deve chamá-la somente quando interpretar que o pedido atual realmente exige criar ou editar pixels.
- Envia a descrição ao endpoint isolado da ponte WhatsApp.
- O endpoint só permite o contato fixo da Meta AI e não aceita um chat de destino.
- Aguarda a mídia, valida o caminho recebido, copia a imagem para `/a0/usr/uploads` e a anexa ao chat de origem.
- Chamadas diretas são aceitas sem `request_id`; o texto original do turno do usuário prevalece sobre qualquer reformulação do modelo.
- Imagens de edição só podem vir de diretórios internos permitidos e são copiadas para o volume compartilhado com um nome aleatório.
- Processa uma geração por vez para não associar respostas ao chat errado.
- Para edição sem `source_filename`, reutiliza somente a última imagem válida registrada naquele agente.
- O resultado inclui `attachments` e `media_paths`, permitindo pré-visualização inline no WebUI e transporte por integrações.
