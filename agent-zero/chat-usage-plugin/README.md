# Uso de tokens

O painel inicial separa Kimi, ChatGPT Browser e total geral em mês atual e
histórico. A contabilização é independente das referências ilustrativas.

## Referência ilustrativa dos planos

Não existe conversão oficial das faixas de mensagens Work/Codex em quotas de
tokens semanais do ChatGPT Browser. O cenário padrão usa 55 mensagens locais
GPT-5.6 Sol por janela × 20.000 tokens de entrada + saída por mensagem × uma
janela ativa de 5h/dia × sete dias. Apenas a faixa de mensagens e as proporções
1×/5×/20× vêm da documentação; tokens por mensagem e ritmo são hipóteses.

Isso gera 7.700.000 / 38.500.000 / 154.000.000 tokens de referência por semana
para os rótulos R$100 / R$500 / R$1.000. O mês usa ×4; o histórico, ×4 × meses
calendário desde o primeiro chat contabilizado. Não representa franquia real,
saldo, previsão de bloqueio, nem limite de Kimi. Limites semanais independentes,
cache, raciocínio e modelo impedem inferir a capacidade real dessa fórmula.

Campos editáveis ficam no localStorage. A versão v2 preserva referências
positivas da v1, substitui os antigos zeros não configurados pelas estimativas,
e permite desabilitar uma referência com zero após a migração.

Fonte: https://learn.chatgpt.com/docs/pricing (consulta em 29/09/2026).
Verificação: `node --test webui/pricing.test.mjs webui/usage-dashboard.test.mjs`.
