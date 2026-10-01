# Imagens via ChatGPT Browser

Ferramenta `chatgpt_browser_image`: geração/edição nativa delegada por um modelo Featherless a um subagente Browser independente, seguido de validação e publicação no chat original. Usa os presets e autenticação existentes, sem credenciais próprias.

Pré-requisitos: preset com principal `chatgpt-browser`, ponte autenticada com geração de imagens disponível, Pillow e publicação `chatgpt_browser_media`. Mantém um filho exclusivo por chat no slot `browser_images`; não altera o modelo do pai, não reutiliza imagens de turnos anteriores e não delega recursivamente. Uma chamada simultânea no mesmo agente recebe aviso de operação já ativa. Pausa/intervenção do pai são respeitadas; a ponte continua responsável por estado de geração/rate limit, sem reenvios periódicos.

Arquivos de entrada só são aceitos nos uploads, workspace/dados deste chat ou workdir autorizado. Saídas precisam ser anexos publicados pelo filho no turno atual e passar por verificação/decodificação e hash antes e depois da cópia. A pasta do pai recebe a imagem em `images`, e o publicador existente cria o download e a cópia em `chatgpt-files`. Arquivos originais não são alterados.

Verificar descoberta da ferramenta, preset filho/afinidade, geração, edição com anexo, publicação/hash, entrada ausente, arquivo inválido, ausência de saída, não recursão e recuperação após intervenção. Desativar/remover o plugin remove apenas a ferramenta, não os arquivos entregues nem as conversas existentes.
